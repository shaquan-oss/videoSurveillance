/**
 * 聚智平台「知识库文档上传」客户端。
 *
 * 设计要点：
 * 1. 路径：POST /openapi/flames/api/v1/knowledge/document/upload，body 是 multipart/form-data，
 *    字段：files（多文件）、libId、categoryId、fileType（text=纯文本文档 / qa=问答对）。
 * 2. 鉴权走 URL 查询参数（buildQueryAuth），**不是** Authorization 头 —— 该接口只认前者。
 *    关联的知识库是否可写由「应用管理 → 资源授权」决定，与本客户端无关。
 * 3. 平台接口「HTTP 200 但解析失败」是高频踩坑点 —— 不在客户端内做回查，把这件事
 *    留给 sync 服务的「上传成功 → 写 uploaded → 由轮询或回调转 indexed」流程。
 * 4. 限速：QPS≤10/分钟 → 间隔 6500ms；上传是 I/O 重活，间隔稍微给大点。
 */
import { buildQueryAuth } from './signature.ts';
import {
  RateLimiter,
  platformFetch,
  PlatformHttpError,
  PlatformNetworkError,
  PlatformTimeoutError,
} from './http.ts';

const UPLOAD_PATH = '/openapi/flames/api/v1/knowledge/document/upload';

export interface PlatformKbOptions {
  host: string;
  appId: string;
  appSecret: string;
  /** 单文件上传超时。平台解析 docx 等可能慢，默认 90s */
  timeoutMs?: number;
}

export type UploadFileKind = 'text' | 'qa';

export interface PlatformUploadInput {
  /** 平台侧知识库 id（在聚智控制台拿到） */
  libId: string;
  /** 平台侧分类 id（libId 下的一级目录） */
  categoryId: string;
  /** 文档类型。text=纯文本/markdown 类；qa=问答对 */
  fileType: UploadFileKind;
  /** 上传的文件 */
  file: {
    name: string;
    /** 文件二进制；可以是 Buffer 或已构造的 Blob */
    data: Blob | ArrayBuffer;
    /** mime type，比如 text/markdown、application/json */
    mimeType?: string;
  };
}

export interface PlatformUploadResult {
  /** 平台返回的文档 id，用于后续更新/删除 */
  platformDocId: string;
  /** 平台返回的初始段落数（多数情况下是 0，本客户端不等到 indexed） */
  paragraphs: number;
}

export class PlatformKbError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, opts: { status?: number; body?: string } = {}) {
    super(message);
    this.name = 'PlatformKbError';
    this.status = opts.status;
    this.body = opts.body;
  }
}

export class PlatformKbClient {
  private readonly opts: PlatformKbOptions;
  /** 上传是 I/O 重活，间隔比对话更稳一点 */
  private readonly limiter = new RateLimiter(7_000);

  constructor(opts: PlatformKbOptions) {
    this.opts = opts;
  }

  async upload(input: PlatformUploadInput): Promise<PlatformUploadResult> {
    // 鉴权走 URL 查询参数（该接口不认 Authorization 头，会回 401「签名参数为空」）
    const qs = new URLSearchParams(
      buildQueryAuth({
        host: this.opts.host,
        method: 'POST',
        path: UPLOAD_PATH,
        appId: this.opts.appId,
        appSecret: this.opts.appSecret,
      }),
    );
    const url = `http://${this.opts.host}${UPLOAD_PATH}?${qs.toString()}`;

    const form = new FormData();
    // 字段顺序：libId/categoryId/fileType 三个字段名是手册定死的，files 是上传文件
    form.append('libId', input.libId);
    form.append('categoryId', input.categoryId);
    form.append('fileType', input.fileType);
    form.append('files', input.file.data, input.file.name);

    await this.limiter.acquire();

    let res: Response;
    try {
      // 注意：fetch 见到 multipart body 会自动补 Content-Type + boundary，
      // 这里不要再手动塞任何 Content-Type，否则 boundary 会缺失。
      res = await platformFetch(url, {
        method: 'POST',
        body: form,
        timeoutMs: this.opts.timeoutMs ?? 90_000,
      });
    } catch (err) {
      throw mapToKbError(err);
    }

    const text = await res.text();
    const parsed = safeJson(text);
    if (!parsed) {
      throw new PlatformKbError('平台响应不是 JSON', { body: text.slice(0, 300) });
    }

    const platformDocId = String(
      parsed.docId ?? parsed.doc_id ?? parsed.id ?? parsed.documentId ?? '',
    );
    if (!platformDocId) {
      // 重要：HTTP 200 但无 docId 也属于异常 —— 手册坑点之一
      throw new PlatformKbError('平台返回 200 但缺少 docId', { body: text.slice(0, 500) });
    }
    const paragraphs = Number(parsed.paragraphs ?? parsed.docParagraphsCount ?? parsed.paragraphCount ?? 0);
    return { platformDocId, paragraphs: Number.isFinite(paragraphs) ? paragraphs : 0 };
  }
}

/* ──────────── 辅助 ──────────── */

function mapToKbError(err: unknown): PlatformKbError {
  if (err instanceof PlatformKbError) return err;
  if (err instanceof PlatformHttpError) {
    return new PlatformKbError(`${err.message}：${err.body.slice(0, 200)}`, {
      status: err.status,
      body: err.body,
    });
  }
  if (err instanceof PlatformTimeoutError) {
    return new PlatformKbError(err.message);
  }
  if (err instanceof PlatformNetworkError) {
    return new PlatformKbError(err.message);
  }
  return new PlatformKbError((err as Error).message);
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
