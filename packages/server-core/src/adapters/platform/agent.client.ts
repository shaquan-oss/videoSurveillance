/**
 * 远程智能体客户端 —— 转发问题到聚智平台，由平台原生智能体做 RAG + 生成。
 *
 * 设计要点：
 * 1. 协议：POST /openapi/flames/api/v1/chat，URL 拼 `assistantCode` 查询参数。
 *    鉴权仍走 hmac-sha256，与模型调用共用 buildBearerAuth（extra 里塞 assistantCode）。
 * 2. 响应是 SSE 流；事件类型至少有：delta（输出片段）/ reference（引用来源）/ recommend（追问建议）/
 *    progress（执行进度，含技能/知识库检索过程）。本客户端只解析，业务方按 type 自己分发。
 * 3. 多轮上下文：第一次调用从请求里拿 platformSessionId 字段；响应里也会回带，存到
 *    conversations.platformSessionId，下次会话再传回去。
 * 4. 错误归一：把平台 HTTP 4xx/5xx 与 SSE 里的错误码（10118 之类）统一抛 PlatformAgentError，
 *    让上层 service 转成 AppError(MODEL_UNAVAILABLE) 或 PLATFORM_AGENT_UNAVAILABLE。
 *
 * 仍未联调：assistant/knowledge/document 三条 path 是按手册草稿写的，会在阶段 0 用 probe 脚本验证。
 */
import { buildBearerAuth } from './signature.ts';
import {
  RateLimiter,
  platformFetch,
  PlatformHttpError,
  PlatformNetworkError,
  PlatformTimeoutError,
} from './http.ts';

/** 路径保持可配置，平台调整时只改这里 */
const CHAT_PATH = '/openapi/flames/api/v1/chat';

export interface PlatformAgentOptions {
  host: string;
  appId: string;
  appSecret: string;
  /** 单次请求超时。远程智能体可能比纯 LLM 慢，因为还要做 RAG */
  timeoutMs?: number;
}

export interface PlatformChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlatformChatRequest {
  /** 聚智平台上的 assistant code，URL 上的 assistantCode 即此 */
  assistantCode: string;
  messages: PlatformChatMessage[];
  /** 多轮会话 context id；首次调用传 undefined */
  platformSessionId?: string;
  /** 由上游控制是否携带额外检索 query 提示 */
  extra?: Record<string, unknown>;
}

export type PlatformAgentEvent =
  | { type: 'delta'; content: string }
  | { type: 'reference'; items: PlatformReference[] }
  | { type: 'recommend'; questions: string[] }
  | { type: 'progress'; step: string; detail?: unknown }
  | { type: 'session'; platformSessionId: string }
  | { type: 'done' };

export interface PlatformReference {
  /** 平台返回的引用 id，对应一个切片或一份文档 */
  id: string;
  /** 来源标识（文件名 / url / 知识库内路径） */
  source?: string;
  /** 引用的原文片段 */
  snippet?: string;
  /** 可选：所在文档/分块 id */
  docId?: string;
  page?: number;
}

export class PlatformAgentError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'PlatformAgentError';
    this.code = code;
    this.status = status;
  }
}

export class PlatformAgentClient {
  private readonly opts: PlatformAgentOptions;
  /** 智能体对话限速比文档上传宽松，但同样遵守 QPS≤10/分钟 → 间隔 6500ms */
  private readonly limiter = new RateLimiter(6_500);

  constructor(opts: PlatformAgentOptions) {
    this.opts = opts;
  }

  /**
   * 流式调用。外部用 `for await` 消费事件，做完 done 时正常退出，
   * 遇到 error/timeout 时抛出 PlatformAgentError。
   */
  async *chatStream(req: PlatformChatRequest): AsyncGenerator<PlatformAgentEvent, void, unknown> {
    const path = `${CHAT_PATH}?assistantCode=${encodeURIComponent(req.assistantCode)}`;
    const url = `http://${this.opts.host}${path}`;
    const headers = {
      Authorization: buildBearerAuth({
        host: this.opts.host,
        method: 'POST',
        path,
        appId: this.opts.appId,
        appSecret: this.opts.appSecret,
        extra: { assistantCode: req.assistantCode },
      }),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    await this.limiter.acquire();

    let res: Response;
    try {
      res = await platformFetch(url, {
        headers,
        body: JSON.stringify({
          messages: req.messages,
          ...(req.platformSessionId ? { sessionId: req.platformSessionId } : {}),
          ...(req.extra ?? {}),
        }),
        timeoutMs: this.opts.timeoutMs ?? 120_000,
      });
    } catch (err) {
      throw mapToAgentError(err);
    }

    if (!res.body) {
      throw new PlatformAgentError('no_body', '平台响应没有内容流');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawAny = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');

          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') {
            yield { type: 'done' };
            return;
          }

          const evt = parseAgentEvent(payload);
          if (!evt) continue;
          sawAny = true;
          if (evt.type === 'error') {
            throw new PlatformAgentError(evt.code, evt.message);
          }
          yield evt;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!sawAny) {
      throw new PlatformAgentError('empty_stream', '平台智能体未返回任何内容');
    }
    yield { type: 'done' };
  }
}

