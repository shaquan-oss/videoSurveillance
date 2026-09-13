/**
 * 数据库表结构 —— 全系统的地基。
 *
 * 设计原则：
 * 1. 只存 storage_key，不存任何完整 URL（换存储时 URL 会失效，key 不会）
 * 2. 权限相关的字段（密级、可见部门）随业务表一起存，不单独建权限表
 * 3. 软删除统一用 deleted_at，列表查询默认过滤 deleted_at is not null
 * 4. 时间统一 timestamptz，避免时区歧义
 * 5. 切片表冗余权限字段，让「检索 + 权限过滤」一次 SQL 完成
 */
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';

/* ═══════════════ 组织与账号 ═══════════════ */

export const departments = pgTable('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 60 }).notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => departments.id, {
    onDelete: 'set null',
  }),
  /** 该部门成员的密级上限，超过此密级的文件本部门不可见 */
  maxSecurityLevel: varchar('max_security_level', { length: 16 }).notNull().default('internal'),
  managerId: uuid('manager_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    account: varchar('account', { length: 64 }).notNull(),
    name: varchar('name', { length: 40 }).notNull(),
    /** scrypt 哈希，格式：scrypt$N$r$p$salt$hash */
    passwordHash: text('password_hash').notNull(),
    email: varchar('email', { length: 120 }),
    phone: varchar('phone', { length: 20 }),
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_account_uq').on(t.account),
    index('users_dept_idx').on(t.departmentId),
    index('users_active_idx').on(t.isActive),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 40 }).notNull(),
    name: varchar('name', { length: 40 }).notNull(),
    description: varchar('description', { length: 200 }),
    /** 能力清单，值来自 @kh/shared 的 PERMISSIONS */
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('roles_key_uq').on(t.key)],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index('user_roles_role_idx').on(t.roleId)],
);

/* ═══════════════ 文件夹与文件 ═══════════════ */

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, {
      onDelete: 'cascade',
    }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    securityLevel: varchar('security_level', { length: 16 }).notNull().default('internal'),
    visibleDeptIds: jsonb('visible_dept_ids').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('folders_parent_idx').on(t.parentId), index('folders_owner_idx').on(t.ownerId)],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    extension: varchar('extension', { length: 20 }).notNull(),
    /** 字节数。用 bigint 因为视频类文件可能超过 int 上限 */
    size: bigint('size', { mode: 'number' }).notNull(),
    mimeType: varchar('mime_type', { length: 120 }),
    /** ★ 对象存储中的位置，形如 finance/2026/09/8f3a2b1c.pdf */
    storageKey: text('storage_key').notNull(),
    /** 内容哈希，用于秒传与去重 */
    checksum: varchar('checksum', { length: 128 }),

    folderId: uuid('folder_id').references(() => folders.id, {
      onDelete: 'set null',
    }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),

    securityLevel: varchar('security_level', { length: 16 }).notNull().default('internal'),
    visibleDeptIds: jsonb('visible_dept_ids').$type<string[]>().notNull().default([]),
    visibleUserIds: jsonb('visible_user_ids').$type<string[]>().notNull().default([]),

    /** 知识库归属（未纳入时为 null）。不加外键约束以避免与 chunks 表形成循环依赖 */
    kbId: uuid('kb_id'),
    kbFolderId: uuid('kb_folder_id'),
    indexStatus: varchar('index_status', { length: 20 }).notNull().default('not_ingested'),
    chunkCount: integer('chunk_count').notNull().default(0),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    parseError: text('parse_error'),

    version: integer('version').notNull().default(1),
    isFavorite: boolean('is_favorite').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('files_owner_idx').on(t.ownerId),
    index('files_folder_idx').on(t.folderId),
    index('files_dept_idx').on(t.departmentId),
    index('files_security_idx').on(t.securityLevel),
    index('files_kb_idx').on(t.kbId),
    index('files_checksum_idx').on(t.checksum),
    index('files_deleted_idx').on(t.deletedAt),
    index('files_updated_idx').on(t.updatedAt),
  ],
);

