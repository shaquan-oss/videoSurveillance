import type { AuthContext } from '@kh/server-core';
import { PERMISSIONS } from '@kh/shared';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../common/decorators/index.ts';
import { type AgentInput, AgentsService } from './agents.service.ts';

@ApiTags('智能体')
@Controller('agents')
export class AgentsController {
  constructor(@Inject(AgentsService) private readonly agents: AgentsService) {}

  @Get()
  @ApiOperation({ summary: '可见智能体列表' })
  list(@CurrentUser() ctx: AuthContext) {
    return this.agents.list(ctx);
  }

  @Post()
  @RequirePermission(PERMISSIONS.AGENT_CREATE)
  @ApiOperation({ summary: '创建智能体' })
  create(@CurrentUser() ctx: AuthContext, @Body() body: AgentInput) {
    return this.agents.create(ctx, body);
  }

  @Get(':id')
  @ApiOperation({ summary: '智能体详情' })
  get(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.agents.get(ctx, id);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: '发布（需先试跑过一次）' })
  publish(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.agents.publish(ctx, id);
  }

  @Post(':id/tested')
  @ApiOperation({ summary: '记录一次试跑' })
  async tested(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    await this.agents.markTested(ctx, id);
    return { ok: true };
  }

  @Post(':id/duplicate')
  @RequirePermission(PERMISSIONS.AGENT_CREATE)
  @ApiOperation({ summary: '复制成自己的（基于别人的改一份）' })
  duplicate(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.agents.duplicate(ctx, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改智能体' })
  update(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: Partial<AgentInput>) {
    return this.agents.update(ctx, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除智能体' })
  remove(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.agents.remove(ctx, id);
  }
}
