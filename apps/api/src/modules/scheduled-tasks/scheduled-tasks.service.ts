import { randomUUID } from 'node:crypto';
import { type AuthContext, type DbHandle, schema } from '@kh/server-core';
import { AppError, ErrorCode, isValidCron, nextCronRun, type ScheduledTask, type TaskStatus } from '@kh/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';

export interface TaskInput {
  name: string;
  cron: string;
  prompt: string;
  modelKey?: string;
  scopeKbIds?: string[];
}

@Injectable()
export class ScheduledTasksService {
  constructor(@Inject(DB_TOKEN) private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  async list(ctx: AuthContext): Promise<ScheduledTask[]> {
    const rows = await this.db
      .select()
      .from(schema.scheduledTasks)
      .where(and(eq(schema.scheduledTasks.ownerId, ctx.userId), isNull(schema.scheduledTasks.deletedAt)))
      .orderBy(schema.scheduledTasks.createdAt);
    return rows.map((r) => this.toTask(r));
  }

  async create(ctx: AuthContext, input: TaskInput): Promise<ScheduledTask> {
    if (!isValidCron(input.cron)) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: 'cron 表达式不合法（需要 5 段，如 0 9 * * 1-5）' });
    }
    const id = randomUUID();
    await this.db.insert(schema.scheduledTasks).values({
      id,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      modelKey: input.modelKey ?? null,
      scopeKbIds: input.scopeKbIds ?? [],
      ownerId: ctx.userId,
      // 建完就把下次执行时间算出来，列表里能直接看到「下次什么时候跑」
      nextRunAt: nextCronRun(input.cron),
    });
    return this.toTask(await this.mustGet(id));
  }

  /** 执行记录（F-09）：每次结果、耗时、失败原因 */
  async runs(ctx: AuthContext, taskId: string) {
    await this.assertOwner(ctx, taskId);
    const rows = await this.db
      .select()
      .from(schema.taskRuns)
      .where(eq(schema.taskRuns.taskId, taskId))
      .orderBy(desc(schema.taskRuns.startedAt))
      .limit(30);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      detail: r.detail ?? '',
      elapsedMs: r.elapsedMs,
      startedAt: r.startedAt.toISOString(),
    }));
  }

  /** 立即跑一次（用于验证任务配置） */
  async runNow(ctx: AuthContext, taskId: string): Promise<void> {
    await this.assertOwner(ctx, taskId);
    await this.db
      .update(schema.scheduledTasks)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(schema.scheduledTasks.id, taskId));
  }

  async update(ctx: AuthContext, id: string, input: Partial<TaskInput>): Promise<ScheduledTask> {
    await this.assertOwner(ctx, id);
    await this.db
      .update(schema.scheduledTasks)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.cron !== undefined ? { cron: input.cron } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.modelKey !== undefined ? { modelKey: input.modelKey } : {}),
        ...(input.scopeKbIds !== undefined ? { scopeKbIds: input.scopeKbIds } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.scheduledTasks.id, id));
    return this.toTask(await this.mustGet(id));
  }

  async toggle(ctx: AuthContext, id: string, status: TaskStatus): Promise<ScheduledTask> {
    await this.assertOwner(ctx, id);
    await this.db.update(schema.scheduledTasks).set({ status, updatedAt: new Date() }).where(eq(schema.scheduledTasks.id, id));
    return this.toTask(await this.mustGet(id));
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    await this.assertOwner(ctx, id);
    await this.db.update(schema.scheduledTasks).set({ deletedAt: new Date() }).where(eq(schema.scheduledTasks.id, id));
  }

  private async mustGet(id: string) {
    const rows = await this.db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: '定时任务不存在' });
    return row;
  }

  private async assertOwner(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.mustGet(id);
    if (row.ownerId !== ctx.userId) throw new AppError(ErrorCode.FORBIDDEN, { message: '只能修改自己创建的定时任务' });
  }

  private toTask(r: typeof schema.scheduledTasks.$inferSelect): ScheduledTask {
    return {
      id: r.id,
      name: r.name,
      cron: r.cron,
      prompt: r.prompt,
      modelKey: r.modelKey ?? null,
      scopeKbIds: r.scopeKbIds ?? [],
      ownerId: r.ownerId,
      status: r.status as TaskStatus,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