export const fileVersions = pgTable(
  'file_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    checksum: varchar('checksum', { length: 128 }),
    uploadedById: uuid('uploaded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    note: varchar('note', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('file_versions_uq').on(t.fileId, t.version)],
);

/** 分片上传会话：支持断点续传 */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    chunkSize: integer('chunk_size').notNull(),
    totalChunks: integer('total_chunks').notNull(),
    /** 已成功接收的分片序号 */
    uploadedChunks: jsonb('uploaded_chunks').$type<number[]>().notNull().default([]),
    status: varchar('status', { length: 20 }).notNull().default('uploading'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('upload_sessions_file_idx').on(t.fileId), index('upload_sessions_owner_idx').on(t.ownerId)],
);

/* ═══════════════ 知识库与切片 ═══════════════ */

export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 80 }).notNull(),
    description: varchar('description', { length: 300 }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    securityLevel: varchar('security_level', { length: 16 }).notNull().default('internal'),
    visibleDeptIds: jsonb('visible_dept_ids').$type<string[]>().notNull().default([]),
    /** 团队空间（所有人可见）还是个人知识库 */
    isTeamSpace: boolean('is_team_space').notNull().default(false),

    /** 远程同步目标（聚智平台）。三项都填才算「已绑定」 */
    platformLibId: varchar('platform_lib_id', { length: 80 }),
    platformCategoryId: varchar('platform_category_id', { length: 80 }),
    platformVersion: varchar('platform_version', { length: 40 }),
    /** 最近一次同步完成时间（含成功的差异比对） */
    platformLastSyncedAt: timestamp('platform_last_synced_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('kb_owner_idx').on(t.ownerId),
    index('kb_team_idx').on(t.isTeamSpace),
    index('kb_platform_lib_idx').on(t.platformLibId),
  ],
);

/**
 * 知识库内的目录。
 * 与文件管理的 folders 相互独立：文件本身的位置不因纳入/移出知识库而改变，
 * 这里只记录「在知识库里放到哪个目录下」，对应原型的「纳入时选择存放位置」。
 */
export const kbFolders = pgTable(
  'kb_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => kbFolders.id, {
      onDelete: 'cascade',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('kb_folders_kb_idx').on(t.kbId), index('kb_folders_parent_idx').on(t.parentId)],
);

/**
 * 知识切片 —— 检索的最小单位。
 * embedding 维度 1024（对应聚智 emb_v1_1024 模型）。
 * 冗余 security_level / visible_dept_ids / owner_id，让检索时的权限过滤
 * 与相似度排序在同一条 SQL 里完成，不需要跨表 join。
 */
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    page: integer('page'),
    tokenCount: integer('token_count'),

    embedding: vector('embedding', { dimensions: 1024 }),

    securityLevel: varchar('security_level', { length: 16 }).notNull().default('internal'),
    visibleDeptIds: jsonb('visible_dept_ids').$type<string[]>().notNull().default([]),
    ownerId: uuid('owner_id').notNull(),
    departmentId: uuid('department_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chunks_file_idx').on(t.fileId),
    index('chunks_kb_idx').on(t.kbId),
    index('chunks_security_idx').on(t.securityLevel),
    index('chunks_owner_idx').on(t.ownerId),
  ],
);