/* ──────────── 平台事件解析（草稿：阶段 0 probe 校准） ──────────── */

/**
 * 把一帧 SSE data 字符串解析成统一事件。
 * 协议字段名是按手册草稿写的，待 probe 真实跑通后定稿。
 */
function parseAgentEvent(raw: string): PlatformAgentEvent | null | { type: 'error'; code: string; message: string } {
  const obj = safeJson(raw);
  if (!obj) return null;

  // 平台错误码（10118 / 其它），与 jiutian provider 同款识别规则
  const errCode = obj.code ?? obj.error_code ?? (obj.error as { code?: unknown } | undefined)?.code;
  if (errCode !== undefined && errCode !== null && errCode !== 0 && errCode !== '0') {
    const msg = obj.message ?? obj.msg ?? (obj.error as { message?: unknown } | undefined)?.message ?? String(errCode);
    return { type: 'error', code: String(errCode), message: String(msg) };
  }

  // type 字段若存在，按平台协议路由；否则按结构猜
  const typeField = (obj.type ?? obj.event) as string | undefined;

  // 增量内容
  if (typeField === 'delta' || typeField === 'message') {
    return { type: 'delta', content: extractContent(obj) };
  }
  // 推理/检索进度
  if (typeField === 'progress' || typeField === 'status') {
    return { type: 'progress', step: String(obj.step ?? obj.message ?? ''), detail: obj.detail ?? obj.payload };
  }
  // 引用
  if (typeField === 'reference' || obj.references !== undefined) {
    return { type: 'reference', items: normalizeReferences(obj.references ?? obj.reference) };
  }
  // 追问建议
  if (typeField === 'recommend' || obj.recommend !== undefined) {
    return { type: 'recommend', questions: toStringArray(obj.recommend ?? obj.recommends ?? obj.follow_up) };
  }
  // session id 回传
  if (obj.sessionId || obj.session_id) {
    return { type: 'session', platformSessionId: String(obj.sessionId ?? obj.session_id) };
  }
  // 默认：当作 delta
  const content = extractContent(obj);
  if (content) return { type: 'delta', content };
  return null;
}

function extractContent(obj: Record<string, unknown>): string {
  if (typeof obj.content === 'string') return obj.content;
  const choices = obj.choices as { delta?: { content?: string }; message?: { content?: string } }[] | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const c = choices[0];
    return c?.delta?.content ?? c?.message?.content ?? '';
  }
  return '';
}

function normalizeReferences(raw: unknown): PlatformReference[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): PlatformReference | null => {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      const source = typeof o.source === 'string' ? o.source : typeof o.title === 'string' ? o.title : typeof o.file_name === 'string' ? o.file_name : undefined;
      const snippet = typeof o.snippet === 'string' ? o.snippet : typeof o.content === 'string' ? o.content : typeof o.text === 'string' ? o.text : undefined;
      const docId = typeof o.docId === 'string' ? o.docId : typeof o.doc_id === 'string' ? o.doc_id : undefined;
      return {
        id: String(o.id ?? o.doc_id ?? o.docId ?? ''),
        source,
        snippet,
        docId,
        page: typeof o.page === 'number' ? o.page : undefined,
      };
    })
    .filter((x): x is PlatformReference => !!x);
}

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') return raw.split(/[\n；;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function mapToAgentError(err: unknown): PlatformAgentError {
  if (err instanceof PlatformAgentError) return err;
  if (err instanceof PlatformHttpError) {
    return new PlatformAgentError('http', `${err.message}：${err.body.slice(0, 200)}`, err.status);
  }
  if (err instanceof PlatformTimeoutError) return new PlatformAgentError('timeout', err.message);
  if (err instanceof PlatformNetworkError) return new PlatformAgentError('network', err.message);
  return new PlatformAgentError('unknown', (err as Error).message);
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
