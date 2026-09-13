/**
 * 知识库 → 聚智平台文档同步服务。
 *
 * 同步触发方式：
 *   - 用户在知识库页点「同步」按钮 → controller 调 syncKb()
 *   - 全库同步（管理后台 / 计划任务） → syncAll()
 *
 * 流程（单文件）：
 *   1. 读 files 表里属于该 kb 的所有未删除文件
 *   2. 跟 kb_sync_records 比对 checksum：
 *        - 无记录 / checksum 变了 → 待上传
 *        - 已有记录且 checksum 一致 → 跳过（status='indexed'）
 *   3. 待上传文件顺序处理：
 *        - 用本地解析器抽文本 → 转成 markdown/纯文本
 *        - 调 kb.client.upload 上传
 *        - 成功：写记录 status='uploaded'，等平台解析完成后再由 cron 转 'indexed'
 *        - 失败：attempt += 1，达到 MAX_ATTEMPT 置 'failed'
 *
 * 安全细节：
 *   - 完全没文字（扫描件）直接跳过并标 'skipped'
 *   - 单文件上传独立限速（限速器在 kb.client 内部）
 *   - 解析出的内容里包含可识别的「原始 docx 二进制」是不允许的 —— 平台接口会出现「解析成功但 0 段落」
 */
import { AppError, ErrorCode, type ParsedDocument } from '@kh/shared';
import {
  getDocumentParser,
  getStorage,
  PlatformAgentClient,
  PlatformKbClient,
  schema,
} from '@kh/server-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';
import type { DbHandle } from '@kh/server-core';
import { PLATFORM_CONFIG_TOKEN, type PlatformConfig } from '../../config/platform.config.ts';
import {
  PLATFORM_AGENT_CLIENT_TOKEN,
  PLATFORM_KB_CLIENT_TOKEN,
} from './platform.tokens.ts';
import { AuditService } from '../audit/audit.service.ts';

const MAX_ATTEMPT = 3;
/** 把「本页文件数没动」视作成功 —— 同步的真正目标是有记录留痕，不是真的零线上传 */
const NOOP_OK = true;

