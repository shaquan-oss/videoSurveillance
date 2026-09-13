import type { FileIndexStatus, Permission, SecurityLevel } from '../constants/index.ts';

/* ───────── 账号与组织 ───────── */

export interface UserBrief {
  id: string;
  name: string;
  account: string;
  departmentId: string | null;
  departmentName?: string | null;
  avatarText?: string;
}

export interface User extends UserBrief {
  email?: string | null;
  phone?: string | null;
  roleIds: string[];
  roleNames?: string[];
  permissions: Permission[];
  isActive: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  /** 该部门的默认密级上限：此部门成员最多能看到该密级的文件 */
  maxSecurityLevel: SecurityLevel;
  managerId?: string | null;
  sortOrder: number;
  children?: Department[];
  memberCount?: number;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  permissions: Permission[];
  isBuiltin: boolean;
  memberCount?: number;
}

/* ───────── 文件 ───────── */

export interface FileItem {
  id: string;
  name: string;
  extension: string;
  size: number;
  mimeType: string | null;
  /** 在对象存储中的位置。数据库只存这个 key，绝不存完整 URL */
  storageKey: string;
  checksum: string | null;

  folderId: string | null;
  folderName?: string | null;

  ownerId: string;
  ownerName?: string | null;

  securityLevel: SecurityLevel;
  /** 部门密级时生效：可见部门 id 列表 */
  visibleDeptIds: string[];
  /** 额外的可见成员（用于跨部门协作） */
  visibleUserIds?: string[];

  /** 知识库归属（未纳入时为 null） */
  kbId: string | null;
  kbName?: string | null;
  kbFolderId?: string | null;
  kbFolderName?: string | null;

  indexStatus: FileIndexStatus;
  chunkCount: number;
  indexedAt?: string | null;

  version: number;
  isFavorite: boolean;
  deletedAt: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface FileVersion {
  id: string;
  fileId: string;
  version: number;
  size: number;
  storageKey: string;
  checksum: string | null;
  uploadedById: string;
  uploadedByName?: string | null;
  note?: string | null;
  createdAt: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  ownerId: string;
  departmentId: string | null;
  securityLevel: SecurityLevel;
  visibleDeptIds: string[];
  fileCount?: number;
  totalSize?: number;
  createdAt: string;
}

export interface UploadInitInput {
  fileName: string;
  size: number;
  mimeType?: string;
  checksum?: string;
  folderId?: string | null;
  securityLevel?: SecurityLevel;
  visibleDeptIds?: string[];
}

export interface UploadInitResult {
  /** true 表示命中秒传，无需再传字节 */
  instant: boolean;
  uploadId?: string;
  fileId?: string;
  /** 需要上传的分片索引列表（断点续传时为剩余部分） */
  pendingChunks?: number[];
  chunkSize?: number;
}

/* ───────── 知识库 ───────── */

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string | null;
  ownerId: string;
  ownerName?: string | null;
  securityLevel: SecurityLevel;
  visibleDeptIds: string[];
  fileCount: number;
  chunkCount: number;
  isTeamSpace: boolean;
  createdAt: string;
}

/**
 * 知识库内的目录节点。
 * 独立于文件管理的 folders —— 文件本身位置不因纳入知识库而改变，
 * 这里只描述「在知识库里放在哪个目录下」。
 */
export interface KbFolder {
  id: string;
  kbId: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  /** 含全部后代的文件数 */
  fileCount: number;
}

export interface KbTreeFile {
  id: string;
  name: string;
  extension: string;
  size: number;
  indexStatus: FileIndexStatus;
  chunkCount: number;
  /** 知识库内的所在目录；null 表示挂在库根下 */
  kbFolderId: string | null;
  securityLevel: SecurityLevel;
  ownerName: string | null;
  updatedAt: string;
}

/**
 * 流式问答的事件。
 * 顺序固定：start → citations → meta → delta* → followUps? → done
 * 任何一环出错则以 error 收尾，前端据此结束 loading 状态。
 */
