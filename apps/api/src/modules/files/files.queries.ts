import { type AuthContext, buildFileSecurityCondition, type DbHandle, schema } from '@kh/server-core';
import type { FileItem, FileListQuery, Paginated } from '@kh/shared';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';

/**
 * 文件列表查询。
 *
 * 关键点：权限条件通过 buildFileSecurityCondition 拼进 WHERE，
 * 所以「无权文件」从查询阶段就不会进入结果集 —— 这比查出来再过滤安全得多。
 */
export async function queryFiles(handle: DbHandle, ctx: AuthContext, query: FileListQuery): Promise<Paginated<FileItem>> {
  const db = handle.db;
  const conditions: SQL[] = [];

  // 回收站视图与正常视图互斥
  conditions.push(query.trash ? isNotNull(schema.files.deletedAt) : isNull(schema.files.deletedAt));

  if (query.folderId) {
    conditions.push(eq(schema.files.folderId, query.folderId));
  }
  if (query.keyword) {
    conditions.push(ilike(schema.files.name, `%${query.keyword}%`));
  }
  if (query.securityLevel) {
    conditions.push(eq(schema.files.securityLevel, query.securityLevel));
  }
  if (query.kbId) {
    conditions.push(eq(schema.files.kbId, query.kbId));
  }
  if (query.onlyFavorite) {
    conditions.push(eq(schema.files.isFavorite, true));
  }
  if (query.onlyMine) {
    conditions.push(eq(schema.files.ownerId, ctx.userId));
  }

  // ★ 权限过滤
  conditions.push(buildFileSecurityCondition(ctx));

  const where = and(...conditions);
  const orderColumn =
    query.sortBy === 'name'
      ? schema.files.name
      : query.sortBy === 'size'
        ? schema.files.size
        : query.sortBy === 'createdAt'
          ? schema.files.createdAt
          : schema.files.updatedAt;
  const order = query.sortOrder === 'asc' ? asc(orderColumn) : desc(orderColumn);

  const totalRows = await db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.files).where(where);
  const total = Number(totalRows[0]?.n ?? 0);

  const rows = await db
    .select()
    .from(schema.files)
    .where(where)
    .orderBy(order)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  // 一次性把关联的名称取出来，避免每行都查一次
  const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
  const kbIds = [...new Set(rows.map((r) => r.kbId).filter((v): v is string => !!v))];
  const folderIds = [...new Set(rows.map((r) => r.folderId).filter((v): v is string => !!v))];

  const owners = ownerIds.length
    ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ownerIds))
    : [];
  const kbs = kbIds.length
    ? await db
        .select({
          id: schema.knowledgeBases.id,
          name: schema.knowledgeBases.name,
        })
        .from(schema.knowledgeBases)
        .where(inArray(schema.knowledgeBases.id, kbIds))
    : [];
  const folders = folderIds.length
    ? await db
        .select({ id: schema.folders.id, name: schema.folders.name })
        .from(schema.folders)
        .where(inArray(schema.folders.id, folderIds))
    : [];

  const ownerMap = new Map(owners.map((o) => [o.id, o.name]));
  const kbMap = new Map(kbs.map((k) => [k.id, k.name]));
  const folderMap = new Map(folders.map((f) => [f.id, f.name]));

  return {
    items: rows.map((r) => toFileItem(r, ownerMap, kbMap, folderMap)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** 组装前端使用的文件对象（对外不暴露 storage_key） */
export function toFileItem(
  row: typeof schema.files.$inferSelect,
  ownerMap?: Map<string, string>,
  kbMap?: Map<string, string>,
  folderMap?: Map<string, string>,
): FileItem {
  return {
    id: row.id,
    name: row.name,
    extension: row.extension,
    size: Number(row.size),
    mimeType: row.mimeType,
    // 注意：这里把 key 返回给业务层用于内部判断，控制器序列化时可剔除
    storageKey: row.storageKey,
    checksum: row.checksum,
    folderId: row.folderId,
    folderName: row.folderId ? (folderMap?.get(row.folderId) ?? null) : null,
    ownerId: row.ownerId,
    ownerName: ownerMap?.get(row.ownerId) ?? null,
    securityLevel: row.securityLevel as FileItem['securityLevel'],
    visibleDeptIds: row.visibleDeptIds ?? [],
    visibleUserIds: row.visibleUserIds ?? [],
    kbId: row.kbId,
    kbName: row.kbId ? (kbMap?.get(row.kbId) ?? null) : null,
    kbFolderId: row.kbFolderId,
    indexStatus: row.indexStatus as FileItem['indexStatus'],
    chunkCount: row.chunkCount,
    indexedAt: row.indexedAt?.toISOString() ?? null,
    version: row.version,
    isFavorite: row.isFavorite,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 存储用量统计（供工作台与管理后台用） */
export async function queryStorageUsage(handle: DbHandle, ctx: AuthContext) {
  const db = handle.db;
  const rows = await db
    .select({
      departmentId: schema.files.departmentId,
      bytes: sql<number>`COALESCE(SUM(${schema.files.size}), 0)::bigint`,
      files: sql<number>`COUNT(*)::int`,
    })
    .from(schema.files)
    .where(and(isNull(schema.files.deletedAt), buildFileSecurityCondition(ctx)))
    .groupBy(schema.files.departmentId);

  const deptIds = rows.map((r) => r.departmentId).filter((v): v is string => !!v);
  const depts = deptIds.length
    ? await db
        .select({ id: schema.departments.id, name: schema.departments.name })
        .from(schema.departments)
        .where(inArray(schema.departments.id, deptIds))
    : [];
  const deptMap = new Map(depts.map((d) => [d.id, d.name]));

  const byDepartment = rows.map((r) => ({
    departmentId: r.departmentId ?? '',
    departmentName: r.departmentId ? (deptMap.get(r.departmentId) ?? '未知部门') : '未归属',
    bytes: Number(r.bytes),
    files: Number(r.files),
  }));

  return {
    totalBytes: byDepartment.reduce((s, r) => s + r.bytes, 0),
    totalFiles: byDepartment.reduce((s, r) => s + r.files, 0),
    byDepartment,
    byKind: [] as { kind: string; bytes: number; files: number }[],
  };
}
