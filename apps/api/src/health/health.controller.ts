import { type DbHandle, getModelGateway, getStorage } from '@kh/server-core';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../common/decorators/index.ts';
import { DB_TOKEN } from '../database/database.module.ts';
import { RedisService } from '../redis/redis.service.ts';

/**
 * 健康检查。
 * 两类用途：
 * 1. /health/live  —— 容器探活，只回答「进程还活着吗」，不查依赖
 * 2. /health       —— 完整检查，管理后台的「服务健康」页与部署核对时用
 */
@ApiTags('健康')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: '进程存活探针' })
  live() {
    return { ok: true, ts: new Date().toISOString() };
  }

  @Public()
  @Get()
  @ApiOperation({ summary: '完整健康检查（数据库 / 缓存 / 对象存储）' })
  async full() {
    const checks: Record<string, { ok: boolean; latencyMs: number; message?: string }> = {};

    // 数据库
    let t = Date.now();
    try {
      await this.handle.db.execute(sql`SELECT 1`);
      checks.database = { ok: true, latencyMs: Date.now() - t };
    } catch (err) {
      checks.database = { ok: false, latencyMs: Date.now() - t, message: (err as Error).message };
    }

    // 缓存
    t = Date.now();
    const redisOk = await this.redis.ping();
    checks.redis = { ok: redisOk, latencyMs: Date.now() - t };

    // 对象存储
    try {
      const r = await getStorage().health();
      checks.storage = { ok: r.ok, latencyMs: r.latencyMs ?? 0, message: r.message };
    } catch (err) {
      checks.storage = { ok: false, latencyMs: 0, message: (err as Error).message };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    return {
      ok: allOk,
      checks,
      // 检索链路状态单独放，不进 checks：向量模型降级不是「服务故障」，
      // 但必须让人看得见，否则「答不准」会被误判成解析或提示词的问题。
      retrieval: getModelGateway().embedStatus(),
      uptimeSec: Math.round(process.uptime()),
    };
  }
}