export type AskEvent =
  | { type: 'start'; conversationId: string; runMode: 'local' | 'remote' }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'meta'; modelKey: string; degraded: boolean; runMode: 'local' | 'remote' }
  | { type: 'delta'; text: string }
  | { type: 'followUps'; items: string[] }
  | { type: 'draft'; draft: MailDraft }
  | { type: 'done'; message: ChatMessage; degraded: boolean; runMode: 'local' | 'remote' }
  | { type: 'error'; message: string };

/* ───────── 邮件草稿 ───────── */

export type MailStatus = 'draft' | 'sent' | 'failed' | 'unsent';

/**
 * 邮件草稿。
 * 外发动作一律先落草稿、由用户确认后才发送（E-13），
 * 所以它是「待办」而不是「已办」。
 */
export interface MailDraft {
  id: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  status: MailStatus;
  error?: string | null;
  conversationId?: string | null;
  createdAt: string;
  sentAt?: string | null;
}

/* ───────── 检索与引用 ───────── */

export interface RetrievedChunk {
  chunkId: string;
  fileId: string;
  fileName: string;
  kbId: string;
  content: string;
  /** 相似度 0~1，越大越相关 */
  score: number;
  chunkIndex: number;
  page?: number | null;
}

/** 引用：回答中可点击回链到原文 */
export interface Citation {
  index: number;
  fileId: string;
  fileName: string;
  kbId: string;
  kbName?: string;
  chunkId?: string;
  page?: number | null;
  snippet?: string;
  /** 召回相似度，引用卡片上展示，便于用户判断可信度 */
  score?: number;
}

export interface RetrievalDebugInfo {
  query: string;
  /** 本次检索实际生效的可见知识库范围 */
  scopeKbIds: string[];
  /** 因无权限而被排除的文件数 */
  blockedFileCount: number;
  hits: RetrievedChunk[];
  elapsedMs: number;
}

/* ───────── 对话 ───────── */

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  citations?: Citation[];
  /**
   * 这次回答的运行模式，来源于 SSE 事件里的 runMode。
   * 用 message 维度记录更直观：用户在同一会话里也能切换 agent 让后续回答变远程。
   * 不入库（会话级 agent 不一定变，但每条回答的运行模式确实可能不同）。
   */
  runMode?: 'local' | 'remote';
  /** 模型给出的后续追问建议（点击即追问），原型里的追问 chips */
  followUps?: string[];
  /** 这次回答起草的邮件草稿 id（需要用户确认后才发送） */
  mailDraftId?: string | null;
  modelKey?: string | null;
  /** 回答耗时（毫秒） */
  elapsedMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  feedback?: 'up' | 'down' | null;
  feedbackReason?: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  ownerId: string;
  modelKey?: string | null;
  /** 本次对话限定的检索范围；空数组表示全部可见知识库 */
  scopeKbIds: string[];
  messageCount: number;
  isPinned: boolean;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRequest {
  question: string;
  conversationId?: string;
  modelKey?: string;
  scopeKbIds?: string[];
  /** 用哪个智能体回答（决定提示词、检索范围与技能） */
  agentId?: string;
  /**
   * 本次提问要「直读」的文件，一般是用户刚上传的。
   *
   * 这些文件的**全部切片**会直接作为上下文喂给模型，不依赖相似度检索 ——
   * 用户传了文件就是想针对它提问，而检索只取 top-K 相似片段，
   * 容易漏掉真正关键的那一段（长表格、附录、分散条款尤其明显）。
   */
  attachFileIds?: string[];
}

/* ───────── 模型 ───────── */

export interface ModelInfo {
  key: string;
  displayName: string;
  deploymentId: string;
  provider: 'jiutian' | 'openai-compat';
  capabilities: ('chat' | 'embed' | 'vision' | 'long-context')[];
  isEnabled: boolean;
  health?: ModelHealth;
}

