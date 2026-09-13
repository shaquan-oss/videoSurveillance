import { type DbHandle, JOB_NAMES, QUEUE_NAMES, schema } from '@kh/server-core';
import type { AuditAction } from '@kh/shared';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DB_TOKEN } from '../../database/database.module.ts';

export interface AuditInput {
  action: AuditAction;
  actorId?: string | null;
  actorName?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  success?: boolean;
}

/**
 * 审计：所有敏感动作都要留痕。
 * 写入失败绝不影响主流程 —— 审计是「必须记录」，但不能因为记不下来就把业务搞挂。
 * 所以这里吞掉异常，只写日志。
 */
@Injectable()
export class AuditService implements OnApplicationShutdown {
  private readonly logger = new Logger('Audit');
  private readonly queue: Queue | null;

  constructor(@Inject(DB_TOKEN) private readonly handle: DbHandle) {
    const redisUrl = process.env.REDIS_URL;
    this.queue = redisUrl ? new Queue(QUEUE_NAMES.CLEANUP, { connection: { url: redisUrl } }) : null;
  }

  private get db() {
    return this.handle.db;
  }

  async write(input: AuditInput): Promise<void> {
    try {
      await this.db.insert(schema.auditLogs).values({
        action: input.action,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        targetName: input.targetName ?? null,
        detail: (input.detail ?? null) as Record<string, unknown> | null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        success: input.success ?? true,
      });
    } catch (err) {
      this.logger.warn(`审计写入失败（不影响业务）：${(err as Error).message}`);
    }
  }

  /** 批量写（用于一次操作涉及多个对象，如批量删除） */
  async writeMany(inputs: AuditInput[]): Promise<void> {
    for (const i of inputs) await this.write(i);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close().catch(() => undefined);
  }
}
