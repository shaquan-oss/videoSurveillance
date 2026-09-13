import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import {
  type AuthContext,
  buildPermissionFilter,
  canIngestToKb,
  canViewFile,
  chunkDocument,
  type DbHandle,
  getDocumentParser,
  getModelGateway,
  getStorage,
  getVectorStore,
  retrieve,
  schema,
} from '@kh/server-core';
import {
  AppError,
  ErrorCode,
  type FileItem,
  type KbFolder,
  type KbTreeFile,
  type KnowledgeBase,
  type ParsedDocument,
  type RetrievalDebugInfo,
  type SecurityLevel,
} from '@kh/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';
import { toFileItem } from '../files/files.queries.ts';
import { FilesService } from '../files/files.service.ts';

const EMBED_BATCH_SIZE = 16;

/** 无文字层文件的提示语：解析、纳入、预览三处共用，避免各写一句不一致 */
const NO_TEXT_HINT = '文件里没有可提取的文字（疑似扫描件或纯图片），请先做 OCR 再重新上传';

@Injectable()
export class KnowledgeBasesService {
  private readonly logger = new Logger('KnowledgeBases');

  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  private get db() {
    return this.handle.db;
  }
  private get vector() {
    return getVectorStore(this.handle.db);
  }
  private get model() {
    return getModelGateway();
  }
  private get parser() {
    return getDocumentParser();
  }
  private get storage() {
    return getStorage();
  }

  /* ─────────── 知识库 CRUD ─────────── */

