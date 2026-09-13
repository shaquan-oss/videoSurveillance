import { randomUUID } from 'node:crypto';
import { type AuthContext, buildFileSecurityCondition, type DbHandle, getStorage, schema } from '@kh/server-core';
import { AppError, ErrorCode, type Folder, type SecurityLevel } from '@kh/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';

@Injectable()
export class FoldersService {
  constructor(@Inject(DB_TOKEN) private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  /** 列出可见文件夹（自己的 + 公开/内部 + 本部门可见的） */
  async list(ctx: AuthContext): Promise<Folder[]> {
    const rows = await this.db
      .select()
      .from(schema.folders)
      .where(
        and(
          isNull(schema.folders.deletedAt),
          sql`(
        ${schema.folders.ownerId} = ${ctx.userId}::uuid
        OR ${schema.folders.securityLevel} IN ('public','internal')
        OR (${schema.folders.securityLevel} = 'department'
            AND ${schema.folders.visibleDeptIds} ?| ARRAY[${sql.raw(ctx.departmentId ? `'${ctx.departmentId}'` : "''")}]::text[])
      )`,
        ),
      )
      .orderBy(schema.folders.name);

    const counts = await this.db
      .select({
        folderId: schema.files.folderId,
        n: sql<number>`COUNT(*)::int`,
        bytes: sql<number>`COALESCE(SUM(${schema.files.size}),0)::bigint`,
      })
      .from(schema.files)
      .where(isNull(schema.files.deletedAt))
      .groupBy(schema.files.folderId);

    const countMap = new Map(counts.map((c) => [c.folderId ?? '', { n: Number(c.n), bytes: Number(c.bytes) }]));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      ownerId: r.ownerId,
      departmentId: r.departmentId,
      securityLevel: r.securityLevel as SecurityLevel,
      visibleDeptIds: r.visibleDeptIds ?? [],
      fileCount: countMap.get(r.id)?.n ?? 0,
      totalSize: countMap.get(r.id)?.bytes ?? 0,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async create(ctx: AuthContext, input: { name: string; parentId?: string | null }): Promise<Folder> {
    const id = randomUUID();
    await this.db.insert(schema.folders).values({
      id,
      name: input.name,
      parentId: input.parentId ?? null,
      ownerId: ctx.userId,
      departmentId: ctx.departmentId,
      securityLevel: 'internal',
      visibleDeptIds: [],
    });
    const rows = await this.db.select().from(schema.folders).where(eq(schema.folders.id, id)).limit(1);
    const r = rows[0]!;
    return {
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      ownerId: r.ownerId,
      departmentId: r.departmentId,
      securityLevel: r.securityLevel as SecurityLevel,
      visibleDeptIds: r.visibleDeptIds ?? [],
      fileCount: 0,
      totalSize: 0,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async rename(ctx: AuthContext, id: string, name: string): Promise<void> {
    await this.mustOwn(ctx, id);
    await this.db.update(schema.folders).set({ name, updatedAt: new Date() }).where(eq(schema.folders.id, id));
  }

  /**
   * 删除文件夹。
   * default (force=false)：只删空文件夹；非空就拒绝。
   * force=true：递归删该文件夹 + 所有子文件夹 + 全部文件（含回收站也一起清干净），
   *              用于「我确实要整个连根拔」的强操作；前端必须二次确认。
   */
  async remove(ctx: AuthContext, id: string, force = false): Promise<{ removed: { folders: number; files: number } }> {
    await this.mustOwn(ctx, id);
    if (!force) {
      const n = await this.db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(schema.files)
        .where(and(eq(schema.files.folderId, id), isNull(schema.files.deletedAt)));
      if (Number(n[0]?.n ?? 0) > 0) {
        throw new AppError(ErrorCode.FOLDER_NOT_EMPTY, { message: '文件夹内还有文件，请先移出或删除' });
      }
      await this.db.update(schema.folders).set({ deletedAt: new Date() }).where(eq(schema.folders.id, id));
      return { removed: { folders: 1, files: 0 } };
    }

    // 级联：先收集该子树所有文件，然后整批删（避免一次一次 commit 慢）
    const folderIds = await this.collectDescendantIds(id);
    const fileRows = folderIds.length ? await this.db.select().from(schema.files).where(inArray(schema.files.folderId, folderIds)) : [];
    const storage = getStorage();

    // 先删存储里的对象（失败也不阻断——下面真删数据库时一并清理）
    for (const row of fileRows) {
      if (row.storageKey) {
        await storage.remove(row.storageKey).catch(() => undefined);
      }
    }
    // 删 chunks（先删，免得外键引用残留）
    if (fileRows.length) {
      const fileIdArr = fileRows.map((r) => r.id);
      await this.db.delete(schema.chunks).where(inArray(schema.chunks.fileId, fileIdArr));
      // 真删文件行
      await this.db.delete(schema.files).where(inArray(schema.files.id, fileIdArr));
    }
    // 软删所有相关文件夹（保留目录以便审计时回溯谁删的）
    if (folderIds.length) {
      await this.db.update(schema.folders).set({ deletedAt: new Date() }).where(inArray(schema.folders.id, folderIds));
    }
    return { removed: { folders: folderIds.length, files: fileRows.length } };
  }

  /** 逐层 BFS 收集一个 folder 的所有后代 id（含自己）。比 CTE 稳定，更易排错。 */
  private async collectDescendantIds(rootId: string): Promise<string[]> {
    const all: string[] = [rootId];
    let frontier: string[] = [rootId];
    let safety = 0;
    while (frontier.length > 0 && safety++ < 50) {
      const rows = await this.db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .where(and(inArray(schema.folders.parentId, frontier), isNull(schema.folders.deletedAt)));
      const next = rows.map((r) => r.id);
      if (next.length === 0) break;
      all.push(...next);
      frontier = next;
    }
    return all;
  }

  private async mustOwn(ctx: AuthContext, id: string) {
    const rows = await this.db.select().from(schema.folders).where(eq(schema.folders.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: '文件夹不存在' });
    if (row.ownerId !== ctx.userId) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '只能修改自己创建的文件夹' });
    }
  }
}
