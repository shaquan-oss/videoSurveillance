import { randomUUID } from 'node:crypto';
import { type AuthContext, type DbHandle, schema } from '@kh/server-core';
import { AppError, ErrorCode, type MailDraft } from '@kh/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';
import { MailProvider } from './mail.provider.ts';

export interface MailDraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  conversationId?: string | null;
  agentId?: string | null;
}

/**
 * 邮件发件箱。
 *
 * 核心约束（E-13）：**外发动作必须先落草稿、由人确认后才发送**。
 * 所以这里没有「直接发送一个字符串」的接口，只有：
 * 起草 → 用户确认 → 投递。智能体也只能走到起草这一步。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');

  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    @Inject(MailProvider) private readonly provider: MailProvider,
  ) {}

  private get db() {
    return this.handle.db;
  }

  /** 邮件服务是否可用（未配置 SMTP 时草稿只能复制或导出） */
  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  async createDraft(ctx: AuthContext, input: MailDraftInput): Promise<MailDraft> {
    // 收件人允许为空：智能体常常识别不出邮箱（比如只说「发给财务张敏」），
    // 这时仍然落草稿，让用户在前端补上收件人 —— 比直接报错丢掉整封邮件有用。
    const to = input.to.map((s) => s.trim()).filter(Boolean);

    const id = randomUUID();
    await this.db.insert(schema.mailOutbox).values({
      id,
      to,
      cc: (input.cc ?? []).map((s) => s.trim()).filter(Boolean),
      subject: input.subject.trim().slice(0, 200),
      body: input.body,
      status: 'draft',
      conversationId: input.conversationId ?? null,
      agentId: input.agentId ?? null,
      createdBy: ctx.userId,
    });
    return this.toDraft(await this.mustGetOwn(ctx, id));
  }

  async list(ctx: AuthContext): Promise<(MailDraft & { createdByName?: string })[]> {
    const rows = await this.db
      .select()
      .from(schema.mailOutbox)
      .where(eq(schema.mailOutbox.createdBy, ctx.userId))
      .orderBy(desc(schema.mailOutbox.createdAt))
      .limit(100);
    return rows.map((r) => this.toDraft(r));
  }

  async get(ctx: AuthContext, id: string): Promise<MailDraft> {
    return this.toDraft(await this.mustGetOwn(ctx, id));
  }

  async update(ctx: AuthContext, id: string, patch: Partial<MailDraftInput>): Promise<MailDraft> {
    const row = await this.mustGetOwn(ctx, id);
    if (row.status === 'sent') {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: '已发送的邮件不能修改' });
    }
    await this.db
      .update(schema.mailOutbox)
      .set({
        ...(patch.to ? { to: patch.to } : {}),
        ...(patch.cc ? { cc: patch.cc } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject.slice(0, 200) } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.mailOutbox.id, id));
    return this.toDraft(await this.mustGetOwn(ctx, id));
  }

  /**
   * 确认发送。
   * 未配置 SMTP 时不报错、而是落成 unsent 状态并说明原因 ——
   * 草稿本身是有价值的产物，用户仍能复制正文或导出 .eml 自己发。
   */
  async send(ctx: AuthContext, id: string): Promise<MailDraft> {
    const row = await this.mustGetOwn(ctx, id);
    if (row.status === 'sent') return this.toDraft(row);
    if (row.to.length === 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: '请先填写收件人再发送' });
    }

    if (!this.provider.isConfigured()) {
      await this.db
        .update(schema.mailOutbox)
        .set({ status: 'unsent', error: '系统未配置邮件服务（SMTP），请复制正文自行发送', updatedAt: new Date() })
        .where(eq(schema.mailOutbox.id, id));
      return this.toDraft(await this.mustGetOwn(ctx, id));
    }

    try {
      await this.provider.send({ to: row.to, cc: row.cc, subject: row.subject, body: row.body });
      await this.db
        .update(schema.mailOutbox)
        .set({ status: 'sent', sentAt: new Date(), error: null, updatedAt: new Date() })
        .where(eq(schema.mailOutbox.id, id));
    } catch (err) {
      const message = err instanceof Error ? err.message : '发送失败';
      this.logger.warn(`邮件发送失败 ${id}: ${message}`);
      await this.db
        .update(schema.mailOutbox)
        .set({ status: 'failed', error: message.slice(0, 300), updatedAt: new Date() })
        .where(eq(schema.mailOutbox.id, id));
      throw new AppError(ErrorCode.INTERNAL, { message: `发送失败：${message}` });
    }
    return this.toDraft(await this.mustGetOwn(ctx, id));
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    await this.mustGetOwn(ctx, id);
    await this.db.delete(schema.mailOutbox).where(eq(schema.mailOutbox.id, id));
  }

  /** 导出 .eml：没配邮件服务时的兜底出口 */
  async toEml(ctx: AuthContext, id: string): Promise<string> {
    const row = await this.mustGetOwn(ctx, id);
    const from = this.provider.fromAddress() || 'noreply@localhost';
    const headers = [
      `From: ${from}`,
      `To: ${row.to.join(', ')}`,
      ...(row.cc.length ? [`Cc: ${row.cc.join(', ')}`] : []),
      `Subject: ${row.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      `Date: ${new Date().toUTCString()}`,
    ];
    return `${headers.join('\r\n')}\r\n\r\n${Buffer.from(row.body, 'utf8').toString('base64')}\r\n`;
  }

  private async mustGetOwn(ctx: AuthContext, id: string) {
    const rows = await this.db
      .select()
      .from(schema.mailOutbox)
      .where(and(eq(schema.mailOutbox.id, id), eq(schema.mailOutbox.createdBy, ctx.userId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, { message: '邮件草稿不存在' });
    return row;
  }

  private toDraft(r: typeof schema.mailOutbox.$inferSelect): MailDraft {
    return {
      id: r.id,
      to: r.to ?? [],
      cc: r.cc ?? [],
      subject: r.subject,
      body: r.body,
      status: r.status as MailDraft['status'],
      error: r.error ?? null,
      conversationId: r.conversationId ?? null,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    };
  }
}