/* ═══════════════ 对话 ═══════════════ */

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 120 }).notNull().default('新会话'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    modelKey: varchar('model_key', { length: 60 }),
    /** 本次会话限定的检索范围，空数组表示全部可见知识库 */
    scopeKbIds: jsonb('scope_kb_ids').$type<string[]>().notNull().default([]),
    /** 聚智平台下发的 session id，远程模式下回传以保持多轮上下文 */
    platformSessionId: varchar('platform_session_id', { length: 80 }),
    messageCount: integer('message_count').notNull().default(0),
    isPinned: boolean('is_pinned').notNull().default(false),
    isFavorite: boolean('is_favorite').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('conv_owner_idx').on(t.ownerId), index('conv_updated_idx').on(t.updatedAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 12 }).notNull(),
    content: text('content').notNull(),
    /** 引用列表，供前端渲染可点击的回链卡片 */
    citations: jsonb('citations').$type<unknown[]>().notNull().default([]),
    /** 本次回答实际召回的片段（用于审计下钻与问题复盘） */
    retrievedChunkIds: jsonb('retrieved_chunk_ids').$type<string[]>().notNull().default([]),
    /** 追问建议：回答下方可点击的 follow-up chips */
    followUps: jsonb('follow_ups').$type<string[]>().notNull().default([]),
    /** 本次回答起草的邮件草稿（需人工确认后才发送） */
    mailDraftId: uuid('mail_draft_id'),
    modelKey: varchar('model_key', { length: 60 }),
    elapsedMs: integer('elapsed_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    feedback: varchar('feedback', { length: 8 }),
    feedbackReason: varchar('feedback_reason', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conv_idx').on(t.conversationId), index('messages_created_idx').on(t.createdAt)],
);

/**
 * 邮件发件箱。
 *
 * 外发类动作一律「先草稿、人工确认后才发送」（E-13），
 * 所以这既是草稿箱也是发送记录 —— 智能体起草时落一条 draft，
 * 用户点了确认才真正投递并把状态改成 sent。
 * 未配置 SMTP 时状态为 unsent，正文仍可复制或导出 .eml 自己发。
 */
export const mailOutbox = pgTable(
  'mail_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 由哪个会话/消息起草的，便于回溯 */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    agentId: uuid('agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    to: jsonb('to').$type<string[]>().notNull().default([]),
    cc: jsonb('cc').$type<string[]>().notNull().default([]),
    subject: varchar('subject', { length: 200 }).notNull().default(''),
    body: text('body').notNull().default(''),
    /** draft=待确认 sent=已发送 failed=发送失败 unsent=未配置邮件服务 */
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    error: varchar('error', { length: 300 }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mail_outbox_status_idx').on(t.status), index('mail_outbox_creator_idx').on(t.createdBy)],
);

/** 定时任务的每次执行记录（F-09）：结果、耗时、失败原因 */
export const taskRuns = pgTable(
  'task_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    /** success=成功 failed=失败 skipped=跳过（如节假日） */
    status: varchar('status', { length: 16 }).notNull(),
    detail: text('detail'),
    elapsedMs: integer('elapsed_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_runs_task_idx').on(t.taskId), index('task_runs_started_idx').on(t.startedAt)],
);

/* ═══════════════ 审计 ═══════════════ */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: varchar('action', { length: 40 }).notNull(),
    actorId: uuid('actor_id'),
    actorName: varchar('actor_name', { length: 40 }),
    targetType: varchar('target_type', { length: 30 }),
    targetId: uuid('target_id'),
    targetName: varchar('target_name', { length: 255 }),
    /** 结构化明细：检索命中哪些片段、拦截判定规则、配置改动前后值等 */
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    success: boolean('success').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_actor_idx').on(t.actorId),
    index('audit_action_idx').on(t.action),
    index('audit_created_idx').on(t.createdAt),
    index('audit_target_idx').on(t.targetId),
  ],
);

/* ═══════════════ 通知（阶段三用，先建表） ═══════════════ */

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 30 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    body: varchar('body', { length: 500 }),
    linkTo: varchar('link_to', { length: 200 }),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notif_user_idx').on(t.userId), index('notif_read_idx').on(t.isRead)],
);

