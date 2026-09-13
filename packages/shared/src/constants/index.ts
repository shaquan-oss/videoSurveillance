/**
 * 前后端共用的枚举与常量。
 * 这里定义的每一个值，前端展示与后端判定都引用同一份，避免两边各写一套导致不一致。
 */

/* ───────── 密级 ───────── */

export const SECURITY_LEVELS = ['public', 'internal', 'department', 'private'] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];

export const SECURITY_LEVEL_LABEL: Record<SecurityLevel, string> = {
  public: '公开',
  internal: '内部',
  department: '部门',
  private: '私密',
};

export const SECURITY_LEVEL_DESC: Record<SecurityLevel, string> = {
  public: '全体同事可见',
  internal: '全公司同事可见',
  department: '仅指定部门的同事可见',
  private: '仅本人可见，默认不可纳入知识库',
};

/** 密级顺序权重，用于比较「谁的密级更严」 */
export const SECURITY_LEVEL_WEIGHT: Record<SecurityLevel, number> = {
  public: 0,
  internal: 1,
  department: 2,
  private: 3,
};

/* ───────── 能力清单 ───────── */

export const PERMISSIONS = {
  FILE_UPLOAD: 'file:upload',
  FILE_DOWNLOAD: 'file:download',
  FILE_DELETE: 'file:delete',
  FILE_SHARE: 'file:share',
  FILE_SECURITY_SET: 'file:security:set',
  KB_VIEW: 'kb:view',
  KB_CROSS_DEPT_SEARCH: 'kb:search:cross-dept',
  KB_INGEST: 'kb:ingest',
  KB_MANAGE: 'kb:manage',
  KB_APPLY_PERMISSION: 'kb:apply',
  AGENT_USE: 'agent:use',
  AGENT_CREATE: 'agent:create',
  SKILL_UPLOAD: 'skill:upload',
  SKILL_REVIEW: 'skill:review',
  TASK_MANAGE: 'task:manage',
  AUDIT_VIEW: 'audit:view',
  ANALYTICS_VIEW: 'analytics:view',
  MODEL_CONFIGURE: 'model:configure',
  USER_MANAGE: 'user:manage',
  SYSTEM_CONFIGURE: 'system:configure',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export const PERMISSION_LABEL: Record<string, string> = {
  [PERMISSIONS.FILE_UPLOAD]: '上传文件',
  [PERMISSIONS.FILE_DOWNLOAD]: '下载文件',
  [PERMISSIONS.FILE_DELETE]: '删除文件',
  [PERMISSIONS.FILE_SHARE]: '外链分享',
  [PERMISSIONS.FILE_SECURITY_SET]: '设置密级与可见范围',
  [PERMISSIONS.KB_VIEW]: '查看知识库',
  [PERMISSIONS.KB_CROSS_DEPT_SEARCH]: '跨部门检索知识库',
  [PERMISSIONS.KB_INGEST]: '把文件纳入知识库',
  [PERMISSIONS.KB_MANAGE]: '管理知识库',
  [PERMISSIONS.KB_APPLY_PERMISSION]: '申请知识库权限',
  [PERMISSIONS.AGENT_USE]: '使用智能体',
  [PERMISSIONS.AGENT_CREATE]: '创建智能体',
  [PERMISSIONS.SKILL_UPLOAD]: '上传技能',
  [PERMISSIONS.SKILL_REVIEW]: '审核技能',
  [PERMISSIONS.TASK_MANAGE]: '管理定时任务',
  [PERMISSIONS.AUDIT_VIEW]: '查看审计日志',
  [PERMISSIONS.ANALYTICS_VIEW]: '查看使用分析',
  [PERMISSIONS.MODEL_CONFIGURE]: '配置模型与通道',
  [PERMISSIONS.USER_MANAGE]: '管理成员与角色',
  [PERMISSIONS.SYSTEM_CONFIGURE]: '系统设置',
};

/* ───────── 内置角色 ───────── */

export const BUILTIN_ROLES = {
  SYSTEM_ADMIN: 'system_admin',
  KB_ADMIN: 'kb_admin',
  DEPT_MANAGER: 'dept_manager',
  MEMBER: 'member',
} as const;

export const ROLE_LABEL: Record<string, string> = {
  [BUILTIN_ROLES.SYSTEM_ADMIN]: '系统管理员',
  [BUILTIN_ROLES.KB_ADMIN]: '知识库管理员',
  [BUILTIN_ROLES.DEPT_MANAGER]: '部门主管',
  [BUILTIN_ROLES.MEMBER]: '普通成员',
};

/* ───────── 文件索引状态 ───────── */

export const FILE_INDEX_STATUS = {
  NOT_INGESTED: 'not_ingested',
  PENDING: 'pending',
  PARSING: 'parsing',
  INDEXED: 'indexed',
  /** 解析成功，但一个字都没解析出来 —— 扫描件或纯图片，需要 OCR 后重新上传 */
  NO_TEXT: 'no_text',
  FAILED: 'failed',
  UNSUPPORTED: 'unsupported',
} as const;
export type FileIndexStatus = (typeof FILE_INDEX_STATUS)[keyof typeof FILE_INDEX_STATUS];

export const FILE_INDEX_STATUS_LABEL: Record<FileIndexStatus, string> = {
  not_ingested: '未纳入知识库',
  pending: '等待解析',
  parsing: '解析中',
  indexed: '已索引',
  no_text: '无文字层，需 OCR',
  failed: '解析失败',
  unsupported: '格式不支持',
};

/* ───────── 任务与队列 ───────── */

export const QUEUE_NAMES = {
  DOCUMENT_PARSE: 'document-parse',
  EMBED_CHUNKS: 'embed-chunks',
  SEND_MAIL: 'send-mail',
  SCHEDULED_TASK: 'scheduled-task',
  CLEANUP: 'cleanup',
} as const;

/* ───────── 分页 ───────── */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

/* ───────── 文件类型 ───────── */

/** 可解析为文本、可纳入知识库的扩展名 */
export const PARSEABLE_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'md', 'txt', 'csv'] as const;

/** 允许上传的扩展名 */
export const ALLOWED_EXTENSIONS = [
  ...PARSEABLE_EXTENSIONS,
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'zip',
  'rar',
  '7z',
  'mp4',
  'mov',
  'mp3',
  'wav',
] as const;

export function getFileKind(ext: string): 'doc' | 'sheet' | 'slide' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'other' {
  const e = ext.toLowerCase();
  if (['pdf', 'doc', 'docx'].includes(e)) return 'doc';
  if (['xls', 'xlsx', 'csv'].includes(e)) return 'sheet';
  if (['ppt', 'pptx'].includes(e)) return 'slide';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv'].includes(e)) return 'video';
  if (['mp3', 'wav', 'flac'].includes(e)) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'archive';
  if (['md', 'txt', 'json', 'xml', 'html'].includes(e)) return 'text';
  return 'other';
}

export function isParseable(ext: string): boolean {
  return (PARSEABLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}
