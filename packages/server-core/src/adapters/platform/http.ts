/**
 * 平台接口共用的 HTTP 调用 + 限速 + 错误处理。
 *
 * 抽出来的两件事：
 *   1. fetchWithTimeout — 给所有调用方一份统一的超时 / abort / 错误转译
 *   2. RateLimiter     — 平台 QPS ≤ 10/分钟、并发 ≤ 10（手册），最保守写：每 6 秒打一个
 *
 * 这里不依赖 fetch 之外的运行时（不引 logger / 不引 AppError 的 isAppError 检测可以走 duck-typing），
 * 保证各 client 只关心业务字段。
 */
/**
 * fetch body 的宽容类型：
 * - Node 22 的 fetch 不带 DOM，全局没有 BodyInit，浏览器 fetch 才有
 * - 我们这里大多用 `string` / `Buffer` / `FormData` 三种，所以用一个不挑的 union 也够
 */
export type HttpBody = string | Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams | null;

export interface PlatformFetchOptions {
  method?: 'GET' | 'POST';
  /** 可选。multipart 上传时不要传 —— 让 fetch 自己补 Content-Type + boundary */
  headers?: Record<string, string>;
  body?: HttpBody;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class PlatformHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`平台接口 HTTP ${status}`);
    this.name = 'PlatformHttpError';
    this.status = status;
    this.body = body;
  }
}

export class PlatformTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`平台接口响应超时（${Math.round(timeoutMs / 1000)} 秒）`);
    this.name = 'PlatformTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class PlatformNetworkError extends Error {
  constructor(detail: string) {
    super(`无法连接平台服务（${detail}）`);
    this.name = 'PlatformNetworkError';
  }
}

/**
 * 调一次平台 HTTP。如果 status 不是 2xx，抛 PlatformHttpError 并把响应体附上去。
 * 上层 client 自己决定怎么把这类错误转成业务可读的 AppError。
 */
export async function platformFetch(url: string, opts: PlatformFetchOptions): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal ?? controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PlatformHttpError(res.status, text.slice(0, 2_000));
    }
    return res;
  } catch (err) {
    if (err instanceof PlatformHttpError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new PlatformTimeoutError(timeoutMs);
    }
    throw new PlatformNetworkError((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 令牌桶限速器：按每 `intervalMs` 至多放行 `capacity` 个请求。
 * - 用 promise 队列做串行化：上游不用 await，也能保证「1s 内只发 N 个」
 * - 每次 acquire 都会被阻塞到下一时刻
 *
 * 平台手册说 QPS≤10/分钟 ≈ 6s 一个。容量也按 1 处理，留点余量也别触限。
 * 上传知识库文档用容量 = 2 比较舒服；对话接口按需自取。
 */
export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private last = 0;

  constructor(
    /** 两次放行间隔（毫秒）。QPS≤10/分钟 → 至少 6000ms；建议 6500 留 8% 余量 */
    private readonly intervalMs: number,
  ) {}

  /**
   * 等待一次放行。返回值是 Promise，无内容。
   * 用法：`await limiter.acquire()`
   */
  acquire(): Promise<void> {
    const next = async () => {
      const now = Date.now();
      const wait = Math.max(0, this.last + this.intervalMs - now);
      if (wait > 0) {
        await sleep(wait);
      }
      this.last = Date.now();
    };
    // 串行化：下一个 next 等上一个完成才开始
    const prev = this.queue;
    this.queue = prev.then(next, next);
    return prev;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
