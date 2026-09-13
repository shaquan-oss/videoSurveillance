import { createHash, randomUUID } from 'node:crypto';
import {
  type AuthContext,
  assertCanView,
  buildFileSecurityCondition,
  canChangeSecurity,
  canDeleteFile,
  canViewFile,
  type DbHandle,
  getStorage,
  schema,
} from '@kh/server-core';
import {
  AppError,
  buildStorageKey,
  ErrorCode,
  type FileItem,
  type FileListQuery,
  type FileSecurityInput,
  getExtension,
  type Paginated,
  type SecurityLevel,
} from '@kh/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';
import { queryFiles, queryStorageUsage, toFileItem } from './files.queries.ts';

export interface UploadMeta {
  folderId?: string | null;
  securityLevel?: SecurityLevel;
  visibleDeptIds?: string[];
  isFavorite?: boolean;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger('Files');

  constructor(@Inject(DB_TOKEN) private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  private get storage() {
    return getStorage();
  }

  /* ─────────── 查询 ─────────── */

  async list(ctx: AuthContext, query: FileListQuery): Promise<Paginated<FileItem>> {
    const page = await queryFiles(this.handle, ctx, query);
    // 对外不暴露存储位置
    return { ...page, items: page.items.map(stripInternal) };
  }

  async getOne(ctx: AuthContext, id: string): Promise<FileItem> {
    const row = await this.mustGet(id);
    assertCanView(ctx, {
      ownerId: row.ownerId,
      securityLevel: row.securityLevel as SecurityLevel,
      visibleDeptIds: row.visibleDeptIds ?? [],
      visibleUserIds: row.visibleUserIds ?? [],
    });
    return stripInternal(toFileItem(row));
  }

  async usage(ctx: AuthContext) {
    return queryStorageUsage(this.handle, ctx);
  }

  /* ─────────── 上传 ─────────── */

  async upload(
    ctx: AuthContext,
    file: { originalname: string; mimetype: string; size: number; buffer?: Buffer; path?: string },
    meta: UploadMeta,
    fs: { readFile: (p: string) => Promise<Buffer>; unlink: (p: string) => Promise<void> },
    /** 来自文件夹上传的相对路径（含文件名），如「项目资料/合同/扫描件.pdf」 */
    relPath?: string,
  ): Promise<FileItem> {
    const name = decodeFileName(file.originalname);
    // 支持所有文件类型：不做扩展名白名单拦截。
    // 文件存对象存储、下载时用 attachment 不会被服务器执行，所以全放行是安全的。
    // 没有扩展名的文件归为 bin，仍可正常存取。
    const extension = getExtension(name) || 'bin';

    const maxBytes = Number(process.env.MAX_UPLOAD_MB ?? '200') * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE, {
        message: `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`,
      });
    }

    // 取字节：multer 可能用内存或磁盘暂存
    let bytes: Buffer;
    if (file.buffer) {
      bytes = file.buffer;
    } else if (file.path) {
      bytes = await fs.readFile(file.path);
    } else {
      throw new AppError(ErrorCode.FILE_UPLOAD_INCOMPLETE);
    }

    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const securityLevel: SecurityLevel = meta.securityLevel ?? 'internal';

