import {
  AppError,
  ErrorCode,
  PERMISSIONS,
  type Permission,
  type PermissionFilter,
  SECURITY_LEVEL_WEIGHT,
  type SecurityLevel,
} from '@kh/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import * as schema from '../database/schema/index.ts';

/**
 * 权限判定的唯一实现处。
 *
 * 为什么强调「唯一」：文件列表、检索过滤、worker 更新索引都要判权限。
 * 如果各处各写一套，迟早出现规则不一致 —— 后果就是员工搜到了自己不该看的文件。
 * 所以全系统只允许调用这里的方法，禁止在业务模块里重复实现密级逻辑。
 */

/** 参与判定的用户上下文（由会话加载时组装） */
export interface AuthContext {
  userId: string;
  /** 姓名。审计日志要靠它显示「谁做的」，否则流水里只有一串 UUID，复盘时没法看 */
  userName: string;
  departmentId: string | null;
  permissions: Permission[];
}

/** 参与判定的文件属性（数据库行或切片行的子集） */
export interface FileSecurityInfo {
  ownerId: string;
  securityLevel: SecurityLevel;
  visibleDeptIds: string[];
  visibleUserIds?: string[];
  departmentId?: string | null;
}

/**
 * 判断某人能否看某个文件。
 * 判定顺序：本人 → 公开 → 内部 → 部门 → 私密
 */
export function canViewFile(ctx: AuthContext, file: FileSecurityInfo): boolean {
  // 一律可以看到自己上传的
  if (file.ownerId === ctx.userId) return true;

  // 显式指定了可见成员
  if (file.visibleUserIds?.includes(ctx.userId)) return true;

  switch (file.securityLevel) {
    case 'public':
    case 'internal':
      return true;
    case 'department':
      if (!ctx.departmentId) return false;
      // 拥有跨部门检索能力的人可以看部门密级
      if (hasPermission(ctx, PERMISSIONS.KB_CROSS_DEPT_SEARCH)) return true;
      return file.visibleDeptIds.includes(ctx.departmentId);
    case 'private':
      return false;
    default:
      return false;
  }
}

/** 判断某人能否下载（在可见基础上再要求下载能力） */
export function canDownloadFile(ctx: AuthContext, file: FileSecurityInfo): boolean {
  return canViewFile(ctx, file) && hasPermission(ctx, PERMISSIONS.FILE_DOWNLOAD);
}

/** 判断某人能否删除：本人或有删除能力 */
export function canDeleteFile(ctx: AuthContext, file: FileSecurityInfo): boolean {
  return file.ownerId === ctx.userId || hasPermission(ctx, PERMISSIONS.FILE_DELETE);
}

/** 能否修改密级：本人或有专门的密级管理能力 */
export function canChangeSecurity(ctx: AuthContext, file: FileSecurityInfo): boolean {
  return file.ownerId === ctx.userId || hasPermission(ctx, PERMISSIONS.FILE_SECURITY_SET);
}

/** 私密文件默认不允许纳入知识库（纳入后模型可能读到，等于绕过密级） */
export function canIngestToKb(ctx: AuthContext, file: FileSecurityInfo): { ok: boolean; reason?: string } {
  if (!hasPermission(ctx, PERMISSIONS.KB_INGEST)) {
    return { ok: false, reason: '你没有「把文件纳入知识库」的权限' };
  }
  if (!canViewFile(ctx, file)) {
    return { ok: false, reason: '你没有查看该文件的权限' };
  }
  if (file.securityLevel === 'private') {
    return { ok: false, reason: '私密文件不能纳入知识库' };
  }
  return { ok: true };
}

/**
 * 生成检索用的权限过滤条件。
 * 交给 VectorStore 拼进 SQL，让过滤发生在查询阶段而不是结果阶段。
 */
export function buildPermissionFilter(ctx: AuthContext): PermissionFilter {
  return {
    userId: ctx.userId,
    departmentId: ctx.departmentId,
    // null 表示不做部门限制（拥有跨部门检索能力的人可以检索全部部门密级）
    restrictToDepts: hasPermission(ctx, PERMISSIONS.KB_CROSS_DEPT_SEARCH) ? null : ctx.departmentId ? [ctx.departmentId] : [],
    allowPublic: true,
  };
}

/** 是否具备某个能力 */
export function hasPermission(ctx: AuthContext, permission: Permission): boolean {
  return ctx.permissions.includes(permission);
}

