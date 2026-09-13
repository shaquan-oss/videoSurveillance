import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, SECURITY_LEVELS } from '../constants/index.ts';

/**
 * 校验规则定义一次，前后端共用：
 * 后端用它拦掉脏数据，前端用它做即时提示，避免两套规则不一致。
 */

/* ───────── 通用 ───────── */

export const idSchema = z.string().min(1, '缺少标识');

export const securityLevelSchema = z.enum(SECURITY_LEVELS);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const uuidOrTemp = z.string().min(1);

/* ───────── 认证 ───────── */

export const loginSchema = z.object({
  account: z.string().min(2, '账号至少 2 位').max(64),
  password: z.string().min(6, '密码至少 6 位').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(6),
  newPassword: z
    .string()
    .min(8, '新密码至少 8 位')
    .max(128)
    .regex(/[a-zA-Z]/, '需包含字母')
    .regex(/[0-9]/, '需包含数字'),
});

/* ───────── 文件 ───────── */

export const fileListQuerySchema = paginationSchema.extend({
  folderId: z.string().optional(),
  keyword: z.string().max(100).optional(),
  securityLevel: securityLevelSchema.optional(),
  kbId: z.string().optional(),
  onlyFavorite: z.coerce.boolean().optional(),
  onlyMine: z.coerce.boolean().optional(),
  /** 回收站视图 */
  trash: z.coerce.boolean().optional(),
  sortBy: z.enum(['name', 'size', 'createdAt', 'updatedAt']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type FileListQuery = z.infer<typeof fileListQuerySchema>;

export const uploadInitSchema = z.object({
  fileName: z.string().min(1).max(255),
  size: z.number().int().min(0),
  mimeType: z.string().max(120).optional(),
  checksum: z.string().max(128).optional(),
  folderId: z.string().nullable().optional(),
  securityLevel: securityLevelSchema.default('internal'),
  visibleDeptIds: z.array(z.string()).default([]),
});
/** 校验后的上传初始化参数（与 types 里的 UploadInitInput 是同名概念的两侧表示，故另起名避免歧义） */
export type UploadInitParams = z.infer<typeof uploadInitSchema>;

export const fileSecuritySchema = z
  .object({
    securityLevel: securityLevelSchema,
    visibleDeptIds: z.array(z.string()).default([]),
    visibleUserIds: z.array(z.string()).default([]),
  })
  .refine((v) => v.securityLevel !== 'department' || v.visibleDeptIds.length > 0, {
    message: '选择「部门」密级时必须指定可见部门',
    path: ['visibleDeptIds'],
  });
export type FileSecurityInput = z.infer<typeof fileSecuritySchema>;

export const folderCreateSchema = z.object({
  name: z.string().min(1, '请填写文件夹名称').max(120),
  parentId: z.string().nullable().optional(),
});

export const folderUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parentId: z.string().nullable().optional(),
  securityLevel: securityLevelSchema.optional(),
  visibleDeptIds: z.array(z.string()).optional(),
});

export const fileRenameSchema = z.object({ name: z.string().min(1).max(255) });

/** 移动文件到指定文件夹；folderId 为 null 时移到顶级（不挂任何文件夹） */
export const fileMoveSchema = z.object({
  folderId: z.string().nullable(),
});

/** 文件夹级联删除确认：必须显式声明「我确实要连内容一起删」，避免误操作 */
export const folderCascadeDeleteSchema = z.object({
  confirm: z.literal(true),
});

export type FileMoveInput = z.infer<typeof fileMoveSchema>;

export const batchIdsSchema = z.object({
  ids: z.array(z.string()).min(1, '请至少选择一项'),
});

/* ───────── 知识库 ───────── */

export const kbCreateSchema = z.object({
  name: z.string().min(1, '请填写知识库名称').max(80),
  description: z.string().max(300).optional(),
  securityLevel: securityLevelSchema.default('internal'),
  visibleDeptIds: z.array(z.string()).default([]),
  isTeamSpace: z.boolean().default(false),
});

export const kbIngestSchema = z.object({
  fileIds: z.array(z.string()).min(1, '请选择要纳入的文件'),
  kbId: z.string().min(1, '请选择目标知识库'),
  kbFolderId: z.string().nullable().optional(),
  /** 立即解析并建立索引 */
  parseNow: z.boolean().default(true),
  /** 继承原密级与可见范围 */
  inheritSecurity: z.boolean().default(true),
});
export type KbIngestInput = z.infer<typeof kbIngestSchema>;

export const kbKbCreateFolderSchema = z.object({
  kbId: z.string().min(1),
  name: z.string().min(1).max(80),
  parentId: z.string().nullable().optional(),
});

export const retrievalTestSchema = z.object({
  query: z.string().min(1, '请输入测试问题'),
  kbIds: z.array(z.string()).default([]),
  topK: z.number().int().min(1).max(50).default(8),
});
export type RetrievalTestInput = z.infer<typeof retrievalTestSchema>;

/* ───────── 对话 ───────── */

export const chatRequestSchema = z.object({
  question: z.string().min(1, '请输入内容').max(4000),
  conversationId: z.string().optional(),
  modelKey: z.string().optional(),
  scopeKbIds: z.array(z.string()).default([]),
});
export type ChatRequestInput = z.infer<typeof chatRequestSchema>;

export const feedbackSchema = z.object({
  messageId: z.string().min(1),
  value: z.enum(['up', 'down']),
  reason: z.string().max(200).optional(),
});

/* ───────── 管理 ───────── */

export const userCreateSchema = z.object({
  account: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, '账号只能包含字母数字与 . _ -'),
  name: z.string().min(1).max(40),
  password: z.string().min(8).max(128),
  departmentId: z.string().nullable().optional(),
  roleIds: z.array(z.string()).default([]),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(20).optional(),
});

export const userUpdateSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  departmentId: z.string().nullable().optional(),
  roleIds: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(20).optional(),
});

export const roleUpsertSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  permissions: z.array(z.string()).default([]),
});

export const departmentUpsertSchema = z.object({
  name: z.string().min(1).max(60),
  parentId: z.string().nullable().optional(),
  maxSecurityLevel: securityLevelSchema.default('internal'),
  managerId: z.string().nullable().optional(),
  sortOrder: z.number().int().default(0),
});
