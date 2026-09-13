import type { AuthContext } from '@kh/server-core';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/index.ts';
import { type MailDraftInput, MailService } from './mail.service.ts';

@ApiTags('邮件')
@Controller('mail')
export class MailController {
  constructor(@Inject(MailService) private readonly mail: MailService) {}

  @Get()
  @ApiOperation({ summary: '我的邮件草稿与发送记录' })
  list(@CurrentUser() ctx: AuthContext) {
    return this.mail.list(ctx);
  }

  @Get('status')
  @ApiOperation({ summary: '邮件服务是否已配置' })
  status() {
    return { configured: this.mail.isConfigured() };
  }

  @Post()
  @ApiOperation({ summary: '起草邮件（不会发送）' })
  create(@CurrentUser() ctx: AuthContext, @Body() body: MailDraftInput) {
    return this.mail.createDraft(ctx, body);
  }

  @Get(':id')
  @ApiOperation({ summary: '查看草稿' })
  get(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.mail.get(ctx, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改草稿措辞' })
  update(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: Partial<MailDraftInput>) {
    return this.mail.update(ctx, id, body);
  }

  @Post(':id/send')
  @ApiOperation({ summary: '确认发送（外发动作的最终一步，只能由人触发）' })
  send(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.mail.send(ctx, id);
  }

  @Get(':id/eml')
  @ApiOperation({ summary: '导出 .eml（未配置邮件服务时的兜底出口）' })
  async eml(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Res() res: Response) {
    const content = await this.mail.toEml(ctx, id);
    res.setHeader('Content-Type', 'message/rfc822; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mail.eml"');
    res.send(content);
  }

  @Delete(':id')
  @ApiOperation({ summary: '丢弃草稿' })
  remove(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.mail.remove(ctx, id);
  }
}