/** 断言，不具备时抛 403 */
export function assertPermission(ctx: AuthContext, permission: Permission): void {
  if (!hasPermission(ctx, permission)) {
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: '你没有执行该操作的权限',
    });
  }
}

export function assertCanView(ctx: AuthContext, file: FileSecurityInfo): void {
  if (!canViewFile(ctx, file)) {
    throw new AppError(ErrorCode.SECURITY_DENIED);
  }
}

/** 密级是否 A 严于 B */
export function isStricter(a: SecurityLevel, b: SecurityLevel): boolean {
  return SECURITY_LEVEL_WEIGHT[a] > SECURITY_LEVEL_WEIGHT[b];
}

/** 部门密级上限校验：不能让成员把文件设成超出本部门上限的密级 */
export function isWithinDeptLimit(level: SecurityLevel, deptMaxLevel: SecurityLevel): boolean {
  return SECURITY_LEVEL_WEIGHT[level] <= SECURITY_LEVEL_WEIGHT[deptMaxLevel];
}

/* ═══════════════ SQL 层过滤条件 ═══════════════
 * 与 canViewFile 保持同一套规则，但下推到 SQL 里执行。
 * 列表查询、检索召回都用它 —— 权限条件必须在查询阶段生效，
 * 不能「查出来再过滤」，否则无权数据会短暂进入内存甚至被日志记下。
 *
 * 这里有两种传入方式，原因是两处的查询写法不同：
 *   · 列表/详情走 drizzle 查询构造器 —— 传列对象，由构造器生成正确的表名限定；
 *   · 向量检索是手写 SQL —— 传 c.xxx 别名，与 pgvector.store 里的 SQL 对齐。
 * 早期版本统一用字符串别名 'f'，结果查询构造器生成的是 "files"."xxx"，
 * 别名对不上导致 SQL 报 missing FROM-clause entry for table "f"。用列对象可杜绝这类错。
 * ═══════════════════════════════════════════ */

type ColumnRef = SQL | PgColumn;

interface SecurityColumns {
  ownerId: ColumnRef;
  securityLevel: ColumnRef;
  visibleDeptIds: ColumnRef;
}

/** 判断当前用户是否需要受部门范围限制。返回 null 表示具备跨部门能力 */
function resolveRestrictDepts(ctx: AuthContext): string[] | null {
  if (hasPermission(ctx, PERMISSIONS.KB_CROSS_DEPT_SEARCH)) return null;
  return ctx.departmentId ? [ctx.departmentId] : [];
}

/** 文件列表、文件详情用的权限条件 */
export function buildFileSecurityCondition(ctx: AuthContext): SQL {
  return buildSecurityClause(
    {
      ownerId: schema.files.ownerId,
      securityLevel: schema.files.securityLevel,
      visibleDeptIds: schema.files.visibleDeptIds,
    },
    ctx.userId,
    resolveRestrictDepts(ctx),
  );
}

/** 切片检索用的权限条件（手写 SQL，表别名 c，与 pgvector.store 一致） */
export function buildChunkSecurityCondition(ctx: AuthContext): SQL {
  return buildSecurityClause(
    {
      ownerId: sql.raw('c.owner_id'),
      securityLevel: sql.raw('c.security_level'),
      visibleDeptIds: sql.raw('c.visible_dept_ids'),
    },
    ctx.userId,
    resolveRestrictDepts(ctx),
  );
}

/**
 * 生成密级过滤 SQL。
 * depts 为 null 表示具备跨部门能力，部门密级一律可见。
 */
function buildSecurityClause(cols: SecurityColumns, userId: string, depts: string[] | null): SQL {
  if (depts === null) {
    return sql`(
      ${cols.ownerId} = ${userId}::uuid
      OR ${cols.securityLevel} IN ('public','internal','department')
    )`;
  }

  if (depts.length === 0) {
    return sql`(
      ${cols.ownerId} = ${userId}::uuid
      OR ${cols.securityLevel} IN ('public','internal')
    )`;
  }

  const deptArray = sql`ARRAY[${sql.join(
    depts.map((d) => sql`${d}`),
    sql`, `,
  )}]::text[]`;
  return sql`(
    ${cols.ownerId} = ${userId}::uuid
    OR ${cols.securityLevel} IN ('public','internal')
    OR (${cols.securityLevel} = 'department' AND ${cols.visibleDeptIds} ?| ${deptArray})
  )`;
}