  /**
   * 列出知识库：返回可见的 + 不在我的可见范围但存在的（申请权限用）。
   * 锁定库只暴露 name + fileCount，不暴露可见范围等敏感字段，避免信息泄露。
   */
  async list(ctx: AuthContext): Promise<{ visible: KnowledgeBase[]; locked: { name: string; fileCount: number }[] }> {
    const rows = await this.db
      .select()
      .from(schema.knowledgeBases)
      .where(isNull(schema.knowledgeBases.deletedAt))
      .orderBy(schema.knowledgeBases.createdAt);

    const visible = rows.filter(
      (r) =>
        r.ownerId === ctx.userId ||
        r.isTeamSpace ||
        r.securityLevel === 'public' ||
        r.securityLevel === 'internal' ||
        (r.securityLevel === 'department' && ctx.departmentId && (r.visibleDeptIds ?? []).includes(ctx.departmentId)),
    );
    const lockedRows = rows.filter((r) => !visible.includes(r));

    const fileStats = await this.fileCounts(visible.map((r) => r.id));
    const chunkStats = await this.chunkCounts(visible.map((r) => r.id));

    return {
      visible: visible.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description ?? null,
        ownerId: r.ownerId,
        securityLevel: r.securityLevel as KnowledgeBase['securityLevel'],
        visibleDeptIds: r.visibleDeptIds ?? [],
        fileCount: fileStats.get(r.id) ?? 0,
        chunkCount: chunkStats.get(r.id) ?? 0,
        isTeamSpace: r.isTeamSpace,
        createdAt: r.createdAt.toISOString(),
      })),
      locked: await Promise.all(
        lockedRows.map(async (r) => ({
          name: r.name,
          fileCount: (await this.fileCounts([r.id])).get(r.id) ?? 0,
        })),
      ),
    };
  }

  private async fileCounts(kbIds: string[]): Promise<Map<string, number>> {
    if (kbIds.length === 0) return new Map();
    const rows = await this.db
      .select({ kbId: schema.files.kbId, n: sql<number>`COUNT(*)::int` })
      .from(schema.files)
      .where(and(inArray(schema.files.kbId, kbIds), isNull(schema.files.deletedAt)))
      .groupBy(schema.files.kbId);
    return new Map(rows.map((r) => [r.kbId!, Number(r.n)]));
  }

  private async chunkCounts(kbIds: string[]): Promise<Map<string, number>> {
    if (kbIds.length === 0) return new Map();
    const rows = await this.db
      .select({ kbId: schema.chunks.kbId, n: sql<number>`COUNT(*)::int` })
      .from(schema.chunks)
      .where(inArray(schema.chunks.kbId, kbIds))
      .groupBy(schema.chunks.kbId);
    return new Map(rows.map((r) => [r.kbId, Number(r.n)]));
  }

  async create(
    ctx: AuthContext,
    input: { name: string; description?: string; isTeamSpace?: boolean; securityLevel?: string; visibleDeptIds?: string[] },
  ): Promise<KnowledgeBase> {
    const id = randomUUID();
    await this.db.insert(schema.knowledgeBases).values({
      id,
      name: input.name,
      description: input.description ?? null,
      ownerId: ctx.userId,
      departmentId: ctx.departmentId,
      securityLevel: (input.securityLevel as never) ?? 'internal',
      visibleDeptIds: input.visibleDeptIds ?? [],
      isTeamSpace: input.isTeamSpace ?? false,
    });
    const row = await this.mustGetKb(id);
    return this.toKnowledgeBase(row);
  }

  /** 删除知识库：连同库内切片一起真删（文件本体保留在对象存储，只是脱离知识库） */
  async remove(ctx: AuthContext, kbId: string): Promise<void> {
    const kb = await this.mustGetKb(kbId);
    if (kb.ownerId !== ctx.userId) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '只能删除自己创建的知识库' });
    }
    await this.db.delete(schema.chunks).where(eq(schema.chunks.kbId, kbId));
    await this.db
      .update(schema.files)
      .set({ kbId: null, kbFolderId: null, indexStatus: 'not_ingested', chunkCount: 0, indexedAt: null })
      .where(eq(schema.files.kbId, kbId));
    await this.db.update(schema.knowledgeBases).set({ deletedAt: new Date() }).where(eq(schema.knowledgeBases.id, kbId));
  }

  /* ─────────── 库内文件树 ─────────── */

  async tree(ctx: AuthContext, kbId: string): Promise<{ folders: KbFolder[]; files: KbTreeFile[] }> {
    const kb = await this.mustGetKb(kbId);
    this.assertKbViewable(ctx, kb);

    const folders = await this.db
      .select()
      .from(schema.kbFolders)
      .where(and(eq(schema.kbFolders.kbId, kbId), isNull(schema.kbFolders.deletedAt)))
      .orderBy(schema.kbFolders.sortOrder, schema.kbFolders.createdAt);

    const files = await this.db
      .select({
        file: schema.files,
        ownerName: schema.users.name,
      })
      .from(schema.files)
      .leftJoin(schema.users, eq(schema.users.id, schema.files.ownerId))
      .where(and(eq(schema.files.kbId, kbId), isNull(schema.files.deletedAt)))
      .orderBy(schema.files.updatedAt);

    const counts = countFilesPerFolder(
      folders,
      files.map((r) => r.file.kbFolderId),
    );

    return {
      folders: folders.map((f) => ({
        id: f.id,
        kbId: f.kbId,
        name: f.name,
        parentId: f.parentId,
        sortOrder: f.sortOrder,
        fileCount: counts.get(f.id) ?? 0,
      })),
      files: files.map(({ file: f, ownerName }) => ({
        id: f.id,
        name: f.name,
        extension: f.extension,
        size: Number(f.size),
        indexStatus: f.indexStatus as KbTreeFile['indexStatus'],
        chunkCount: f.chunkCount,
        kbFolderId: f.kbFolderId,
        securityLevel: f.securityLevel as KbTreeFile['securityLevel'],
        ownerName: ownerName ?? null,
        updatedAt: f.updatedAt.toISOString(),
      })),
    };
  }

  /* ─────────── 库内目录（新建 / 重命名 / 删除）─────────── */

  async createFolder(kbId: string, input: { name: string; parentId?: string | null }): Promise<KbFolder> {
    await this.mustGetKb(kbId);
    if (input.parentId) {
      const parent = await this.mustGetFolder(input.parentId);
      if (parent.kbId !== kbId) throw new AppError(ErrorCode.NOT_FOUND, { message: '上级目录不存在' });
    }

    const id = randomUUID();
    const name = input.name.trim();
    await this.db.insert(schema.kbFolders).values({
      id,
      kbId,
      name,
      parentId: input.parentId ?? null,
      sortOrder: 0,
    });
    return { id, kbId, name, parentId: input.parentId ?? null, sortOrder: 0, fileCount: 0 };
  }

  async removeFolder(kbId: string, folderId: string): Promise<void> {
    await this.mustGetKb(kbId);
    const folder = await this.mustGetFolder(folderId);
    if (folder.kbId !== kbId) throw new AppError(ErrorCode.NOT_FOUND, { message: '目录不存在' });

    // 递归收集子目录，一并软删除（库内文件保留，只是脱离这个目录）
    const all = await this.db
      .select({ id: schema.kbFolders.id, parentId: schema.kbFolders.parentId })
      .from(schema.kbFolders)
      .where(and(eq(schema.kbFolders.kbId, kbId), isNull(schema.kbFolders.deletedAt)));

    const ids: string[] = [];
    const walk = (id: string) => {
      ids.push(id);
      for (const child of all.filter((f) => f.parentId === id)) walk(child.id);
    };
    walk(folderId);

    await this.db.update(schema.kbFolders).set({ deletedAt: new Date() }).where(inArray(schema.kbFolders.id, ids));
    await this.db
      .update(schema.files)
      .set({ kbFolderId: null })
      .where(and(eq(schema.files.kbId, kbId), inArray(schema.files.kbFolderId, ids)));
  }

  private async mustGetFolder(id: string) {
    const rows = await this.db.select().from(schema.kbFolders).where(eq(schema.kbFolders.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: '目录不存在' });
    return row;
  }

  /** 逐级查找或创建知识库内目录，返回最末一级的 id（上传保留层级时用） */
  private async ensureFolderPath(kbId: string, segments: string[], rootId: string | null): Promise<string | null> {
    let parentId = rootId;
    for (const name of segments) {
      const existing = await this.db
        .select({ id: schema.kbFolders.id })
        .from(schema.kbFolders)
        .where(
          and(
            eq(schema.kbFolders.kbId, kbId),
            eq(schema.kbFolders.name, name),
            parentId ? eq(schema.kbFolders.parentId, parentId) : isNull(schema.kbFolders.parentId),
            isNull(schema.kbFolders.deletedAt),
          ),
        )
        .limit(1);
      if (existing[0]) {
        parentId = existing[0].id;
        continue;
      }
      const created = await this.createFolder(kbId, { name, parentId });
      parentId = created.id;
    }
    return parentId;
  }

  /* ─────────── 纳入知识库（解析 → 切片 → 向量化）─────────── */

  /**
   * 切片 → 向量化 → 写切片表，返回写入条数。
   *
   * 没有任何切片时抛 NoTextError：那是「解析成功但一个字都没出来」（扫描件、纯图片），
   * 和「解析失败」的处置方式完全不同 —— 前者要提示做 OCR，后者要排查解析器，
   * 所以用专门的错误类型区分，不能混成一种状态。
   */
  private async embedAndStore(
    fileId: string,
    kbId: string,
    doc: ParsedDocument,
    meta: { securityLevel: SecurityLevel; visibleDeptIds: string[]; ownerId: string },
  ): Promise<number> {
    const chunks = chunkDocument(doc);
    if (chunks.length === 0) throw new NoTextError();

    // 先删旧切片（重复纳入时避免残留），再批量向量化入库
    await this.vector.removeByFile(fileId);

    let written = 0;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await this.model.embed(batch.map((c) => c.content));
      await this.vector.upsert(
        batch.map((c, j) => ({
          id: randomUUID(),
          fileId,
          kbId,
          content: c.content,
          embedding: embeddings[j]!,
          chunkIndex: i + j,
          page: c.page ?? null,
          securityLevel: meta.securityLevel,
          visibleDeptIds: meta.visibleDeptIds,
          ownerId: meta.ownerId,
        })),
      );
      written += batch.length;
    }
    return written;
  }

  async ingest(
    ctx: AuthContext,
    fileId: string,
    kbId: string,
    /** 库内目标目录；不传则保持在库根（或原地不动） */
    kbFolderId?: string | null,
  ): Promise<{ ok: boolean; chunkCount: number }> {
    await this.mustGetKb(kbId);
    const row = await this.mustGetFile(fileId);
    const check = canIngestToKb(ctx, {
      ownerId: row.ownerId,
      securityLevel: row.securityLevel as FileItem['securityLevel'],
      visibleDeptIds: row.visibleDeptIds ?? [],
    });
    if (!check.ok) throw new AppError(ErrorCode.FORBIDDEN, { message: check.reason });

    if (!this.parser.extensions.includes(row.extension)) {
      throw new AppError(ErrorCode.KB_UNSUPPORTED_FORMAT, { message: `暂不支持解析 .${row.extension} 文件` });
    }

    await this.db.update(schema.files).set({ indexStatus: 'parsing', parseError: null }).where(eq(schema.files.id, fileId));

    const targetFolder = kbFolderId === undefined ? row.kbFolderId : kbFolderId;

    try {
      const bytes = await this.storage.get(row.storageKey);
      const doc = await this.parser.parse({ fileName: row.name, bytes });
      const written = await this.embedAndStore(fileId, kbId, doc, {
        securityLevel: row.securityLevel as FileItem['securityLevel'],
        visibleDeptIds: row.visibleDeptIds ?? [],
        ownerId: row.ownerId,
      });

      await this.db
        .update(schema.files)
        .set({
          kbId,
          kbFolderId: targetFolder,
          indexStatus: 'indexed',
          chunkCount: written,
          indexedAt: new Date(),
        })
        .where(eq(schema.files.id, fileId));

      return { ok: true, chunkCount: written };
    } catch (err) {
      const noText = err instanceof NoTextError;
      const message = err instanceof Error ? err.message : '解析失败';
      await this.db
        .update(schema.files)
        .set({
          // 无文字层的文件也要纳入并留在库里：让用户看到它、知道要 OCR，
          // 比标成「已索引」然后怎么都搜不到要好。
          kbId,
          kbFolderId: targetFolder,
          indexStatus: noText ? 'no_text' : 'failed',
          chunkCount: 0,
          indexedAt: null,
          parseError: message,
        })
        .where(eq(schema.files.id, fileId));
      this.logger.warn(`${noText ? '未解析出文字' : '纳入知识库失败'} ${row.name}: ${message}`);
      throw new AppError(ErrorCode.KB_INGEST_FAILED, { message });
    }
  }

  /* ─────────── 从文件管理纳入（单个 / 批量 / 整个文件夹）─────────── */

  /**
   * 上传到知识库：文件先按统一规则落到对象存储（文件管理里也能看到），
   * 再按上传时的相对路径在库内建好目录，最后自动解析入库 —— 一步到位。
   */
  async uploadToKb(
    ctx: AuthContext,
    kbId: string,
    files: Express.Multer.File[],
    opts: { kbFolderId?: string | null; relPaths: (string | undefined)[]; securityLevel?: SecurityLevel },
  ): Promise<{
    okCount: number;
    failCount: number;
    results: { name: string; ok: boolean; fileId?: string; chunkCount?: number; error?: string }[];
  }> {
    await this.mustGetKb(kbId);

    const uploaded = await this.files.uploadMany(
      ctx,
      files,
      { securityLevel: opts.securityLevel ?? 'internal' },
      { readFile, unlink },
      opts.relPaths,
    );

    const results: { name: string; ok: boolean; fileId?: string; chunkCount?: number; error?: string }[] = [];
    for (let i = 0; i < uploaded.results.length; i++) {
      const r = uploaded.results[i]!;
      if (!r.ok || !r.file) {
        results.push({ name: r.name, ok: false, error: r.error });
        continue;
      }
      // relPath 末段是文件名，前面都是库内目录
      const dirs = (opts.relPaths[i] ?? '').split('/').filter(Boolean).slice(0, -1);
      const folderId = dirs.length ? await this.ensureFolderPath(kbId, dirs, opts.kbFolderId ?? null) : (opts.kbFolderId ?? null);
      try {
        const { chunkCount } = await this.ingest(ctx, r.file.id, kbId, folderId);
        results.push({ name: r.name, ok: true, fileId: r.file.id, chunkCount });
      } catch (err) {
        results.push({ name: r.name, ok: false, fileId: r.file.id, error: err instanceof Error ? err.message : '解析失败' });
      }
    }
    return {
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /** 逐个纳入一批文件，返回每个文件的成败（部分失败不影响其余） */
  async ingestFiles(
    ctx: AuthContext,
    kbId: string,
    fileIds: string[],
    kbFolderId?: string | null,
  ): Promise<{ okCount: number; failCount: number; results: { fileId: string; name: string; ok: boolean; error?: string }[] }> {
    const results: { fileId: string; name: string; ok: boolean; error?: string }[] = [];
    for (const fileId of fileIds) {
      const row = await this.mustGetFile(fileId).catch(() => null);
      if (!row) {
        results.push({ fileId, name: fileId, ok: false, error: '文件不存在' });
        continue;
      }
      try {
        await this.ingest(ctx, fileId, kbId, kbFolderId);
        results.push({ fileId, name: row.name, ok: true });
      } catch (err) {
        results.push({ fileId, name: row.name, ok: false, error: err instanceof Error ? err.message : '纳入失败' });
      }
    }
    return {
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /**
   * 纳入整个文件管理文件夹：在知识库里镜像出同名目录层级，再逐个纳入其中的文件。
   * 与原型一致 —— 纳入文件夹后，知识库里出现的就是文件夹。
   */
  async ingestFolder(
    ctx: AuthContext,
    kbId: string,
    folderId: string,
    targetKbFolderId?: string | null,
  ): Promise<{ okCount: number; failCount: number; folderCount: number }> {
    await this.mustGetKb(kbId);
    const source = await this.mustGetFileFolder(folderId);

    const allFolders = await this.db
      .select({ id: schema.folders.id, name: schema.folders.name, parentId: schema.folders.parentId })
      .from(schema.folders)
      .where(isNull(schema.folders.deletedAt));
    const byId = new Map(allFolders.map((f) => [f.id, f]));

    // 从被纳入的文件夹往下递归：每个目录在知识库里对应建一级
    const kbFolderOf = new Map<string, string>();
    const rootCreated = await this.createFolder(kbId, { name: source.name, parentId: targetKbFolderId ?? null });
    kbFolderOf.set(folderId, rootCreated.id);

    let folderCount = 1;
    const queue = [folderId];
    while (queue.length) {
      const current = queue.shift()!;
      const children = allFolders.filter((f) => f.parentId === current);
      if (children.length) {
        const parentKbFolder = kbFolderOf.get(current)!;
        for (const child of children) {
          const created = await this.createFolder(kbId, { name: child.name, parentId: parentKbFolder });
          kbFolderOf.set(child.id, created.id);
          folderCount++;
        }
      }
      queue.push(...children.map((c) => c.id));
    }

    // 取这些目录（含自身）下的全部文件，按所在目录归位后逐个纳入
    const rows = await this.db
      .select({ id: schema.files.id, folderId: schema.files.folderId })
      .from(schema.files)
      .where(and(isNull(schema.files.deletedAt), inArray(schema.files.folderId, [...kbFolderOf.keys()])));

    let okCount = 0;
    let failCount = 0;
    for (const row of rows) {
      try {
        await this.ingest(ctx, row.id, kbId, row.folderId ? (kbFolderOf.get(row.folderId) ?? null) : null);
        okCount++;
      } catch {
        failCount++;
      }
    }
    return { okCount, failCount, folderCount };
  }

  /** 把已纳入的文件在库内挪到另一个目录（不改变文件本身位置） */
  async moveFileInKb(ctx: AuthContext, kbId: string, fileId: string, kbFolderId: string | null): Promise<void> {
    const row = await this.mustGetFile(fileId);
    if (row.kbId !== kbId) throw new AppError(ErrorCode.KB_NOT_FOUND, { message: '该文件不在这个知识库里' });
    if (kbFolderId) {
      const folder = await this.mustGetFolder(kbFolderId);
      if (folder.kbId !== kbId) throw new AppError(ErrorCode.NOT_FOUND, { message: '目标目录不存在' });
    }
    await this.db.update(schema.files).set({ kbFolderId }).where(eq(schema.files.id, fileId));
  }

  private async mustGetFileFolder(id: string) {
    const rows = await this.db.select().from(schema.folders).where(eq(schema.folders.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: '文件夹不存在' });
    return row;
  }

  /* ─────────── 检索测试 ─────────── */

  async search(ctx: AuthContext, kbId: string, query: string, topK = 5): Promise<RetrievalDebugInfo> {
    const started = Date.now();
    const hits = await retrieve({
      store: this.vector,
      query,
      filter: buildPermissionFilter(ctx),
      kbIds: [kbId],
      topK,
    });
    return {
      query,
      scopeKbIds: [kbId],
      blockedFileCount: 0,
      hits,
      elapsedMs: Date.now() - started,
    };
  }

  /* ─────────── 文件预览 ─────────── */

  /**
   * 预览文件：始终重新解析（保证结构和原始文件一致），返回结构化 blocks
   * 供前端按 h3 + ul 渲染。索引异常时回退到按 chunks 拼接。
   */
  async preview(
    ctx: AuthContext,
    fileId: string,
  ): Promise<{
    name: string;
    extension: string;
    indexed: boolean;
    blocks: { heading?: string; content: string; page?: number | null }[];
  }> {
    const row = await this.mustGetFile(fileId);
    if (
      !canViewFile(ctx, {
        ownerId: row.ownerId,
        securityLevel: row.securityLevel as FileItem['securityLevel'],
        visibleDeptIds: row.visibleDeptIds ?? [],
      })
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '你没有查看该文件的权限' });
    }
    if (row.storageKey && this.parser.extensions.includes(row.extension)) {
      try {
        const bytes = await this.storage.get(row.storageKey);
        const doc = await this.parser.parse({ fileName: row.name, bytes });
        // 解析不出文字的文件（扫描件）直接说明原因，别让用户对着空白面板猜
        if (doc.blocks.length === 0) {
          return { name: row.name, extension: row.extension, indexed: false, blocks: [{ content: NO_TEXT_HINT }] };
        }
        return { name: row.name, extension: row.extension, indexed: row.indexStatus === 'indexed', blocks: doc.blocks };
      } catch {
        // 重新解析失败时回退
      }
    }
    if (row.indexStatus !== 'indexed') {
      return {
        name: row.name,
        extension: row.extension,
        indexed: false,
        blocks: [{ content: row.indexStatus === 'no_text' ? NO_TEXT_HINT : '尚未纳入解析' }],
      };
    }
    const chunks = await this.db
      .select({ content: schema.chunks.content })
      .from(schema.chunks)
      .where(eq(schema.chunks.fileId, fileId))
      .orderBy(schema.chunks.chunkIndex);
    return {
      name: row.name,
      extension: row.extension,
      indexed: true,
      blocks: chunks.map((c) => ({ content: c.content })),
    };
  }

  /**
   * 在知识库内新建一份文档（.md 或 .csv）：
   * 建 file 行 → 写对象存储 → 解析 → 切片 → 向量化 → 纳入。
   * 对应原型 newMenu 的「新建文档（.md）/新建表格（.csv）」。
   */
  async createDocument(
    ctx: AuthContext,
    kbId: string,
    input: { name: string; content: string; extension?: 'md' | 'csv'; kbFolderId?: string | null },
  ): Promise<FileItem> {
    await this.mustGetKb(kbId);
    const ext = input.extension ?? 'md';
    const fileName = input.name.endsWith(`.${ext}`) ? input.name : `${input.name}.${ext}`;
    const bytes = new TextEncoder().encode(input.content);
    const fileId = randomUUID();
    const now = new Date();
    const storageKey = `kb/${ctx.userId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${fileId}.${ext}`;
    await this.storage.put(storageKey, bytes, ext === 'md' ? 'text/markdown' : 'text/csv');
    await this.db.insert(schema.files).values({
      id: fileId,
      name: fileName,
      extension: ext,
      size: bytes.length,
      mimeType: ext === 'md' ? 'text/markdown' : 'text/csv',
      storageKey,
      ownerId: ctx.userId,
      departmentId: ctx.departmentId,
      securityLevel: 'internal',
      visibleDeptIds: [],
      kbId,
      kbFolderId: input.kbFolderId ?? null,
      indexStatus: 'parsing',
    });
    const created = await this.mustGetFile(fileId);
    try {
      const doc = await this.parser.parse({ fileName: created.name, bytes });
      const written = await this.embedAndStore(fileId, kbId, doc, {
        securityLevel: 'internal',
        visibleDeptIds: [],
        ownerId: ctx.userId,
      });
      await this.db
        .update(schema.files)
        .set({ indexStatus: 'indexed', chunkCount: written, indexedAt: new Date() })
        .where(eq(schema.files.id, fileId));
    } catch (err) {
      const noText = err instanceof NoTextError;
      await this.db
        .update(schema.files)
        .set({ indexStatus: noText ? 'no_text' : 'failed', parseError: err instanceof Error ? err.message : '解析失败' })
        .where(eq(schema.files.id, fileId));
      throw err;
    }
    return toFileItem(await this.mustGetFile(fileId));
  }

  /* ─────────── 从知识库移除 ─────────── */

  async removeFile(ctx: AuthContext, fileId: string): Promise<void> {
    const row = await this.mustGetFile(fileId);
    if (row.ownerId !== ctx.userId) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '只能移除自己纳入的文件' });
    }
    await this.vector.removeByFile(fileId);
    await this.db
      .update(schema.files)
      .set({ kbId: null, kbFolderId: null, indexStatus: 'not_ingested', chunkCount: 0, indexedAt: null })
      .where(eq(schema.files.id, fileId));
  }

  /* ─────────── 内部 ─────────── */

  private async mustGetKb(id: string) {
    const rows = await this.db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.KB_NOT_FOUND, { message: '知识库不存在' });
    return row;
  }

  private async mustGetFile(id: string) {
    const rows = await this.db.select().from(schema.files).where(eq(schema.files.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.FILE_NOT_FOUND, { message: '文件不存在' });
    return row;
  }

  private assertKbViewable(ctx: AuthContext, kb: typeof schema.knowledgeBases.$inferSelect): void {
    if (
      !canViewFile(ctx, {
        ownerId: kb.ownerId,
        securityLevel: kb.securityLevel as FileItem['securityLevel'],
        visibleDeptIds: kb.visibleDeptIds ?? [],
      })
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '你没有查看该知识库的权限' });
    }
  }

  private toKnowledgeBase(r: typeof schema.knowledgeBases.$inferSelect): KnowledgeBase {
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      ownerId: r.ownerId,
      securityLevel: r.securityLevel as KnowledgeBase['securityLevel'],
      visibleDeptIds: r.visibleDeptIds ?? [],
      fileCount: 0,
      chunkCount: 0,
      isTeamSpace: r.isTeamSpace,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

/**
 * 统计每个文件夹下的文件数（含所有后代），供左栏目录树显示「N 项」。
 * 纯函数：先按直接归属计数，再自底向上把子文件夹的计数累加到父级。
 */
function countFilesPerFolder(folders: { id: string; parentId: string | null }[], folderIds: (string | null)[]): Map<string, number> {
  const byParent = new Map<string | null, string[]>();
  for (const f of folders) {
    const siblings = byParent.get(f.parentId) ?? [];
    siblings.push(f.id);
    byParent.set(f.parentId, siblings);
  }

  const direct = new Map<string, number>();
  for (const id of folderIds) {
    if (id) direct.set(id, (direct.get(id) ?? 0) + 1);
  }

  const memo = new Map<string, number>();
  const countOf = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    let total = direct.get(id) ?? 0;
    for (const child of byParent.get(id) ?? []) total += countOf(child);
    memo.set(id, total);
    return total;
  };

  for (const f of folders) countOf(f.id);
  return memo;
}

/**
 * 解析成功但没有任何文字可入库（扫描件 / 纯图片）。
 * 用专门的错误类型，避免被上层当成「解析失败」—— 两者的排查方向完全不同。
 */
class NoTextError extends Error {
  constructor() {
    super(NO_TEXT_HINT);
  }
}
