import { tmpdir } from 'node:os';
import type { AuthContext } from '@kh/server-core';
import { AppError, ErrorCode, PERMISSIONS } from '@kh/shared';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { CurrentUser, RequirePermission } from '../../common/decorators/index.ts';
import { MAX_UPLOAD_FILES, uploadInterceptorOptions } from '../../common/upload.config.ts';
import { KnowledgeBasesService } from './knowledge-bases.service.ts';

@ApiTags('知识库')
@Controller('kb')
export class KnowledgeBasesController {
  constructor(@Inject(KnowledgeBasesService) private readonly kb: KnowledgeBasesService) {}

  @Get()
  @ApiOperation({ summary: '可见知识库列表' })
  list(@CurrentUser() ctx: AuthContext) {
    return this.kb.list(ctx);
  }

  @Post()
  @RequirePermission(PERMISSIONS.KB_MANAGE)
  @ApiOperation({ summary: '新建知识库' })
  create(
    @CurrentUser() ctx: AuthContext,
    @Body() body: { name: string; description?: string; isTeamSpace?: boolean; securityLevel?: string; visibleDeptIds?: string[] },
  ) {
    return this.kb.create(ctx, body);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.KB_MANAGE)
  @ApiOperation({ summary: '删除知识库（文件本体保留，仅脱离知识库）' })
  remove(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.kb.remove(ctx, id);
  }

  @Get(':id/tree')
  @ApiOperation({ summary: '库内文件树（文件夹 + 文件）' })
  tree(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.kb.tree(ctx, id);
  }

  @Post(':id/ingest')
  @RequirePermission(PERMISSIONS.KB_INGEST)
  @ApiOperation({ summary: '把文件纳入知识库（解析→切片→向量化）' })
  ingest(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { fileId: string; kbFolderId?: string | null }) {
    return this.kb.ingest(ctx, body.fileId, id, body.kbFolderId);
  }

  @Post(':id/ingest-files')
  @RequirePermission(PERMISSIONS.KB_INGEST)
  @ApiOperation({ summary: '批量纳入文件（文件管理侧勾选多个文件时用）' })
  ingestFiles(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { fileIds: string[]; kbFolderId?: string | null }) {
    return this.kb.ingestFiles(ctx, id, body.fileIds ?? [], body.kbFolderId);
  }

  @Post(':id/ingest-folder')
  @RequirePermission(PERMISSIONS.KB_INGEST)
  @ApiOperation({ summary: '纳入整个文件夹（在知识库里镜像出同名目录层级）' })
  ingestFolder(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { folderId: string; kbFolderId?: string | null }) {
    return this.kb.ingestFolder(ctx, id, body.folderId, body.kbFolderId);
  }

  @Post(':id/upload')
  @RequirePermission(PERMISSIONS.KB_INGEST)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '上传到知识库（支持多文件与整个文件夹，上传后自动解析入库）' })
  @UseInterceptors(
    FilesInterceptor('files', MAX_UPLOAD_FILES, {
      storage: diskStorage({ destination: tmpdir() }),
      ...uploadInterceptorOptions,
    }),
  )
  async upload(
    @CurrentUser() ctx: AuthContext,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { kbFolderId?: string; relPaths?: string[] | string },
  ) {
    if (!files?.length) throw new AppError(ErrorCode.BAD_REQUEST, { message: '没有收到文件' });
    const relPaths = body.relPaths == null ? [] : Array.isArray(body.relPaths) ? body.relPaths : [body.relPaths];
    return this.kb.uploadToKb(ctx, id, files, { kbFolderId: body.kbFolderId || null, relPaths });
  }

  /* ─────────── 库内目录 ─────────── */

  @Post(':id/folders')
  @RequirePermission(PERMISSIONS.KB_MANAGE)
  @ApiOperation({ summary: '在知识库内新建目录（parentId 为空则建在库根）' })
  createFolder(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { name: string; parentId?: string | null }) {
    return this.kb.createFolder(id, body);
  }

  @Delete(':id/folders/:folderId')
  @RequirePermission(PERMISSIONS.KB_MANAGE)
  @ApiOperation({ summary: '删除库内目录（含子目录；文件保留，只是脱离目录）' })
  removeFolder(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Param('folderId') folderId: string) {
    return this.kb.removeFolder(id, folderId);
  }

  @Patch(':id/files/:fileId/move')
  @RequirePermission(PERMISSIONS.KB_MANAGE)
  @ApiOperation({ summary: '调整文件在库内的目录位置（不影响文件本体）' })
  moveFile(
    @CurrentUser() ctx: AuthContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Body() body: { kbFolderId: string | null },
  ) {
    return this.kb.moveFileInKb(ctx, id, fileId, body.kbFolderId ?? null);
  }

  @Post(':id/search')
  @ApiOperation({ summary: '检索测试（不经过大模型，只看召回）' })
  search(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { query: string; topK?: number }) {
    return this.kb.search(ctx, id, body.query, body.topK ?? 5);
  }

  @Delete('files/:fileId')
  @ApiOperation({ summary: '把文件从知识库移除' })
  removeFile(@CurrentUser() ctx: AuthContext, @Param('fileId') fileId: string) {
    return this.kb.removeFile(ctx, fileId);
  }

  @Get('files/:fileId/preview')
  @ApiOperation({ summary: '预览文件内容（结构化 blocks）' })
  preview(@CurrentUser() ctx: AuthContext, @Param('fileId') fileId: string) {
    return this.kb.preview(ctx, fileId);
  }

  @Post(':id/documents')
  @RequirePermission(PERMISSIONS.KB_INGEST)
  @ApiOperation({ summary: '在知识库内新建文档（.md/.csv）并自动纳入' })
  createDocument(
    @CurrentUser() ctx: AuthContext,
    @Param('id') id: string,
    @Body() body: { name: string; content: string; extension?: 'md' | 'csv'; kbFolderId?: string | null },
  ) {
    return this.kb.createDocument(ctx, id, body);
  }
}
