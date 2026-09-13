import { type DbHandle, schema } from '@kh/server-core';
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';

/**
 * 管理后台的聚合查询：人员 / 角色 / 部门 / 审计日志。
 * 只读展示，不在这里做写操作（写操作走各业务模块，保证权限口径一致）。
 */
@Injectable()
export class AdminService {
  constructor(@Inject(DB_TOKEN) private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  async users() {
    const rows = await this.db
      .select({
        id: schema.users.id,
        account: schema.users.account,
        name: schema.users.name,
        email: schema.users.email,
        departmentName: schema.departments.name,
        isActive: schema.users.isActive,
        lastLoginAt: schema.users.lastLoginAt,
      })
      .from(schema.users)
      .leftJoin(schema.departments, eq(schema.users.departmentId, schema.departments.id))
      .orderBy(schema.users.createdAt);
    return rows.map((r) => ({ ...r, lastLoginAt: r.lastLoginAt?.toISOString() ?? null }));
  }

  async roles() {
    const rows = await this.db.select().from(schema.roles).orderBy(schema.roles.createdAt);
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description ?? null,
      permissions: r.permissions ?? [],
      isBuiltin: r.isBuiltin,
    }));
  }

  async departments() {
    const rows = await this.db.select().from(schema.departments).orderBy(schema.departments.sortOrder);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      maxSecurityLevel: r.maxSecurityLevel,
    }));
  }

  async auditLogs(limit = 100) {
    const rows = await this.db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.createdAt)).limit(limit);
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorName: r.actorName ?? null,
      targetType: r.targetType ?? null,
      targetName: r.targetName ?? null,
      ip: r.ip ?? null,
      success: r.success,
      createdAt: r.createdAt.toISOString(),
      // detail 是审计的价值所在：对话类记录里存着问题、召回片段、模型与是否降级
      detail: (r.detail ?? null) as Record<string, unknown> | null,
    }));
  }

  /**
   * 问答分析。
   *
   * 这张表比任何「知识库健康度评分」都实在：它直接告诉你
   * 「大家问了什么但系统答不出来」——那就是缺哪份材料、该补哪个库。
   * 数据来自对话审计（chat.ask / chat.answer_failed）。
   */
  async analytics(days = 30, limit = 10) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [missed, asked, daily] = await Promise.all([
      // 没找到依据的问题排行：同一句话问多次只算一条，但给出次数
      this.db.execute(sql`
        SELECT
          coalesce(detail->>'question', target_name) AS question,
          count(*)::int AS times,
          max(created_at) AS last_at
        FROM audit_logs
        WHERE action = 'chat.answer_failed'
          AND created_at >= ${since.toISOString()}
        GROUP BY 1
        ORDER BY times DESC, last_at DESC
        LIMIT ${limit}
      `),
      // 问得最多的问题
      this.db.execute(sql`
        SELECT
          coalesce(detail->>'question', target_name) AS question,
          count(*)::int AS times
        FROM audit_logs
        WHERE action = 'chat.ask'
          AND created_at >= ${since.toISOString()}
        GROUP BY 1
        ORDER BY times DESC
        LIMIT ${limit}
      `),
      // 按天的问答量：命中 / 未命中
      this.db.execute(sql`
        SELECT
          to_char(created_at, 'MM-DD') AS day,
          count(*) FILTER (WHERE action = 'chat.ask')::int AS hit,
          count(*) FILTER (WHERE action = 'chat.answer_failed')::int AS miss
        FROM audit_logs
        WHERE action IN ('chat.ask', 'chat.answer_failed')
          AND created_at >= ${since.toISOString()}
        GROUP BY 1
        ORDER BY 1
      `),
    ]);

    const rows = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;

    return {
      days,
      missedQuestions: rows(missed).map((r) => ({
        question: String(r.question ?? ''),
        times: Number(r.times ?? 0),
        lastAt: r.last_at ? new Date(String(r.last_at)).toISOString() : null,
      })),
      topQuestions: rows(asked).map((r) => ({
        question: String(r.question ?? ''),
        times: Number(r.times ?? 0),
      })),
      daily: rows(daily).map((r) => ({
        day: String(r.day ?? ''),
        hit: Number(r.hit ?? 0),
        miss: Number(r.miss ?? 0),
      })),
    };
  }
}
