import {
  AppError,
  type ChatMessagePayload,
  type ChatOptions,
  type ChatResult,
  ErrorCode,
  type ModelHealth,
  type ModelInfo,
  type ModelProvider,
} from '@kh/shared';
import { hashEmbedding } from '../../utils/hash-embedding.ts';
import { JiutianProvider } from './providers/jiutian.provider.ts';

/** 向量模型降级后多久再试一次：平台或 VPN 恢复后不该一直用兜底向量 */
const EMBED_RETRY_MS = 5 * 60_000;

/**
 * 模型网关 —— 统一入口。
 *
 * 它承担四件事，这也是「不让平台一抖整个系统停摆」的保险：
 * 1. 模型注册表：界面上的模型下拉、可用状态都来自这里
 * 2. 健康探测与熔断：连续失败 N 次的模型暂时摘掉，不再往上撞
 * 3. 失败降级：首选模型不可用时自动切备用，并把切换事实告诉调用方
 * 4. 用量记账：供管理后台的「用量与健康」页统计
 */
export class ModelGateway {
  private readonly provider: ModelProvider;
  private readonly models: ModelInfo[];
  private readonly health = new Map<string, ModelHealth>();
  private readonly circuitFails: number;

  constructor(options: {
    provider: ModelProvider;
    models: ModelInfo[];
    circuitFails?: number;
  }) {
    this.provider = options.provider;
    this.models = options.models;
    this.circuitFails = options.circuitFails ?? 3;
  }

  list(): ModelInfo[] {
    return this.models.map((m) => ({ ...m, health: this.health.get(m.key) }));
  }

  get(key: string): ModelInfo | undefined {
    return this.models.find((m) => m.key === key);
  }

  getDefaultChatModel(): ModelInfo {
    const enabled = this.models.filter((m) => m.isEnabled && m.capabilities.includes('chat'));
    if (enabled.length === 0) throw new AppError(ErrorCode.ALL_MODELS_DOWN);
    // 优先选未被熔断的
    return enabled.find((m) => !this.isCircuitOpen(m.key)) ?? enabled[0]!;
  }

  private isCircuitOpen(key: string): boolean {
    const h = this.health.get(key);
    return !!h && !h.ok && (h.consecutiveFails ?? 0) >= this.circuitFails;
  }

  private recordSuccess(key: string, latencyMs: number): void {
    this.health.set(key, {
      ok: true,
      latencyMs,
      checkedAt: new Date().toISOString(),
      consecutiveFails: 0,
    });
  }

  private recordFailure(key: string, message: string, latencyMs: number): void {
    const prev = this.health.get(key);
    const fails = (prev?.consecutiveFails ?? 0) + 1;
    this.health.set(key, {
      ok: false,
      latencyMs,
      checkedAt: new Date().toISOString(),
      message,
      consecutiveFails: fails,
    });
  }

  /** 主动探测所有启用的模型（管理后台的「模型清单」页会调） */
  async probeAll(timeoutMs = 20_000): Promise<ModelInfo[]> {
    await Promise.all(
      this.models
        .filter((m) => m.isEnabled && m.capabilities.includes('chat'))
        .map(async (m) => {
          const r = await this.provider.health({
            model: m.deploymentId,
            timeoutMs,
          });
          if (r.ok) this.recordSuccess(m.key, r.latencyMs);
          else this.recordFailure(m.key, r.message ?? '探测失败', r.latencyMs);
        }),
    );
    return this.list();
  }

