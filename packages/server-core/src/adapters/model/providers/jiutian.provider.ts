import { AppError, type ChatMessagePayload, type ChatOptions, type ChatResult, ErrorCode, type ModelProvider } from '@kh/shared';
import { buildBearerAuth } from '../../platform/signature.ts';

/** 对话接口路径 */
const CHAT_PATH = '/openapi/flames/api/v1/openai/chat';
/** 向量化接口路径。若平台实际路径不同，只改这一行 */
const EMBED_PATH = '/openapi/flames/api/v1/openai/embeddings';

export interface JiutianOptions {
  /** 形如 10.0.0.1:30000 */
  host: string;
  appId: string;
  appSecret: string;
  /** 授权凭证 ID（auth 头里的 modelId），与具体模型无关 */
  authModelId: string;
  modelSource: string;
  timeoutMs?: number;
}

/**
 * 聚智智能体平台 OpenAPI 适配器。
 *
 * 三个容易踩坑的点（写在这里省得以后重新查）：
 * 1. 签名字串里的 host 不带端口号，但请求地址要带端口
 * 2. auth 头里的 modelId 是「授权凭证 ID」，body 里的 model 才是「模型部署 ID」，两者不同
 * 3. 平台返回的是 SSE 流（chat.completion.chunk），不是普通 JSON
 */
export class JiutianProvider implements ModelProvider {
  readonly name = 'jiutian';
  private readonly opts: JiutianOptions;

  constructor(opts: JiutianOptions) {
    this.opts = opts;
  }

  private authHeader(path: string): string {
    return buildBearerAuth({
      host: this.opts.host,
      method: 'POST',
      path,
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      extra: {
        modelId: this.opts.authModelId,
        modelSource: this.opts.modelSource,
      },
    });
  }