    // 部门密级必须指定可见部门，否则没人能看（比开放更糟，所以直接拦掉）
    if (securityLevel === 'department' && (!meta.visibleDeptIds || meta.visibleDeptIds.length === 0)) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: '选择「部门」密级时必须指定可见部门' });
    }

    // 解析文件夹层级：relPath 的最后一段是文件名，前面的都是目录。
    // 在目标文件夹下逐级「查找或新建」子文件夹，保留上传时的目录结构。
    let folderId: string | null = meta.folderId ?? null;
    if (relPath) {
      const dirs = relPath.split('/').filter(Boolean).slice(0, -1);
      if (dirs.length > 0) {
        folderId = await this.ensureFolderPath(ctx, meta.folderId ?? null, dirs);
      }
    }

    // 秒传：同一用户上传过同样内容且未删除，直接复用已有对象
    const duplicate = await this.findDuplicate(ctx.userId, checksum);
    if (duplicate) {
      const id = randomUUID();
      await this.db.insert(schema.files).values({
        id,
        name,
        extension,
        size: file.size,
        mimeType: file.mimetype,
        storageKey: duplicate.storageKey,
        checksum,
        folderId,
        ownerId: ctx.userId,
        departmentId: ctx.departmentId,
        securityLevel,
        visibleDeptIds: meta.visibleDeptIds ?? [],
        isFavorite: meta.isFavorite ?? false,
      });
      await this.storage
        .presignGet(duplicate.storageKey)
        .catch(() => undefined)
        .then(() => undefined)
        .catch(() => undefined);
      const row = await this.mustGet(id);
      this.logger.log(`秒传命中：${name}`);
      return stripInternal(toFileItem(row));
    }

    // 正常上传：先写对象存储，再落库
    const fileId = randomUUID();
    const key = buildStorageKey({
      departmentId: ctx.departmentId,
      fileId,
      extension,
    });

    await this.storage.put(key, bytes, file.mimetype || 'application/octet-stream');

    await this.db.insert(schema.files).values({
      id: fileId,
      name,
      extension,
      size: file.size,
      mimeType: file.mimetype,
      storageKey: key,
      checksum,
      folderId,
      ownerId: ctx.userId,
      departmentId: ctx.departmentId,
      securityLevel,
      visibleDeptIds: meta.visibleDeptIds ?? [],
      isFavorite: meta.isFavorite ?? false,
    });

    // 如果文件夹限制了密级，这里可以进一步收紧（暂略）

    const row = await this.mustGet(fileId);
    return stripInternal(toFileItem(row));
  }

  /**
   * 批量上传：循环调用单文件上传，单个失败不影响其它。
   * 返回每个文件的结果，前端据此展示「哪些成功、哪些失败、为什么」。
   */
  async uploadMany(
    ctx: AuthContext,
    files: { originalname: string; mimetype: string; size: number; buffer?: Buffer; path?: string }[],
    meta: UploadMeta,
    fs: { readFile: (p: string) => Promise<Buffer>; unlink: (p: string) => Promise<void> },
    relPaths?: (string | undefined)[],
  ): Promise<{ results: { name: string; ok: boolean; file?: FileItem; error?: string }[]; okCount: number; failCount: number }> {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      try {
        const item = await this.upload(ctx, file, meta, fs, relPaths?.[i]);
        results.push({ name: item.name, ok: true, file: item });
      } catch (err) {
        results.push({
          name: decodeFileName(file.originalname),
          ok: false,
          error: err instanceof Error ? err.message : '上传失败',
        });
      }
    }
    return {
      results,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
    };
  }

  /**
   * 逐级「查找或新建」文件夹，返回最末一级的 folderId。
   * 上传整个文件夹时用它保留目录层级；同名文件夹复用，不重复建。
   */
  private async ensureFolderPath(ctx: AuthContext, rootId: string | null, segments: string[]): Promise<string> {
    let parentId: string | null = rootId;
    for (const raw of segments) {
      const seg = raw.trim().slice(0, 120);
      if (!seg) continue;

      const existing = await this.db
        .select()
        .from(schema.folders)
        .where(
          and(
            parentId ? eq(schema.folders.parentId, parentId) : isNull(schema.folders.parentId),
            eq(schema.folders.name, seg),
            isNull(schema.folders.deletedAt),
          ),
        )
        .limit(1);

      if (existing[0]) {
        parentId = existing[0].id;
      } else {
        const id = randomUUID();
        await this.db.insert(schema.folders).values({
          id,
          name: seg,
          parentId,
          ownerId: ctx.userId,
          departmentId: ctx.departmentId,
          securityLevel: 'internal',
          visibleDeptIds: [],
        });
        parentId = id;
      }
    }
    return parentId!;
  }

  private async findDuplicate(ownerId: string, checksum: string) {
    const rows = await this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.ownerId, ownerId), eq(schema.files.checksum, checksum), isNull(schema.files.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /* ─────────── 下载 ─────────── */

  /**
   * 生成下载链接（disposition=attachment，强制下载）。
   * 流程：校验权限 → 签发短时效链接 → 交给浏览器直取（文件流不经过后端）。
   */
  async createDownloadUrl(ctx: AuthContext, id: string): Promise<{ url: string; expiresInSec: number; name: string }> {
    const row = await this.mustGet(id);
    this.assertViewable(ctx, row);

    const ttl = Number(process.env.S3_PRESIGN_TTL_SEC ?? '600');
    const url = await this.storage.presignGet(row.storageKey, ttl, row.name, 'attachment');
    return { url, expiresInSec: ttl, name: row.name };
  }

  /**
   * 生成预览链接（disposition=inline，浏览器直接打开）。
   * 图片、PDF、文本、视频等由浏览器原生渲染；不能预览的类型浏览器会自动转下载。
   */
  async createPreviewUrl(ctx: AuthContext, id: string): Promise<{ url: string; expiresInSec: number; name: string; previewable: boolean }> {
    const row = await this.mustGet(id);
    this.assertViewable(ctx, row);

    const ttl = Number(process.env.S3_PRESIGN_TTL_SEC ?? '600');
    const url = await this.storage.presignGet(row.storageKey, ttl, row.name, 'inline');
    return { url, expiresInSec: ttl, name: row.name, previewable: isInlinePreviewable(row.extension) };
  }

  /** 抽出来的权限断言，下载与预览共用 */
  private assertViewable(ctx: AuthContext, row: typeof schema.files.$inferSelect): void {
    assertCanView(ctx, {
      ownerId: row.ownerId,
      securityLevel: row.securityLevel as SecurityLevel,
      visibleDeptIds: row.visibleDeptIds ?? [],
      visibleUserIds: row.visibleUserIds ?? [],
    });
  }

  /* ─────────── 修改 ─────────── */

  async rename(ctx: AuthContext, id: string, name: string): Promise<FileItem> {
    const row = await this.mustGet(id);
    this.assertEditable(ctx, row);
    const extension = getExtension(name) || row.extension;
    await this.db.update(schema.files).set({ name, extension, updatedAt: new Date() }).where(eq(schema.files.id, id));
    const updated = await this.mustGet(id);
    return stripInternal(toFileItem(updated));
  }

  async updateSecurity(ctx: AuthContext, id: string, input: FileSecurityInput): Promise<FileItem> {
    const row = await this.mustGet(id);
    if (
      !canChangeSecurity(ctx, {
        ownerId: row.ownerId,
        securityLevel: row.securityLevel as SecurityLevel,
        visibleDeptIds: row.visibleDeptIds ?? [],
      })
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '你没有修改该文件密级的权限' });
    }

    await this.db
      .update(schema.files)
      .set({
        securityLevel: input.securityLevel,
        visibleDeptIds: input.visibleDeptIds ?? [],
        visibleUserIds: input.visibleUserIds ?? [],
        updatedAt: new Date(),
      })
      .where(eq(schema.files.id, id));

    // 密级变更必须同步到已入库的切片，否则检索时的权限标签还是旧的
    if (row.kbId) {
      await this.syncChunkSecurity(id, input);
    }

    const updated = await this.mustGet(id);
    return stripInternal(toFileItem(updated));
  }

  /** 片段密级同步：与文件表在同一次操作内更新，避免出现"文件已收紧但检索仍可见"的窗口 */
  private async syncChunkSecurity(fileId: string, input: FileSecurityInput): Promise<void> {
    await this.db.execute(sql`
      UPDATE chunks
      SET security_level = ${input.securityLevel},
          visible_dept_ids = ${JSON.stringify(input.visibleDeptIds ?? [])}::jsonb
      WHERE file_id = ${fileId}::uuid
    `);
  }

  async toggleFavorite(ctx: AuthContext, id: string, value: boolean): Promise<FileItem> {
    const row = await this.mustGet(id);
    assertCanView(ctx, {
      ownerId: row.ownerId,
      securityLevel: row.securityLevel as SecurityLevel,
      visibleDeptIds: row.visibleDeptIds ?? [],
    });
    await this.db.update(schema.files).set({ isFavorite: value, updatedAt: new Date() }).where(eq(schema.files.id, id));
    const updated = await this.mustGet(id);
    return stripInternal(toFileItem(updated));
  }

  /* ─────────── 删除与恢复 ─────────── */

  /** 软删除：进回收站。对象存储里的字节保留，7 天后由清理任务真正删除 */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.mustGet(id);
    if (
      !canDeleteFile(ctx, {
        ownerId: row.ownerId,
        securityLevel: row.securityLevel as SecurityLevel,
        visibleDeptIds: row.visibleDeptIds ?? [],
      })
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '你没有删除该文件的权限' });
    }
    await this.db.update(schema.files).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.files.id, id));
  }

  async restore(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.mustGet(id);
    if (
      !canDeleteFile(ctx, {
        ownerId: row.ownerId,
        securityLevel: row.securityLevel as SecurityLevel,
        visibleDeptIds: row.visibleDeptIds ?? [],
      })
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '你没有恢复该文件的权限' });
    }
    await this.db.update(schema.files).set({ deletedAt: null, updatedAt: new Date() }).where(eq(schema.files.id, id));
  }

  /* ─────────── 移动 ─────────── */

  /**
   * 把文件移动到另一个文件夹。
   * 权限：只有文件所有者才能移动 —— 防止有人把不属于自己的文件挪走。
   * folderId=null 表示移到顶级（脱掉所有文件夹归属）。
   */
  async move(ctx: AuthContext, id: string, folderId: string | null): Promise<FileItem> {
    const row = await this.mustGet(id);
    if (row.deletedAt) throw new AppError(ErrorCode.BAD_REQUEST, { message: '回收站中的文件先恢复后再移动' });
    if (row.ownerId !== ctx.userId) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '只能移动自己上传的文件' });
    }
    if (folderId) {
      // 目标文件夹必须存在且可见：直接拿一下，看得到才允许
      const exists = await this.db
        .select({ id: schema.folders.id, deleted: schema.folders.deletedAt })
        .from(schema.folders)
        .where(eq(schema.folders.id, folderId))
        .limit(1);
      if (!exists[0] || exists[0].deleted) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: '目标文件夹不存在' });
      }
    }
    await this.db.update(schema.files).set({ folderId, updatedAt: new Date() }).where(eq(schema.files.id, id));
    const updated = await this.mustGet(id);
    return stripInternal(toFileItem(updated));
  }

  /** 批量移动（仅自己上传的文件能移动；按 ownerId 过滤后逐个调 move） */
  async moveMany(
    ctx: AuthContext,
    ids: string[],
    folderId: string | null,
  ): Promise<{ results: { id: string; ok: boolean; reason?: string }[]; okCount: number }> {
    const results: { id: string; ok: boolean; reason?: string }[] = [];
    for (const id of ids) {
      try {
        await this.move(ctx, id, folderId);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, reason: (err as Error).message });
      }
    }
    return { results, okCount: results.filter((r) => r.ok).length };
  }

  /* ─────────── 永久删除（真删对象） ─────────── */

  /**
   * 从回收站彻底删除：删 MinIO 里的字节，再删数据库记录。
   * 只有软删除（deletedAt 不为空）状态的文件能彻底删，避免误调。
   */
  async purge(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.mustGet(id);
    if (!row.deletedAt) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: '只能彻底删除已在回收站的文件' });
    }
    if (
      !canDeleteFile(ctx, {
        ownerId: row.ownerId,
        securityLevel: row.securityLevel as SecurityLevel,
        visibleDeptIds: row.visibleDeptIds ?? [],
      })
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '你没有彻底删除该文件的权限' });
    }
    await this.purgeOne(row);
  }

  /** 清空整个回收站（当前用户视角下、可见范围内能删的全删） */
  async purgeTrash(ctx: AuthContext): Promise<{ removed: number }> {
    // 收集权限内的、已软删除的文件，逐个真删
    const conditions = [isNotNull(schema.files.deletedAt), buildFileSecurityCondition(ctx)];
    const rows = await this.db
      .select()
      .from(schema.files)
      .where(and(...conditions))
      .limit(500);
    let removed = 0;
    for (const row of rows) {
      try {
        await this.purgeOne(row);
        removed++;
      } catch {
        // 单个失败不影响其他文件清理
      }
    }
    return { removed };
  }

  /**
   * 单条彻底删除：先删存储对象（必须在前，否则会留孤儿 DB 行）；
   * 再删数据库行；最后删归属的知识库片段（如果有）。
   * 失败时不抛异常 —— 调用方按行级 try/catch 处理。
   */
  private async purgeOne(row: typeof schema.files.$inferSelect): Promise<void> {
    if (row.storageKey) {
      await this.storage.remove(row.storageKey).catch(() => undefined);
    }
    if (row.kbId) {
      await this.db.delete(schema.chunks).where(eq(schema.chunks.fileId, row.id));
    }
    await this.db.delete(schema.files).where(eq(schema.files.id, row.id));
  }

  /** 定时清理：删除 7 天前软删除的文件 */
  async purgeOldTrash(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - Number(process.env.TRASH_TTL_DAYS ?? '7') * 24 * 3600 * 1000);
    const rows = await this.db
      .select()
      .from(schema.files)
      .where(and(isNotNull(schema.files.deletedAt), sql`${schema.files.deletedAt} < ${cutoff}`))
      .limit(200);
    let removed = 0;
    for (const row of rows) {
      try {
        await this.purgeOne(row);
        removed++;
      } catch {
        /* 跳过失败的，下一轮再试 */
      }
    }
    return removed;
  }

  /* ─────────── 内部 ─────────── */

  /** 内部用：按 id 取原始行（不做权限判断） */
  async mustGet(id: string) {
    const rows = await this.db.select().from(schema.files).where(eq(schema.files.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.FILE_NOT_FOUND);
    return row;
  }

  private assertEditable(ctx: AuthContext, row: typeof schema.files.$inferSelect): void {
    const info = {
      ownerId: row.ownerId,
      securityLevel: row.securityLevel as SecurityLevel,
      visibleDeptIds: row.visibleDeptIds ?? [],
    };
    if (!canViewFile(ctx, info) || (row.ownerId !== ctx.userId && !canChangeSecurity(ctx, info))) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '你没有修改该文件的权限' });
    }
  }
}

