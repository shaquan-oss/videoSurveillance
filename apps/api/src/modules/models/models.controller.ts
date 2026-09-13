import { getModelGateway } from '@kh/server-core';
import { type ModelInfo, PERMISSIONS } from '@kh/shared';
import { Controller, Get, Inject, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/index.ts';

/**
 * 模型清单。
 * 前端「模型下拉」与「管理后台 → 模型与通道」都读这里，
 * 所以下拉里显示的可用状态与实测延迟，就是后端真实的探测结果。
 */
@ApiTags('模型')
@Controller('models')
export class ModelsController {
  @Get()
  @ApiOperation({ summary: '可选模型清单（含健康状态）' })
  list(): ModelInfo[] {
    return getModelGateway().list();
  }

  @Post('probe')
  @RequirePermission(PERMISSIONS.MODEL_CONFIGURE)
  @ApiOperation({ summary: '主动探测所有模型的可用性' })
  async probe(): Promise<ModelInfo[]> {
    return getModelGateway().probeAll();
  }
}
