import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AuthContext } from '@kh/server-core';
import {
  batchIdsSchema,
  type FileListQuery,
  type FileMoveInput,
  type FileSecurityInput,
  fileListQuerySchema,
  fileMoveSchema,
  fileRenameSchema,
  fileSecuritySchema,
  folderCreateSchema,
  folderUpdateSchema,
  PERMISSIONS,
} from '@kh/shared';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { ClientInfo, CurrentUser, RequirePermission } from '../../common/decorators/index.ts';
import { zodPipe } from '../../common/pipes/zod-validation.pipe.ts';
import { MAX_UPLOAD_FILES, uploadInterceptorOptions } from '../../common/upload.config.ts';
import { AuditService } from '../audit/audit.service.ts';
import { FilesService } from './files.service.ts';
import { FoldersService } from './folders.service.ts';

@ApiTags('文件')
@Controller('files')
export class FilesController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(FoldersService) private readonly folders: FoldersService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ─────────── 列表与详情 ─────────── */

  @Get()
  @ApiOperation({ summary: '文件列表（自动按权限过滤）' })
  async list(@CurrentUser() ctx: AuthContext, @Query(zodPipe(fileListQuerySchema)) query: FileListQuery) {
    return this.files.list(ctx, query);
  }

  @Get('usage')
  @ApiOperation({ summary: '存储用量统计' })
  async usage(@CurrentUser() ctx: AuthContext) {
    return this.files.usage(ctx);
  }

  @Get(':id')
  @ApiOperation({ summary: '文件详情' })
  async detail(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.files.getOne(ctx, id);
  }

  @Get(':id/download-url')
  @RequirePermission(PERMISSIONS.FILE_DOWNLOAD)
  @ApiOperation({ summary: '取下载链接（权限校验后签发短时效地址）' })
  async downloadUrl(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @ClientInfo() client: { ip: string; userAgent: string }) {
    const result = await this.files.createDownloadUrl(ctx, id);
    await this.audit.write({
      action: 'file.download',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'file',
      targetId: id,
      // 记下文件名，复盘时不必再拿 ID 回查数据库
      targetName: result.name,
      ip: client.ip,
      userAgent: client.userAgent,
      success: true,
    });
    return result;
  }

  /* ─────────── 上传 ─────────── */

  @Post('upload')
  @RequirePermission(PERMISSIONS.FILE_UPLOAD)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '上传文件（支持一次多个，前端用 files 字段）' })
  @UseInterceptors(
    FilesInterceptor('files', MAX_UPLOAD_FILES, {
      storage: diskStorage({ destination: tmpdir() }),
      ...uploadInterceptorOptions,
    }),
  )
  async upload(
    @CurrentUser() ctx: AuthContext,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { folderId?: string; securityLevel?: string; visibleDeptIds?: string; relPaths?: string[] | string },
    @ClientInfo() client: { ip: string; userAgent: string },
  ) {
    if (!files || files.length === 0) {
      throw new Error('没有收到文件');
    }
    const meta = {
      folderId: body.folderId || null,
      securityLevel: (body.securityLevel as never) || 'internal',
      visibleDeptIds: body.visibleDeptIds ? body.visibleDeptIds.split(',').filter(Boolean) : [],
    };

    // multer 对重复字段会收集成数组；单值时是字符串。统一成数组，且与 files 顺序对齐。
    const relPaths = body.relPaths == null ? [] : Array.isArray(body.relPaths) ? body.relPaths : [body.relPaths];

    try {
      const { results, okCount, failCount } = await this.files.uploadMany(
        ctx,
        files,
        meta,
        {
          readFile,
          unlink,
        },
        relPaths,
      );

      // 审计：成功的那批逐个留痕
      for (const r of results) {
        if (r.ok && r.file) {
          await this.audit.write({
            action: 'file.upload',
            actorId: ctx.userId,
            actorName: ctx.userName,
            targetType: 'file',
            targetId: r.file.id,
            targetName: r.file.name,
            detail: { size: r.file.size, securityLevel: r.file.securityLevel },
            ip: client.ip,
            userAgent: client.userAgent,
            success: true,
          });
        }
      }

      return { results, okCount, failCount };
    } finally {
      // 无论成败都要清掉临时文件，避免磁盘被占满
      for (const f of files) {
        if (f.path) await unlink(f.path).catch(() => undefined);
      }
    }
  }

  @Get(':id/preview-url')
  @ApiOperation({ summary: '取预览链接（inline 直接打开，用于「查看」）' })
  async previewUrl(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.files.createPreviewUrl(ctx, id);
  }

  /* ─────────── 修改 ─────────── */

  @Patch(':id/rename')
  @ApiOperation({ summary: '重命名' })
  async rename(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body(zodPipe(fileRenameSchema)) body: { name: string }) {
    return this.files.rename(ctx, id, body.name);
  }

  @Patch(':id/security')
  @ApiOperation({ summary: '设置密级与可见范围' })
  async security(
    @CurrentUser() ctx: AuthContext,
    @Param('id') id: string,
    @Body(zodPipe(fileSecuritySchema)) body: FileSecurityInput,
    @ClientInfo() client: { ip: string; userAgent: string },
  ) {
    const before = await this.files.getOne(ctx, id);
    const updated = await this.files.updateSecurity(ctx, id, body);
    await this.audit.write({
      action: 'file.security_change',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'file',
      targetId: id,
      targetName: updated.name,
      detail: { from: before.securityLevel, to: updated.securityLevel, visibleDeptIds: updated.visibleDeptIds },
      ip: client.ip,
      userAgent: client.userAgent,
      success: true,
    });
    return updated;
  }

  @Patch(':id/favorite')
  @ApiOperation({ summary: '收藏 / 取消收藏' })
  async favorite(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { value: boolean }) {
    return this.files.toggleFavorite(ctx, id, !!body.value);
  }

  /* ─────────── 删除与恢复 ─────────── */

  @Delete(':id')
  @ApiOperation({ summary: '移入回收站' })
  async remove(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @ClientInfo() client: { ip: string; userAgent: string }) {
    const item = await this.files.getOne(ctx, id);
    await this.files.softDelete(ctx, id);
    await this.audit.write({
      action: 'file.delete',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'file',
      targetId: id,
      targetName: item.name,
      ip: client.ip,
      userAgent: client.userAgent,
      success: true,
    });
    return { ok: true };
  }

  @Post(':id/restore')
  @ApiOperation({ summary: '从回收站恢复' })
  async restore(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @ClientInfo() client: { ip: string; userAgent: string }) {
    await this.files.restore(ctx, id);
    await this.audit.write({
      action: 'file.restore',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'file',
      targetId: id,
      ip: client.ip,
      userAgent: client.userAgent,
      success: true,
    });
    return { ok: true };
  }

  /* ─────────── 移动 ─────────── */

  @Patch(':id/move')
  @ApiOperation({ summary: '移动文件到指定文件夹（folderId 为 null 表示移到顶级）' })
  async move(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body(zodPipe(fileMoveSchema)) body: FileMoveInput) {
    return this.files.move(ctx, id, body.folderId ?? null);
  }

  @Post('batch/move')
  @ApiOperation({ summary: '批量移动文件' })
  async batchMove(@CurrentUser() ctx: AuthContext, @Body() body: { ids: string[]; folderId: string | null }) {
    return this.files.moveMany(ctx, body.ids ?? [], body.folderId ?? null);
  }

  /* ─────────── 永久删除（清空回收站）─────────── */

  @Delete(':id/purge')
  @ApiOperation({ summary: '从回收站彻底删除（真删对象存储）' })
  async purge(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @ClientInfo() client: { ip: string; userAgent: string }) {
    await this.files.purge(ctx, id);
    await this.audit.write({
      action: 'file.purge',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'file',
      targetId: id,
      ip: client.ip,
      userAgent: client.userAgent,
      success: true,
    });
    return { ok: true };
  }

  @Post('purge-all')
  @ApiOperation({ summary: '清空当前用户可见范围内的回收站' })
  async purgeAll(@CurrentUser() ctx: AuthContext, @ClientInfo() client: { ip: string; userAgent: string }) {
    const { removed } = await this.files.purgeTrash(ctx);
    await this.audit.write({
      action: 'file.purge_all',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'file',
      detail: { removed },
      ip: client.ip,
      userAgent: client.userAgent,
      success: true,
    });
    return { removed };
  }

  /* ─────────── 文件夹 ─────────── */

  @Get('folders/all')
  @ApiOperation({ summary: '文件夹列表' })
  async listFolders(@CurrentUser() ctx: AuthContext) {
    return this.folders.list(ctx);
  }

  @Post('folders')
  @ApiOperation({ summary: '新建文件夹' })
  async createFolder(@CurrentUser() ctx: AuthContext, @Body(zodPipe(folderCreateSchema)) body: { name: string; parentId?: string | null }) {
    return this.folders.create(ctx, body);
  }

  @Patch('folders/:id')
  @ApiOperation({ summary: '修改文件夹' })
  async updateFolder(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body(zodPipe(folderUpdateSchema)) body: { name?: string }) {
    if (body.name) await this.folders.rename(ctx, id, body.name);
    return { ok: true };
  }

  @Delete('folders/:id')
  @ApiOperation({ summary: '删除文件夹（默认要求为空；?force=true 强制删除文件夹及所有内容）' })
  async removeFolder(
    @CurrentUser() ctx: AuthContext,
    @Param('id') id: string,
    @Query('force') force?: string,
    @ClientInfo() client: { ip: string; userAgent: string } = { ip: '', userAgent: '' },
  ) {
    const result = await this.folders.remove(ctx, id, force === 'true');
    await this.audit.write({
      action: force === 'true' ? 'folder.cascade_delete' : 'folder.delete',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'folder',
      targetId: id,
      detail: result.removed,
      ip: client.ip,
      userAgent: client.userAgent,
      success: true,
    });
    return result;
  }

  /* ─────────── 批量 ─────────── */

  @Post('batch/delete')
  @ApiOperation({ summary: '批量移入回收站' })
  async batchDelete(@CurrentUser() ctx: AuthContext, @Body(zodPipe(batchIdsSchema)) body: { ids: string[] }) {
    const results: { id: string; ok: boolean; reason?: string }[] = [];
    for (const id of body.ids) {
      try {
        await this.files.softDelete(ctx, id);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, reason: (err as Error).message });
      }
    }
    return { results, okCount: results.filter((r) => r.ok).length };
  }
}