export interface SyncSummary {
  kbId: string;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

@Injectable()
export class KbSyncService {
  private readonly logger = new Logger('KbSync');

  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    @Inject(PLATFORM_CONFIG_TOKEN) private readonly cfg: PlatformConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PLATFORM_KB_CLIENT_TOKEN) private readonly platformKb: PlatformKbClient | null,
    @Inject(PLATFORM_AGENT_CLIENT_TOKEN) private readonly platformAgent: PlatformAgentClient | null,
  ) {}

  private get db() {
    return this.handle.db;
  }
  private get storage() {
    return getStorage();
  }
  private get parser() {
    return getDocumentParser();
  }

  private ensureClient(): { kb: PlatformKbClient; agent: PlatformAgentClient } {
    if (!this.cfg.enabled) {
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
        message: '平台凭证未配置（PLATFORM_HOST/APP_ID/APP_SECRET），无法同步',
      });
    }
    return {
      kb: this.platformKb!,
      agent: this.platformAgent!,
    };
  }

  /**
   * 同步单个知识库。
   * 按文件 checksum 比对，只上传有差异或没记录的。
   */
  async syncKb(ctx: { userId: string }, kbId: string): Promise<SyncSummary> {
    const start = Date.now();
    const { kb: client } = this.ensureClient();

    const kb = await this.mustGetKb(kbId);
    if (!kb.platformLibId || !kb.platformCategoryId) {
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
        message: '该知识库未配置远程目标，请先填写 libId 和 categoryId',
      });
    }

    // 1) 取该库下未删除的所有 files
    const fileRows = await this.db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.kbId, kbId),
          isNull(schema.files.deletedAt),
          // 已索引（解析成功有切片的）且失败/无文字的也考虑 —— 失败/无文字的就 skip
          inArray(schema.files.indexStatus, ['indexed', 'no_text', 'failed', 'not_ingested']),
        ),
      );

    // 2) 取已有同步记录
    const existingRecs = await this.db
      .select()
      .from(schema.kbSyncRecords)
      .where(eq(schema.kbSyncRecords.kbId, kbId));
    const byFileId = new Map(existingRecs.map((r) => [r.fileId, r]));

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of fileRows) {
      const existing = byFileId.get(file.id);

      // 已存在 + checksum 一致 + 状态最终态（indexed/failed/skipped） → 跳过
      if (
        existing &&
        existing.checksum === file.checksum &&
        ['indexed', 'failed', 'skipped'].includes(existing.status)
      ) {
        unchanged += 1;
        continue;
      }

      // 没文字的文件（扫描件） → 标 skipped
      if (file.indexStatus === 'no_text') {
        await this.upsertRecord(kbId, file.id, file.checksum ?? '', {
          status: 'skipped',
          error: null,
          attempt: 0,
        });
        skipped += 1;
        continue;
      }

      // 解析没成功的（failed / not_ingested）也跳过 —— 等用户修了再重试
      if (file.indexStatus === 'failed' || file.indexStatus === 'not_ingested') {
        await this.upsertRecord(kbId, file.id, file.checksum ?? '', {
          status: 'skipped',
          error: file.parseError ?? '本地未解析',
        });
        skipped += 1;
        continue;
      }

      // 真正上传
      try {
        const content = await this.extractText(file);
        if (!content.trim()) {
          await this.upsertRecord(kbId, file.id, file.checksum ?? '', {
            status: 'skipped',
            error: '本地解析结果为空',
          });
          skipped += 1;
          continue;
        }

        const result = await client.upload({
          libId: kb.platformLibId,
          categoryId: kb.platformCategoryId,
          fileType: 'text',
          file: {
            name: file.name,
            data: new Blob([new TextEncoder().encode(content)], { type: 'text/markdown' }),
            mimeType: 'text/markdown',
          },
        });

        await this.upsertRecord(kbId, file.id, file.checksum ?? '', {
          status: 'uploaded',
          platformDocId: result.platformDocId,
          remoteParagraphs: result.paragraphs,
          error: null,
          attemptedAt: new Date(),
        });
        if (existing && existing.checksum !== file.checksum) updated += 1;
        else added += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const nextAttempt = (existing?.attempt ?? 0) + 1;
        const final = nextAttempt >= MAX_ATTEMPT;
        await this.upsertRecord(kbId, file.id, file.checksum ?? '', {
          status: final ? 'failed' : 'pending',
          error: message,
          attempt: nextAttempt,
          attemptedAt: new Date(),
        });
        failed += final ? 1 : 0;
        this.logger.warn(`同步 ${file.name} 失败（${nextAttempt}/${MAX_ATTEMPT}）：${message}`);
      }
    }

    // 写一次库最近同步时间
    await this.db
      .update(schema.knowledgeBases)
      .set({ platformLastSyncedAt: new Date() })
      .where(eq(schema.knowledgeBases.id, kbId));

    const summary: SyncSummary = {
      kbId,
      added,
      updated,
      unchanged,
      skipped,
      failed,
      durationMs: Date.now() - start,
    };

    if (ctx?.userId) {
      await this.audit.write({
        action: 'platform.kb_sync',
        actorId: ctx.userId,
        targetType: 'knowledge_base',
        targetId: kbId,
        targetName: kb.name,
        detail: summary as unknown as Record<string, unknown>,
      });
    }

    this.logger.log(
      `kb=${kb.name} +${added} ~${updated} =${unchanged} skip${skipped} fail${failed} (${summary.durationMs}ms)`,
    );

    return summary;
  }

  /**
   * 全库同步 —— 给定时任务 / 管理员后台用。
   * 一次最多处理 limit 个库，避免长事务。
   */
  async syncAll(ctx: { userId?: string }, opts: { limit?: number } = {}): Promise<{ processed: number; summary: SyncSummary[] }> {
    const limit = opts.limit ?? 25;
    const rows = await this.db
      .select({ id: schema.knowledgeBases.id })
      .from(schema.knowledgeBases)
      .where(
        and(
          isNull(schema.knowledgeBases.deletedAt),
          sql`${schema.knowledgeBases.platformLibId} IS NOT NULL`,
          sql`${schema.knowledgeBases.platformCategoryId} IS NOT NULL`,
        ),
      )
      .limit(limit);

    const summaries: SyncSummary[] = [];
    for (const r of rows) {
      try {
        summaries.push(await this.syncKb({ userId: ctx.userId ?? 'system' }, r.id));
      } catch (err) {
        this.logger.warn(`kb ${r.id} 同步失败：${(err as Error).message}`);
      }
    }
    return { processed: rows.length, summary: summaries };
  }

  /* ─────── 内部 ─────── */

  private async mustGetKb(id: string) {
    const rows = await this.db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.KB_NOT_FOUND, { message: '知识库不存在' });
    return row;
  }

  private async upsertRecord(
    kbId: string,
    fileId: string,
    checksum: string,
    patch: {
      status: 'pending' | 'uploaded' | 'indexed' | 'failed' | 'skipped';
      platformDocId?: string;
      remoteParagraphs?: number;
      error?: string | null;
      attempt?: number;
      attemptedAt?: Date;
    },
  ): Promise<void> {
    const values = {
      kbId,
      fileId,
      checksum,
      status: patch.status,
      platformDocId: patch.platformDocId ?? null,
      remoteParagraphs: patch.remoteParagraphs ?? 0,
      error: patch.error ?? null,
      attempt: patch.attempt ?? 0,
      attemptedAt: patch.attemptedAt ?? null,
      updatedAt: new Date(),
    } as const;

    await this.db
      .insert(schema.kbSyncRecords)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.kbSyncRecords.kbId, schema.kbSyncRecords.fileId],
        set: {
          checksum: values.checksum,
          status: values.status,
          platformDocId: values.platformDocId,
          remoteParagraphs: values.remoteParagraphs,
          error: values.error,
          attempt: values.attempt,
          attemptedAt: values.attemptedAt,
          updatedAt: values.updatedAt,
        },
      });
  }

  /** 从对象存储读取文件 → 解析 → 返回 markdown/text 形态的纯文本内容 */
  private async extractText(file: typeof schema.files.$inferSelect): Promise<string> {
    const bytes = await this.storage.get(file.storageKey);
    const doc: ParsedDocument = await this.parser.parse({ fileName: file.name, bytes });
    return serializeBlocks(doc);
  }
}

/**
 * 把解析器的 blocks 序列化成 markdown 风格的纯文本。
 * 平台 fileType=text 上传时不需要严格的 markdown，只要能解析就行。
 * 段落之间用两个换行分隔，h1-h3 用 # 标记。
 */
function serializeBlocks(doc: ParsedDocument): string {
  const out: string[] = [];
  for (const block of doc.blocks) {
    const heading = block.heading?.trim();
    if (heading) out.push(`## ${heading}`);
    const content = block.content.trim();
    if (content) out.push(content);
    if (block.page != null) out.push(`（第 ${block.page} 页）`);
  }
  return out.join('\n\n');
}

// 防止代码维护者误删
void NOOP_OK;
