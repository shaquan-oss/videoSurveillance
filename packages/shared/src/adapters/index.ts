import type { SecurityLevel } from '../constants/index.ts';
import type { RetrievedChunk } from '../types/index.ts';

export const ADAPTER_TOKENS = {
  STORAGE: 'ADAPTER_STORAGE',
  VECTOR_STORE: 'ADAPTER_VECTOR_STORE',
  MODEL_PROVIDER: 'ADAPTER_MODEL_PROVIDER',
} as const;

/* ═══════════════ 1. 存储抽象层 ═══════════════
 * 实现方：MinIO（自购服务器） / 移动云 EOS / 任何 S3 兼容存储
 * 换存储时只替换实现，业务代码不动
 * ═══════════════════════════════════════════ */

export type ReadableBody = Uint8Array | ArrayBuffer | string;

export interface ObjectMeta {
  key: string;
  size: number;
  lastModified?: Date;
  contentType?: string;
}

export interface StorageAdapter {
  /** 写入对象。key 形如 dept/2026/09/文件ID.pdf */
  put(key: string, body: ReadableBody, contentType?: string): Promise<void>;
  /** 读取对象，返回完整字节（大文件建议用 presignGet 让浏览器直取） */
  get(key: string): Promise<Uint8Array>;
  /** 判断对象是否存在 */
  exists(key: string): Promise<boolean>;
  /** 删除对象（软删除由业务层负责，这里是真的删） */
  remove(key: string): Promise<void>;
  /**
   * 签发临时访问链接。
   * 这是文件下载的唯一出口：后端先校验权限，再签发 5~10 分钟有效的链接，
   * 浏览器凭链接直接从对象存储取文件，文件流不经过后端。
   */
  presignGet(
    key: string,
    expiresInSec?: number,
    downloadName?: string,
    /** inline=浏览器直接打开预览；attachment=强制下载 */
    disposition?: 'inline' | 'attachment',
  ): Promise<string>;
  /** 确保桶存在（启动时调用） */
  ensureBucket(): Promise<void>;
  /** 存储健康状态（管理后台用） */
  health(): Promise<{
    ok: boolean;
    usedBytes?: number;
    latencyMs?: number;
    message?: string;
  }>;
}

/* ═══════════════ 2. 向量检索抽象层 ═══════════════
 * 实现方：pgvector（当前） / Milvus、Qdrant（未来）
 * 关键：检索时必须把权限过滤下推到查询里，而不是查出来再过滤
 * ═══════════════════════════════════════════════ */

export interface ChunkRecord {
  id: string;
  fileId: string;
  kbId: string;
  content: string;
  embedding: number[];
  chunkIndex: number;
  page?: number | null;
  /** 冗余的权限字段，避免检索时多表关联 */
  securityLevel: SecurityLevel;
  visibleDeptIds: string[];
  ownerId: string;
}

/** 权限过滤条件：由权限模块生成，这里只负责塞进 SQL */
export interface PermissionFilter {
  userId: string;
  departmentId: string | null;
  /** 用户可跨部门检索时置空 */
  restrictToDepts: string[] | null;
  allowPublic: boolean;
}

export interface VectorQuery {
  embedding: number[];
  filter: PermissionFilter;
  /** 限定在这些知识库内检索；空数组表示全部可见范围 */
  kbIds: string[];
  topK: number;
}

export interface VectorStore {
  upsert(records: ChunkRecord[]): Promise<void>;
  query(q: VectorQuery): Promise<RetrievedChunk[]>;
  removeByFile(fileId: string): Promise<void>;
  countByKb(kbId: string): Promise<number>;
  /** 关键词兜底检索（向量召回不足时用） */
  keywordSearch(keyword: string, filter: PermissionFilter, kbIds: string[], limit: number): Promise<RetrievedChunk[]>;
}

/* ═══════════════ 3. 模型抽象层 ═══════════════
 * 实现方：聚智 OpenAPI（HMAC 签名） / 任何 OpenAI 兼容端点
 * ═══════════════════════════════════════════ */

export interface ChatMessagePayload {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 超时（毫秒） */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  /** 实际产出内容的模型 key（降级时与请求的模型不同） */
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  elapsedMs: number;
  /** 是否发生了模型降级（首选不可用，自动切了备用） */
  degraded?: boolean;
}

export interface ModelProvider {
  readonly name: string;
  /** 一次性返回（用于不需要流式的场景） */
  chat(messages: ChatMessagePayload[], opts: ChatOptions): Promise<ChatResult>;
  /** 流式返回（对话主链路用），逐段产出文本 */
  chatStream(messages: ChatMessagePayload[], opts: ChatOptions): AsyncGenerator<string, void, unknown>;
  /** 文本向量化（知识库入库用） */
  embed(texts: string[], opts: { model: string; timeoutMs?: number }): Promise<number[][]>;
  /** 健康探测 */
  health(opts: { model: string; timeoutMs?: number }): Promise<{ ok: boolean; latencyMs: number; message?: string }>;
}

/* ═══════════════ 4. 文档解析抽象层 ═══════════════
 * 实现方：pdf / docx / xlsx / md / txt 各自的解析器
 * 换解析库（如 pdf-parse → pdfjs）或加新格式，只在这里加实现，上层不动
 * ═══════════════════════════════════════════ */

export interface ParseInput {
  fileName: string;
  /** 文件字节（解析器自己判断编码/结构） */
  bytes: Uint8Array;
}

export interface ParsedBlock {
  /** 段落级标题（可选，来自 md 的 #、docx 的 Heading 样式等） */
  heading?: string;
  content: string;
  page?: number | null;
}

export interface ParsedDocument {
  /** 文件名去扩展，作为切片元信息 */
  title: string;
  /** 结构化块（预览用），切片器据此重建层级 */
  blocks: ParsedBlock[];
  /** 全量纯文本，切片器从这里切分 */
  text: string;
}

export interface DocumentParser {
  /** 支持的扩展名（不含点、小写），如 ['pdf','docx'] */
  readonly extensions: string[];
  parse(input: ParseInput): Promise<ParsedDocument>;
}
