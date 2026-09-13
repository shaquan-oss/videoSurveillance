import type { AuthContext } from '@kh/server-core';
import { PERMISSIONS } from '@kh/shared';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../common/decorators/index.ts';
import { type SkillInput, SkillsService } from './skills.service.ts';

@ApiTags('技能')
@Controller('skills')
export class SkillsController {
  constructor(@Inject(SkillsService) private readonly skills: SkillsService) {}

  @Get()
  @ApiOperation({ summary: '技能列表（已上架 + 我上传的）' })
  list(@CurrentUser() ctx: AuthContext) {
    return this.skills.list(ctx);
  }

  /** 装配技能时的候选列表：只要已上架的 */
  @Get('published')
  @ApiOperation({ summary: '已上架技能（供智能体装配）' })
  published(@CurrentUser() ctx: AuthContext) {
    return this.skills.published(ctx);
  }

  /** 运行时按触发词匹配（对话里 / 调技能、自动推荐用） */
  @Get('match')
  @ApiOperation({ summary: '按触发词匹配技能' })
  match(@CurrentUser() ctx: AuthContext, @Query('text') text: string) {
    return this.skills.matchByTrigger(ctx, text ?? '');
  }

  @Post()
  @RequirePermission(PERMISSIONS.SKILL_UPLOAD)
  @ApiOperation({ summary: '新建技能（会做安全扫描，通过后进入待审核）' })
  create(@CurrentUser() ctx: AuthContext, @Body() body: SkillInput) {
    return this.skills.create(ctx, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改技能' })
  update(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: Partial<SkillInput>) {
    return this.skills.update(ctx, id, body);
  }

  @Post(':id/review')
  @RequirePermission(PERMISSIONS.SKILL_REVIEW)
  @ApiOperation({ summary: '审核技能' })
  review(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { approve: boolean }) {
    return this.skills.review(ctx, id, body.approve ? 'approve' : 'reject');
  }

  @Post(':id/install')
  @ApiOperation({ summary: '安装技能' })
  install(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.skills.install(ctx, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除技能' })
  remove(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.skills.remove(ctx, id);
  }
}