  /**
   * 流式对话，带失败降级。
   * 返回 AsyncGenerator 的第一项是 { modelKey, degraded }，调用方据此提示用户「已切换模型」。
   */
  async *chatStream(
    messages: ChatMessagePayload[],
    options?: {
      modelKey?: string;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<{ type: 'meta'; modelKey: string; degraded: boolean } | { type: 'delta'; text: string }, void, unknown> {
    const preferred = options?.modelKey ? this.get(options.modelKey) : this.getDefaultChatModel();
    const fallbacks = this.models.filter(
      (m) => m.isEnabled && m.capabilities.includes('chat') && m.key !== preferred?.key && !this.isCircuitOpen(m.key),
    );

    const candidates = [preferred, ...fallbacks].filter((m): m is ModelInfo => !!m);
    if (candidates.length === 0) throw new AppError(ErrorCode.ALL_MODELS_DOWN);

    let lastError: unknown = null;

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i]!;
      const started = Date.now();
      try {
        let emitted = false;
        for await (const piece of this.provider.chatStream(messages, {
          model: model.deploymentId,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
          timeoutMs: options?.timeoutMs,
          signal: options?.signal,
        })) {
          if (!emitted) {
            // 首字成功产出才算这次调用有效，避免把「连接上了但模型不吐字」当成成功
            this.recordSuccess(model.key, Date.now() - started);
            yield { type: 'meta', modelKey: model.key, degraded: i > 0 };
            emitted = true;
          }
          yield { type: 'delta', text: piece };
        }
        if (!emitted)
          throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
            message: '模型未返回内容',
          });
        return;
      } catch (err) {
        lastError = err;
        this.recordFailure(model.key, (err as Error).message, Date.now() - started);
        // 用户主动取消时不要继续降级重试
        if ((err as Error).name === 'AbortError') throw err;
      }
    }

    throw AppError.isAppError(lastError)
      ? lastError
      : new AppError(ErrorCode.ALL_MODELS_DOWN, {
          detail: (lastError as Error)?.message,
        });
  }

  /**
   * 一次性返回。
   * 直接基于 chatStream 聚合，好处是降级/熔断/首字判定只有一份实现，
   * 不会出现「流式会降级、非流式不降级」这种两边行为不一致的问题。
   */
  async chat(
    messages: ChatMessagePayload[],
    options?: { modelKey?: string; temperature?: number; maxTokens?: number },
  ): Promise<ChatResult> {
    const started = Date.now();
    let content = '';
    let model = '';
    let degraded = false;

    for await (const ev of this.chatStream(messages, options)) {
      if (ev.type === 'meta') {
        model = ev.modelKey;
        degraded = ev.degraded;
      } else {
        content += ev.text;
      }
    }

    return { content, model, degraded, elapsedMs: Date.now() - started };
  }

  /**
   * 向量化：优先走外部向量模型，不可用时降级到本地哈希向量，保证检索链路不断。
   *
   * 降级不是永久的 —— 冷却结束后会再试一次。早期这里是「失败一次就永远不再尝试」，
   * 于是平台或 VPN 恢复后系统仍在用兜底向量，只能靠重启服务恢复。
   */
  async embed(texts: string[], modelKey?: string): Promise<number[][]> {
    const model = modelKey ? this.get(modelKey) : this.models.find((m) => m.isEnabled && m.capabilities.includes('embed'));

    if (model && this.shouldTryRemoteEmbed()) {
      try {
        const vectors = await this.provider.embed(texts, {
          model: model.deploymentId,
        });
        this.markEmbedUp();
        return vectors;
      } catch (err) {
        this.markEmbedDown((err as Error).message);
      }
    }
    return texts.map((t) => hashEmbedding(t));
  }

  /** 冷却期内直接返回兜底向量，避免每次检索都白等一次超时 */
  private shouldTryRemoteEmbed(): boolean {
    return this.embedDownSince === null || Date.now() - this.embedDownSince >= EMBED_RETRY_MS;
  }

  private markEmbedDown(reason: string): void {
    const justDown = this.embedDownSince === null;
    this.embedDownSince = Date.now();
    this.embedFailReason = reason;
    // 只在状态翻转时打日志：冷却期每次重试失败都打会把日志刷满
    if (justDown) {
      console.warn(`[ModelGateway] 向量模型不可用（${reason}），暂时只用关键词检索，${EMBED_RETRY_MS / 60_000} 分钟后自动重试`);
    }
  }

  private markEmbedUp(): void {
    if (this.embedDownSince !== null) console.log('[ModelGateway] 向量模型已恢复，重新启用向量检索');
    this.embedDownSince = null;
    this.embedFailReason = null;
  }

  /** 向量模型是否正在降级（降级期间检索只用关键词，不查向量） */
  isEmbedDegraded(): boolean {
    return this.embedDownSince !== null;
  }

  /** 向量模型现状，供管理后台说明「检索为什么变弱了」 */
  embedStatus(): { degraded: boolean; reason?: string; since?: string } {
    if (this.embedDownSince === null) return { degraded: false };
    return {
      degraded: true,
      reason: this.embedFailReason ?? undefined,
      since: new Date(this.embedDownSince).toISOString(),
    };
  }

  private embedDownSince: number | null = null;
  private embedFailReason: string | null = null;

  /** 供管理后台「用量与健康」使用的健康快照 */
  healthSnapshot(): {
    key: string;
    displayName: string;
    health?: ModelHealth;
  }[] {
    return this.models.map((m) => ({
      key: m.key,
      displayName: m.displayName,
      health: this.health.get(m.key),
    }));
  }
}

/* ═══════════════ 从环境变量装配 ═══════════════ */

/**
 * 模型注册表格式（.env 的 MODEL_REGISTRY）：
 *   显示名:部署ID,显示名:部署ID
 * 例如：九天 75B:jiutian_75b_sort20251225112916,九天蓝 35B:jiutian-lan-35b_sort20260630093127
 */
export function parseModelRegistry(raw: string | undefined): ModelInfo[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, idx) => {
      const [displayName, deploymentId] = item.includes(':') ? item.split(':') : [item, item];
      const isEmbed = /emb|embedding/i.test(item);
      return {
        key: `m${idx + 1}_${slugify(deploymentId ?? item)}`,
        displayName: (displayName ?? item).trim(),
        deploymentId: (deploymentId ?? item).trim(),
        provider: 'jiutian' as const,
        capabilities: (isEmbed ? ['embed'] : ['chat', 'long-context']) as ModelInfo['capabilities'],
        isEnabled: true,
      };
    });
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24);
}

export function createModelGatewayFromEnv(): ModelGateway {
  const host = process.env.JIUTIAN_HOST;
  const appId = process.env.JIUTIAN_APP_ID;
  const appSecret = process.env.JIUTIAN_APP_SECRET;
  const authModelId = process.env.JIUTIAN_MODEL_ID;
  if (!host || !appId || !appSecret || !authModelId) {
    throw new Error('缺少聚智平台凭证：JIUTIAN_HOST / JIUTIAN_APP_ID / JIUTIAN_APP_SECRET / JIUTIAN_MODEL_ID');
  }

  const chatModels = parseModelRegistry(process.env.MODEL_REGISTRY);
  const embedModelId = process.env.JIUTIAN_EMBED_MODEL;
  const embedModels: ModelInfo[] = embedModelId
    ? [
        {
          key: 'embed_default',
          displayName: '向量模型',
          deploymentId: embedModelId,
          provider: 'jiutian',
          capabilities: ['embed'],
          isEnabled: true,
        },
      ]
    : [];

  const provider = new JiutianProvider({
    host,
    appId,
    appSecret,
    authModelId,
    modelSource: process.env.JIUTIAN_MODEL_SOURCE ?? 'public',
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS ?? '60000'),
  });

  return new ModelGateway({
    provider,
    models: [...chatModels, ...embedModels],
    circuitFails: Number(process.env.MODEL_CIRCUIT_FAILS ?? '3'),
  });
}
