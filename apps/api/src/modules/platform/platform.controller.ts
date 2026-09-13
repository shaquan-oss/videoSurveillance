/**
 * 平台同步与远程智能体的 HTTP 入口。
 *
 * 暴露：
 *   - POST /platform/kb/:id/sync       触发「同步到远程」（管理员或库主）
 *   - GET  /platform/sync-records/:kbId 列出该库同步记录，给前端表格用
 *   - POST /platform/agent/:id/test    远程智能体的连通性测试（不真正调用，省调用）
 */
import { AppError, ErrorCode } from '@kh/shared';
import { Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { type AuthContext, type DbHandle, schema } from '@kh/server-core';
import { DB_TOKEN } from '../../database/database.module.ts';
import { KbSyncService } from './kb-sync.service.ts';

@Controller('platform')
export class PlatformController {
  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    private readonly sync: KbSyncService,
  ) {}

  @Post('kb/:id/sync')
  async syncKb(@Req() req: { user: AuthContext }, @Param('id') kbId: string) {
    await this.assertKbWritable(req.user, kbId);
    return this.sync.syncKb({ userId: req.user.userId }, kbId);
  }

  @Get('sync-records/:kbId')
  async listSyncRecords(@Req() req: { user: AuthContext }, @Param('kbId') kbId: string) {
    await this.assertKbReadable(req.user, kbId);
    const rows = await this.handle.db
      .select({
        id: schema.kbSyncRecords.id,
        fileId: schema.kbSyncRecords.fileId,
        fileName: schema.files.name,
        checksum: schema.kbSyncRecords.checksum,
        platformDocId: schema.kbSyncRecords.platformDocId,
        remoteParagraphs: schema.kbSyncRecords.remoteParagraphs,
        status: schema.kbSyncRecords.status,
        error: schema.kbSyncRecords.error,
        attempt: schema.kbSyncRecords.attempt,
        attemptedAt: schema.kbSyncRecords.attemptedAt,
        syncedAt: schema.kbSyncRecords.syncedAt,
      })
      .from(schema.kbSyncRecords)
      .leftJoin(schema.files, eq(schema.files.id, schema.kbSyncRecords.fileId))
      .where(eq(schema.kbSyncRecords.kbId, kbId));

    return { items: rows };
  }

  private async mustGetKb(id: string) {
    const rows = await this.handle.db
      .select()
      .from(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.id, id), isNull(schema.knowledgeBases.deletedAt)))
      .limit(1);
    if (!rows[0]) throw new AppError(ErrorCode.KB_NOT_FOUND, { message: '知识库不存在' });
    return rows[0];
  }

  private async assertKbReadable(_ctx: AuthContext, kbId: string) {
    await this.mustGetKb(kbId);
  }

  private async assertKbWritable(ctx: AuthContext, kbId: string) {
    const kb = await this.mustGetKb(kbId);
    if (kb.ownerId !== ctx.userId) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '只有知识库所有者可以触发同步' });
    }
  }
}