  private headers(path: string): Record<string, string> {
    return {
      Authorization: this.authHeader(path),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
  }

  private url(path: string): string {
    return `http://${this.opts.host}${path}`;
  }

  /* ─────── 一次性返回 ─────── */

  async chat(messages: ChatMessagePayload[], opts: ChatOptions): Promise<ChatResult> {
    const started = Date.now();
    // 注意：这个平台不接受 body 里的 stream 字段（传了直接 406），响应始终是 SSE 流，
    // 所以这里不传 stream，拿到文本后按 SSE 聚合。
    const res = await this.request(
      CHAT_PATH,
      {
        model: opts.model,
        messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      },
      opts,
    );

    const text = await res.text();
    const aggregated = aggregateSse(text);
    if (aggregated) {
      return {
        content: aggregated,
        model: opts.model,
        elapsedMs: Date.now() - started,
      };
    }
    // 万一平台以后改成返回普通 JSON，这里仍能兜住
    const parsed = safeJson(text);
    if (parsed) {
      const content = extractContentFromJson(parsed);
      if (content) {
        return {
          content,
          model: opts.model,
          tokensIn: readNum(parsed, 'prompt_tokens'),
          tokensOut: readNum(parsed, 'completion_tokens'),
          elapsedMs: Date.now() - started,
        };
      }
    }
    throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
      message: describePlatformError(text),
      detail: text.slice(0, 500),
      expose: true,
    });
  }

  /* ─────── 流式返回 ─────── */

  async *chatStream(messages: ChatMessagePayload[], opts: ChatOptions): AsyncGenerator<string, void, unknown> {
    const res = await this.request(
      CHAT_PATH,
      {
        model: opts.model,
        messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      },
      opts,
    );

    if (!res.body) throw new AppError(ErrorCode.MODEL_UNAVAILABLE);

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let emitted = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分隔事件
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');

          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;

          const obj = safeJson(payload);
          if (!obj) continue;

          // 平台侧异常会以 10118 之类的错误码混在流里返回，需要显式识别
          const platformErr = readPlatformError(obj);
          if (platformErr)
            throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
              message: platformErr,
            });

          const piece = extractDelta(obj);
          if (piece) {
            emitted = true;
            yield piece;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!emitted) {
      // 流结束但一个字都没产出，说明平台侧异常或模型返回空
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
        message: '模型未返回任何内容，请稍后重试',
      });
    }
  }

  /* ─────── 向量化 ─────── */

  async embed(texts: string[], opts: { model: string; timeoutMs?: number }): Promise<number[][]> {
    const res = await this.request(
      EMBED_PATH,
      { model: opts.model, input: texts },
      {
        timeoutMs: opts.timeoutMs,
      },
    );
    const text = await res.text();
    const parsed = safeJson(text);
    const data = parsed && Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: { embedding: number[] }[] }).data : null;
    if (!data) {
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
        message: '向量化失败，请检查平台是否开放 embedding 接口',
        detail: text.slice(0, 300),
      });
    }
    return data.map((d) => d.embedding);
  }

  /* ─────── 健康探测 ─────── */

  /**
   * 健康探测。
   *
   * 这里有一处细节值得说明：**不能只看 HTTP 状态码**。
   * 平台在模型后端异常时仍会返回 200，然后把错误码（如 10118）写在 SSE 流里。
   * 早期就是因为只看状态码，导致界面显示「通道正常」而实际不可用。
   * 所以这里会读一小段流，识别平台级错误码。
   */
  async health(opts: { model: string; timeoutMs?: number }): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const started = Date.now();
    try {
      const res = await this.request(
        CHAT_PATH,
        {
          model: opts.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
        },
        { timeoutMs: opts.timeoutMs ?? 20_000 },
      );

      if (!res.ok) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: `HTTP ${res.status}`,
        };
      }
      if (!res.body) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: '响应没有内容',
        };
      }

      // 读一小段流做判定：拿到平台错误码 → 不可用；拿到任意内容 → 可用
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let sawContent = false;
      let platformError: string | null = null;

      try {
        for (let i = 0; i < 20; i++) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx = buffer.indexOf('\n');
          while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf('\n');
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            const obj = safeJson(payload);
            if (!obj) continue;

            platformError = readPlatformError(obj);
            if (platformError) break;
            if (extractDelta(obj)) {
              sawContent = true;
              break;
            }
          }
          if (platformError || sawContent) break;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }

      if (platformError) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: platformError,
        };
      }
      // 能建连且没有平台错误码，视为通道可用（模型可能只是还没吐字）
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: (err as Error).message,
      };
    }
  }

  /* ─────── 内部 ─────── */

  private async request(path: string, body: unknown, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(this.url(path), {
        method: 'POST',
        headers: this.headers(path),
        body: JSON.stringify(body),
        signal: opts.signal ?? controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
          message: `模型服务返回 HTTP ${res.status}`,
          detail: text.slice(0, 300),
        });
      }
      return res;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new AppError(ErrorCode.MODEL_TIMEOUT, {
          message: `模型响应超时（${Math.round(timeoutMs / 1000)} 秒）`,
        });
      }
      if (AppError.isAppError(err)) throw err;
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
        message: '无法连接模型服务',
        detail: (err as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ═══════════════ 响应解析辅助 ═══════════════ */

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 从标准 OpenAI 结构或平台自定义结构中取出正文 */
function extractContentFromJson(obj: Record<string, unknown>): string {
  const choices = obj.choices as
    | {
        message?: { content?: string };
        delta?: { content?: string };
        text?: string;
      }[]
    | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const c = choices[0];
    return c?.message?.content ?? c?.delta?.content ?? c?.text ?? '';
  }
  if (typeof obj.content === 'string') return obj.content;
  return '';
}

function extractDelta(obj: Record<string, unknown>): string {
  return extractContentFromJson(obj);
}

/** 平台把错误码塞在正常响应里返回（如 10118 表示 API Key 无权访问该模型） */
function readPlatformError(obj: Record<string, unknown>): string | null {
  const code = obj.code ?? obj.error_code ?? (obj.error as { code?: unknown } | undefined)?.code;
  if (code === undefined || code === null || code === 0 || code === '0') return null;
  const msg = obj.message ?? obj.msg ?? (obj.error as { message?: unknown } | undefined)?.message ?? String(code);
  return `模型服务返回错误（${String(code)}）：${String(msg)}`;
}

function readNum(obj: Record<string, unknown>, key: string): number | undefined {
  const usage = obj.usage as Record<string, unknown> | undefined;
  const v = usage?.[key];
  return typeof v === 'number' ? v : undefined;
}

/** 把 SSE 文本整体聚合成一段回答 */
export function aggregateSse(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const obj = safeJson(payload);
    if (!obj) continue;
    const piece = extractDelta(obj);
    if (piece) out.push(piece);
  }
  return out.join('');
}

/** 把平台返回的错误文本转成用户能看懂的提示 */
export function describePlatformError(text: string): string {
  if (text.includes('10118')) {
    return '该 API Key 无权访问所选模型，请在管理后台核对模型授权';
  }
  if (text.includes('Unexpected end of file') || text.includes('EOF')) {
    return '模型服务连接被中断，请稍后重试';
  }
  return '模型服务暂时不可用，请稍后重试';
}