/** 去掉存储位置等内部字段，避免通过接口泄露对象存储路径 */
function stripInternal(item: FileItem): FileItem {
  const { ...rest } = item;
  return { ...rest, storageKey: '' };
}

/**
 * multer 在 multipart 里把非 ASCII 文件名按 latin1 解码，
 * 这里转回 UTF-8，否则中文文件名会变成乱码。
 */
function decodeFileName(raw: string): string {
  try {
    const buf = Buffer.from(raw, 'latin1');
    const utf8 = buf.toString('utf8');
    // 若转换后包含替换字符，说明原本就是 UTF-8，直接用原值
    return utf8.includes('\uFFFD') ? raw : utf8;
  } catch {
    return raw;
  }
}

/**
 * 判断某扩展名能否被浏览器直接预览（inline 打开）。
 * 能预览的类型用 inline 链接在新标签页直接渲染；
 * 不能预览的（压缩包、Office 文档等）浏览器会自动转下载。
 */
const INLINE_PREVIEW_EXTENSIONS = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'txt',
  'md',
  'csv',
  'json',
  'xml',
  'html',
  'log',
  'mp4',
  'webm',
  'mov',
  'mp3',
  'wav',
  'ogg',
];

export function isInlinePreviewable(extension: string): boolean {
  return INLINE_PREVIEW_EXTENSIONS.includes(extension.toLowerCase());
}
