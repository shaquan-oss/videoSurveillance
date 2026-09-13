import type { AuthContext } from '@kh/server-core';
import { PERMISSIONS, type TaskStatus } from '@kh/shared';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../common/decorators/index.ts';
import { ScheduledTasksService, type TaskInput } from './scheduled-tasks.service.ts';

@ApiTags('定时任务')
@Controller('tasks')
export class ScheduledTasksController {
  constructor(@Inject(ScheduledTasksService) private readonly tasks: ScheduledTasksService) {}

  @Get()
  @ApiOperation({ summary: '我的定时任务' })
  list(@CurrentUser() ctx: AuthContext) {
    return this.tasks.list(ctx);
  }

  @Post()
  @RequirePermission(PERMISSIONS.TASK_MANAGE)
  @ApiOperation({ summary: '新建定时任务' })
  create(@CurrentUser() ctx: AuthContext, @Body() body: TaskInput) {
    return this.tasks.create(ctx, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改定时任务' })
  update(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: Partial<TaskInput>) {
    return this.tasks.update(ctx, id, body);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: '暂停 / 恢复' })
  toggle(@CurrentUser() ctx: AuthContext, @Param('id') id: string, @Body() body: { status: TaskStatus }) {
    return this.tasks.toggle(ctx, id, body.status);
  }

  @Get(':id/runs')
  @ApiOperation({ summary: '执行记录' })
  runs(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.tasks.runs(ctx, id);
  }

  @Post(':id/run-now')
  @ApiOperation({ summary: '立即执行一次（用于验证配置）' })
  runNow(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.tasks.runNow(ctx, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除定时任务' })
  remove(@CurrentUser() ctx: AuthContext, @Param('id') id: string) {
    return this.tasks.remove(ctx, id);
  }
}
