import { randomUUID } from 'node:crypto';
import { type AuthContext, type DbHandle, schema } from '@kh/server-core';
import { nextCronRun } from '@kh/shared';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';
import { ConversationsService } from '../conversations/conversations.service.ts';

/** 超过这个时长仍没跑完的任务按超时处理 */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** 连续失败多少次自动暂停（F-08 的「自动暂停」策略） */
const MAX_CONSECUTIVE_FAILS = 3;

/**
 * 定时任务调度器。
 *
 * 不用 Redis/BullMQ 的原因：任务的「什么时候该跑」存在数据库里（nextRunAt），
 * 进程重启后启动时重新载入即可，不需要额外的队列中间件 —— 少一个组件就少一处故障点。
 * 每分钟扫一次到期的任务，执行结果写 task_runs 并给创建者发通知。
 */
@Injectable()
export class ScheduledTasksExecutor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TaskExecutor');
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
  ) {}

  private get db() {
    return this.handle.db;
  }

  async onModuleInit(): Promise<void> {
    await this.rescheduleAll().catch((err) => this.logger.warn(`载入定时任务失败：${err.message}`));
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
    // 启动时立刻扫一次，补上进程停机期间错过的任务
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 进程重启后把下次执行时间补齐（时间在库里，不依赖内存） */
  private async rescheduleAll(): Promise<void> {
    const tasks = await this.db
      .select()
      .from(schema.scheduledTasks)
      .where(and(eq(schema.scheduledTasks.status, 'active'), isNull(schema.scheduledTasks.deletedAt)));

    for (const task of tasks) {
      const next = nextCronRun(task.cron);
      if (next) {
        await this.db.update(schema.scheduledTasks).set({ nextRunAt: next }).where(eq(schema.scheduledTasks.id, task.id));
      }
    }
    this.logger.log(`已载入 ${tasks.length} 个定时任务`);
  }

  /** 每分钟扫一次到期的任务 */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.db
        .select()
        .from(schema.scheduledTasks)
        .where(
          and(
            eq(schema.scheduledTasks.status, 'active'),
            isNull(schema.scheduledTasks.deletedAt),
            lte(schema.scheduledTasks.nextRunAt, new Date()),
          ),
        );

      for (const task of due) {
        await this.runTask(task).catch((err) => this.logger.warn(`任务「${task.name}」执行异常：${err.message}`));
      }
    } catch (err) {
      this.logger.warn(`调度扫描失败：${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 执行一个任务：以创建者的身份跑一次问答，结果写执行记录并通知。
   * 失败时会立刻重试一次（多数失败是模型侧抖动），仍失败则计入连续失败次数。
   */
  private async runTask(task: typeof schema.scheduledTasks.$inferSelect): Promise<void> {
    const ctx = await this.buildContext(task.ownerId);
    if (!ctx) {
      await this.recordRun(task.id, 'failed', '任务创建者已不存在或无可用权限');
      await this.advance(task, false);
      return;
    }

    const started = Date.now();
    let lastError = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await this.withTimeout(
          this.conversations.ask(ctx, {
            question: task.prompt,
            ...(task.modelKey ? { modelKey: task.modelKey } : {}),
            ...(task.scopeKbIds.length ? { scopeKbIds: task.scopeKbIds } : {}),
          }),
          RUN_TIMEOUT_MS,
        );

        const summary = result.answer.content.slice(0, 400);
        await this.recordRun(task.id, 'success', summary, Date.now() - started);
        await this.notify(task, summary);
        await this.advance(task, true);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : '执行失败';
        this.logger.warn(`任务「${task.name}」第 ${attempt} 次执行失败：${lastError}`);
      }
    }

    await this.recordRun(task.id, 'failed', lastError, Date.now() - started);
    await this.notify(task, `执行失败：${lastError}`);
    await this.advance(task, false);
  }

  /** 更新下次执行时间；连续失败到阈值就自动暂停 */
  private async advance(task: typeof schema.scheduledTasks.$inferSelect, ok: boolean): Promise<void> {
    const next = nextCronRun(task.cron);
    let status = task.status;

    if (!ok) {
      const recent = await this.db
        .select({ status: schema.taskRuns.status })
        .from(schema.taskRuns)
        .where(eq(schema.taskRuns.taskId, task.id))
        .orderBy(schema.taskRuns.startedAt);
      const tail = recent.slice(-MAX_CONSECUTIVE_FAILS);
      if (tail.length === MAX_CONSECUTIVE_FAILS && tail.every((r) => r.status === 'failed')) {
        status = 'paused';
        this.logger.warn(`任务「${task.name}」连续失败 ${MAX_CONSECUTIVE_FAILS} 次，已自动暂停`);
      }
    }

    await this.db
      .update(schema.scheduledTasks)
      .set({ lastRunAt: new Date(), nextRunAt: next, status, updatedAt: new Date() })
      .where(eq(schema.scheduledTasks.id, task.id));
  }

  private async recordRun(taskId: string, status: 'success' | 'failed', detail: string, elapsedMs?: number): Promise<void> {
    await this.db.insert(schema.taskRuns).values({
      id: randomUUID(),
      taskId,
      status,
      detail: detail.slice(0, 2000),
      elapsedMs: elapsedMs ?? null,
    });
  }

  private async notify(task: typeof schema.scheduledTasks.$inferSelect, body: string): Promise<void> {
    await this.db.insert(schema.notifications).values({
      id: randomUUID(),
      userId: task.ownerId,
      kind: 'task_run',
      title: `定时任务「${task.name}」已执行`,
      body: body.slice(0, 480),
      linkTo: '/tasks',
    });
  }

  /**
   * 构造任务创建者的身份上下文。
   * 定时任务没有 HTTP 请求，所以这里按库里的事实重建一份 —— 权限与在线提问时完全一致，
   * 不会因为「是系统跑的」而看到更多东西。
   */
  private async buildContext(userId: string): Promise<AuthContext | null> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const user = rows[0];
    if (!user || !user.isActive || user.deletedAt) return null;

    const links = await this.db
      .select({ roleId: schema.userRoles.roleId })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, userId));

    let permissions: string[] = [];
    if (links.length > 0) {
      const roleRows = await this.db
        .select({ permissions: schema.roles.permissions })
        .from(schema.roles)
        .where(
          inArray(
            schema.roles.id,
            links.map((l) => l.roleId),
          ),
        );
      permissions = [...new Set(roleRows.flatMap((r) => r.permissions ?? []))];
    }

    return {
      userId: user.id,
      userName: user.name,
      departmentId: user.departmentId ?? null,
      permissions: permissions as AuthContext['permissions'],
    };
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`执行超过 ${Math.round(ms / 1000)} 秒`)), ms)),
    ]);
  }
}