export interface ModelHealth {
  ok: boolean;
  latencyMs: number;
  checkedAt: string;
  message?: string;
  consecutiveFails?: number;
}

/* ───────── 审计 ───────── */

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'file.upload'
  | 'file.download'
  | 'file.delete'
  | 'file.restore'
  | 'file.purge'
  | 'file.purge_all'
  | 'file.move'
  | 'file.security_change'
  | 'file.share'
  | 'folder.delete'
  | 'folder.cascade_delete'
  | 'kb.ingest'
  | 'kb.remove'
  | 'kb.search'
  | 'kb.search_blocked'
  | 'chat.ask'
  | 'chat.answer_failed'
  | 'agent.run'
  | 'mail.send'
  | 'task.create'
  | 'admin.config_change'
  | 'platform.kb_sync'
  | 'agent.run_remote'
  | 'agent.run_mode_guard';

export interface AuditLog {
  id: string;
  action: AuditAction;
  actorId: string;
  actorName?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  success: boolean;
  createdAt: string;
}

/* ───────── 接口通用结构 ───────── */

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; detail?: unknown } | null;
  requestId?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StorageUsage {
  totalBytes: number;
  totalFiles: number;
  byDepartment: {
    departmentId: string;
    departmentName: string;
    bytes: number;
    files: number;
  }[];
  byKind: { kind: string; bytes: number; files: number }[];
}

/* ───────── 智能体 / 技能 / 定时任务 ───────── */

export type AgentPublishStatus = 'draft' | 'published' | 'disabled';
export type AgentVisibility = 'private' | 'department' | 'company';

export interface Agent {
  id: string;
  name: string;
  description?: string | null;
  /** 示例问法：列表页展示「说起来就像：…」，选中智能体后填入输入框 */
  example?: string | null;
  systemPrompt: string;
  modelKey?: string | null;
  scopeKbIds: string[];
  /** 触发词：对话内容命中时提示可以唤起 */
  triggerWords: string[];
  /** 装配的技能 */
  skillIds: string[];
  skillNames?: string[];
  publishStatus: AgentPublishStatus;
  visibility: AgentVisibility;
  isBuiltin: boolean;
  builtinKey?: string | null;
  runCount: number;
  /** 最近一次试跑时间；为空表示没试跑过，不允许发布 */
  testedAt?: string | null;
  icon: string;
  ownerId: string;
  ownerName?: string | null;
  /** 兼容字段：visibility === 'company' */
  isPublic: boolean;
  /**
   * 运行模式：
   *   - 'local'  本地编排 + 本地 RAG + 模型自选
   *   - 'remote' 走聚智平台智能体（远程 RAG、远程模型选择由平台决定）
   * 老数据没填时默认 'local'，避免破坏现有智能体卡片。
   */
  runMode?: 'local' | 'remote';
  /**
   * 聚智平台侧智能体的 assistantCode，仅 runMode='remote' 时有值。
   * 远程对话时由后端拼到 URL 查询串上（不放 header）。
   */
  platformAssistantCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 智能体列表页的卡片：附带检索范围的知识库名称（详情接口里为空） */
export interface AgentCard extends Agent {
  kbNames: string[];
}

export type SkillStatus = 'pending' | 'published' | 'rejected';

export type SkillCategory = 'finance' | 'office' | 'data' | 'general';

export interface Skill {
  id: string;
  name: string;
  description?: string | null;
  triggerWords: string[];
  prompt: string;
  category: SkillCategory;
  visibility: 'company' | 'department';
  status: SkillStatus;
  /** 安全扫描结果：level=pass/warn/danger，hits 是命中的规则说明 */
  scanResult: { level: string; hits: string[] };
  isBuiltin: boolean;
  authorId: string;
  authorName?: string | null;
  installCount: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = 'active' | 'paused';

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  modelKey?: string | null;
  scopeKbIds: string[];
  ownerId: string;
  status: TaskStatus;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
