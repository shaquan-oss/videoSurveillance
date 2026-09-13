import type { AuthContext } from '@kh/server-core';
import { type ChatRequest, PERMISSIONS } from '@kh/shared';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, RequirePermission } from '../../common/decorators/index.ts';
import { ConversationsService } from './conversations.service.ts';

@ApiTags('对话')
@Controller('conversations')
export class ConversationsController {
  constructor(@Inject(ConversationsService) private readonly conv: ConversationsService) {}

  @Get()
  @ApiOperation({ summary: '我的会话列表' })
  list(@CurrentUser() ctx: AuthContext) {
    return this.conv.list(ctx);
  }

  @Post()
  @ApiOperation({ summary: '新建会话' })
  create(@CurrentUser() ctx: AuthContext, @Body() body: { modelKey?: string; scopeKbIds?: string[] }) {
    return this.conv.create(ctx, body);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: '会话消息列表' })
  messages(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.conv.getMessages(ctx, id);
  }

  @Post('ask')
  @RequirePermission(PERMISSIONS.AGENT_USE)
  @ApiOperation({ summary: '提问（检索 + 带引用回答）' })
  ask(@CurrentUser() ctx: AuthContext, @Body() body: ChatRequest) {
    return this.conv.ask(ctx, body);
  }

  /**
   * 流式问答（SSE）。
   * 这里必须直接持有 Response 自己写流 —— Nest 的响应拦截器会把返回值包成统一 JSON，
   * 那样前端就拿不到逐字输出。事件格式见 shared 的 AskEvent。
   */
  @Post('ask/stream')
  @RequirePermission(PERMISSIONS.AGENT_USE)
  @ApiOperation({ summary: '提问（流式返回，事件流）' })
  async askStream(@CurrentUser() ctx: AuthContext, @Body() body: ChatRequest, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 关掉 nginx 之类的缓冲，否则「流式」会变成一次性返回
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      for await (const event of this.conv.askStream(ctx, body)) send(event);
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : '问答失败' });
    } finally {
      res.end();
    }
  }

  @Post('messages/:messageId/feedback')
  @ApiOperation({ summary: '回答反馈（赞/踩）' })
  feedback(
    @CurrentUser() ctx: AuthContext,
    @Param('messageId') messageId: string,
    @Body() body: { value: 'up' | 'down'; reason?: string },
  ) {
    return this.conv.feedback(ctx, messageId, body.value, body.reason);
  }

  @Patch(':id/rename')
  @ApiOperation({ summary: '重命名会话' })
  rename(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { title: string }) {
    return this.conv.rename(ctx, id, body.title);
  }

  @Post(':id/pin')
  @ApiOperation({ summary: '置顶 / 取消置顶' })
  pin(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.conv.togglePin(ctx, id);
  }

  @Post(':id/favorite')
  @ApiOperation({ summary: '收藏 / 取消收藏' })
  favorite(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.conv.toggleFavorite(ctx, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除会话' })
  remove(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.conv.remove(ctx, id);
  }
}