/* ═══════════════ 智能体 / 技能 / 定时任务 ═══════════════ */

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 60 }).notNull(),
    description: varchar('description', { length: 300 }),
    /** 示例问法：列表页展示「说起来就像：…」，选中智能体后填进输入框 */
    example: varchar('example', { length: 200 }),
    /** 系统提示词：定义这个智能体的人设与行为边界 */
    systemPrompt: text('system_prompt').notNull(),
    /** 默认模型，空表示跟随全局默认 */
    modelKey: varchar('model_key', { length: 60 }),
    /** 检索范围：空数组 = 全部可见知识库 */
    scopeKbIds: jsonb('scope_kb_ids').$type<string[]>().notNull().default([]),
    /** 触发词：对话里命中即时提示可以唤起这个智能体 */
    triggerWords: jsonb('trigger_words').$type<string[]>().notNull().default([]),
    /** 装配的技能 id 列表，运行时把技能的提示词片段拼进上下文 */
    skillIds: jsonb('skill_ids').$type<string[]>().notNull().default([]),
    /** draft=草稿 published=已发布 disabled=已停用 */
    publishStatus: varchar('publish_status', { length: 16 }).notNull().default('draft'),
    /** private=仅自己 department=本部门 company=全公司 */
    visibility: varchar('visibility', { length: 16 }).notNull().default('private'),
    /** 内置智能体（周报助手 / 邮件助手 / 报账流程），不允许删除 */
    isBuiltin: boolean('is_builtin').notNull().default(false),
    builtinKey: varchar('builtin_key', { length: 40 }),
    /** 被唤起次数，用于「最常用」排序 */
    runCount: integer('run_count').notNull().default(0),
    /** 最近一次试跑时间：未试跑不允许发布（发布前校验） */
    testedAt: timestamp('tested_at', { withTimezone: true }),
    icon: varchar('icon', { length: 20 }).notNull().default('🤖'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    /** 是否公开给全公司（否则仅本人可见） */
    isPublic: boolean('is_public').notNull().default(false),

    /** 运行模式：local=本地 RAG + LLM；remote=转发到聚智平台智能体 */
    runMode: varchar('run_mode', { length: 12 }).notNull().default('local'),
    /** 远程模式下聚智平台返回的 assistant code */
    platformAssistantCode: varchar('platform_assistant_code', { length: 80 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('agents_owner_idx').on(t.ownerId),
    index('agents_public_idx').on(t.isPublic),
    index('agents_run_mode_idx').on(t.runMode),
  ],
);

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 60 }).notNull(),
    description: varchar('description', { length: 300 }),
    /** 触发词：对话中出现即推荐/唤起该技能 */
    triggerWords: jsonb('trigger_words').$type<string[]>().notNull().default([]),
    /** 技能指令（提示词片段），执行时拼进模型上下文 */
    prompt: text('prompt').notNull(),
    /** 分类：finance=财务 office=公文 data=数据 general=通用 */
    category: varchar('category', { length: 30 }).notNull().default('general'),
    /** 可见范围：company=全公司 department=指定部门 */
    visibility: varchar('visibility', { length: 16 }).notNull().default('company'),
    /** 技能包元数据（从 SKILL.md 解析出的名称、触发词、权限声明等） */
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull().default({}),
    /** 安全扫描结果：pass / warn / danger ＋ 命中的规则 */
    scanResult: jsonb('scan_result').$type<{ level: string; hits: string[] }>().notNull().default({ level: 'pass', hits: [] }),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    /** pending=待审核 published=已上架 rejected=已驳回 */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    installCount: integer('install_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('skills_status_idx').on(t.status), index('skills_author_idx').on(t.authorId)],
);

export const scheduledTasks = pgTable(
  'scheduled_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 80 }).notNull(),
    /** cron 表达式（5 段） */
    cron: varchar('cron', { length: 60 }).notNull(),
    /** 任务描述，触发时作为 prompt 交给模型执行 */
    prompt: text('prompt').notNull(),
    modelKey: varchar('model_key', { length: 60 }),
    scopeKbIds: jsonb('scope_kb_ids').$type<string[]>().notNull().default([]),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** active / paused */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('tasks_owner_idx').on(t.ownerId), index('tasks_status_idx').on(t.status)],
);

/* ═══════════════ 平台同步 ═══════════════ */

/**
 * 知识库往聚智平台同步的逐文件记录。
 *
 * 一份记录对应「本地这个 file 在远程那份文档」的一对一映射。
 * 重新同步时按 checksum 比对：
 *   - 没有记录  → 新增
 *   - 有记录但 checksum 变了 → 更新（删旧建新）
 *   - 有记录但 checksum 没变 → 跳过
 * status 含义：
 *   pending  排队中
 *   uploading 正在调文档上传接口
 *   uploaded 上传 HTTP 200，但还没确认平台解析成功
 *   indexed  平台回查 docParagraphsCount > 0，纳入检索
 *   failed   重试 N 次后仍失败，detail 里有最后一次的错误
 *   skipped  扫描件/无文本，本地解析就没产出切片，按设计不上传
 */
export const kbSyncRecords = pgTable(
  'kb_sync_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** 本地文件内容指纹，checksum 没变就不重传 */
    checksum: varchar('checksum', { length: 128 }).notNull(),
    /** 聚智平台侧文档 id，便于后续更新/删除 */
    platformDocId: varchar('platform_doc_id', { length: 80 }),
    /** 平台回查的段落数。= 0 还没解析完成；>0 才算 indexed */
    remoteParagraphs: integer('remote_paragraphs').notNull().default(0),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    error: text('error'),
    /** 重试次数。达到上限置 failed */
    attempt: integer('attempt').notNull().default(0),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kb_sync_kb_idx').on(t.kbId),
    index('kb_sync_file_idx').on(t.fileId),
    index('kb_sync_status_idx').on(t.status),
    uniqueIndex('kb_sync_kb_file_uq').on(t.kbId, t.fileId),
  ],
);
