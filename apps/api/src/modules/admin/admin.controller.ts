import { PERMISSIONS } from '@kh/shared';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/index.ts';
import { AdminService } from './admin.service.ts';

@ApiTags('管理后台')
@Controller('admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('users')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: '成员列表' })
  users() {
    return this.admin.users();
  }

  @Get('roles')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: '角色列表' })
  roles() {
    return this.admin.roles();
  }

  @Get('departments')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: '部门列表' })
  departments() {
    return this.admin.departments();
  }

  @Get('audit-logs')
  @RequirePermission(PERMISSIONS.AUDIT_VIEW)
  @ApiOperation({ summary: '审计日志（最近 N 条）' })
  auditLogs(@Query('limit') limit?: string) {
    return this.admin.auditLogs(Number(limit ?? '100'));
  }

  @Get('analytics')
  @RequirePermission(PERMISSIONS.ANALYTICS_VIEW)
  @ApiOperation({ summary: '问答分析：未命中问题排行、高频问题、每日问答量' })
  analytics(@Query('days') days?: string) {
    return this.admin.analytics(days ? Number(days) : 30);
  }
}
