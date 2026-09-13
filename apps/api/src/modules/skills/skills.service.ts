import { randomUUID } from 'node:crypto';
import { type AuthContext, type DbHandle, schema } from '@kh/server-core';
import { AppError, ErrorCode, type Skill, type SkillCategory } from '@kh/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';

export interface SkillInput {
  name: string;
  description?: string;
  prompt: string;
  triggerWords?: string[];
  category?: SkillCategory;
  visibility?: Skill['visibility'];
}

/**
 * 静态安全扫描（E-16）。
 *
 * 技能包里的提示词和脚本会被拼进模型上下文，等于间接获得了执行能力，
 * 所以上架前必须扫一遍：危险命令、外联地址、越权读取。
 * 这里的规则是启发式的 —— 目的是拦住明显不该出现的写法，不追求零漏报。
 */
const DANGER_PATTERNS: { rule: string; re: RegExp; level: 'danger' | 'warn' }[] = [
  { rule: '删除类命令（rm -rf / del /S）', re: /\brm\s+-rf\b|\bdel\s+\/[sq]\b/i, level: 'danger' },
  { rule: '管道执行远程脚本（curl|sh）', re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh/i, level: 'danger' },
  { rule: '动态执行（eval / Function 构造）', re: /\beval\s*\(|new\s+Function\s*\(/i, level: 'danger' },
  { rule: '直接操作进程或文件系统', re: /child_process|fs\.(unlink|rmdir|writeFile)|process\.exit/i, level: 'warn' },
  { rule: '破坏性数据库语句', re: /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i, level: 'danger' },
  { rule: '读取环境变量或凭据', re: /process\.env|\.env\b|password|secret|token/i, level: 'warn' },
  { rule: '访问敏感系统路径', re: /\/etc\/passwd|\/etc\/shadow|\.ssh\/|id_rsa/i, level: 'danger' },
  { rule: '外部网络地址', re: /https?:\/\/(?!localhost|127\.0\.0\.1)[^\s"')]+/i, level: 'warn' },
];

/** 扫描结果：level 取命中项里最严重的那一级 */
export function scanSkillContent(text: string): { level: 'pass' | 'warn' | 'danger'; hits: string[] } {
  const hits: string[] = [];
  let level: 'pass' | 'warn' | 'danger' = 'pass';

  for (const { rule, re, level: hitLevel } of DANGER_PATTERNS) {
    if (re.test(text)) {
      hits.push(`${hitLevel === 'danger' ? '危险' : '注意'}：${rule}`);
      if (hitLevel === 'danger') level = 'danger';
      else if (level === 'pass') level = 'warn';
    }
  }
  return { level, hits };
}

@Injectable()
export class SkillsService {
  constructor(@Inject(DB_TOKEN) private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  /** 技能商城 + 我的技能：已上架的公开技能 + 自己创建的（含待审草稿） */
  async list(ctx: AuthContext): Promise<Skill[]> {
    const rows = await this.db
      .select()
      .from(schema.skills)
      .where(and(isNull(schema.skills.deletedAt), or(eq(schema.skills.status, 'published'), eq(schema.skills.authorId, ctx.userId))!))
      .orderBy(desc(schema.skills.isBuiltin), desc(schema.skills.installCount), desc(schema.skills.updatedAt));

    const authors = await this.db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users);
    const nameOf = new Map(authors.map((a) => [a.id, a.name]));
    return rows.map((r) => this.toSkill(r, nameOf.get(r.authorId) ?? null));
  }

  /** 装配技能时的可选项：只要已上架的 */
  async published(ctx: AuthContext): Promise<Skill[]> {
    const rows = await this.db
      .select()
      .from(schema.skills)
      .where(and(isNull(schema.skills.deletedAt), eq(schema.skills.status, 'published')))
      .orderBy(desc(schema.skills.isBuiltin), desc(schema.skills.installCount));
    return rows.map((r) => this.toSkill(r, null));
  }

  /**
   * 按触发词匹配技能（E-20 的运行时加载）。
   * 对话内容命中技能触发词时，把它作为推荐返回，由前端提示「要不要用这个技能」。
   */
  async matchByTrigger(ctx: AuthContext, text: string): Promise<Skill[]> {
    const all = await this.published(ctx);
    return all.filter((sk) => sk.triggerWords.some((w) => w && text.includes(w)));
  }

  async create(ctx: AuthContext, input: SkillInput): Promise<Skill> {
    const name = input.name.trim();
    if (!name) throw new AppError(ErrorCode.BAD_REQUEST, { message: '技能名称不能为空' });
    if (!input.prompt.trim()) throw new AppError(ErrorCode.BAD_REQUEST, { message: '技能指令不能为空' });

    const dup = await this.db
      .select({ id: schema.skills.id })
      .from(schema.skills)
      .where(and(eq(schema.skills.name, name), isNull(schema.skills.deletedAt)))
      .limit(1);
    if (dup.length) throw new AppError(ErrorCode.BAD_REQUEST, { message: `技能「${name}」已存在` });

    // 上架前先扫：danger 直接拒收，warn 允许但记录在案
    const scan = scanSkillContent(`${input.prompt}\n${input.description ?? ''}`);
    if (scan.level === 'danger') {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `安全扫描未通过：${scan.hits.join('；')}`,
      });
    }

    const id = randomUUID();
    await this.db.insert(schema.skills).values({
      id,
      name,
      description: input.description?.trim() ?? null,
      prompt: input.prompt.trim(),
      triggerWords: input.triggerWords ?? [],
      category: input.category ?? 'general',
      visibility: input.visibility ?? 'company',
      // 有告警的进入待审，干净的也走审核流程（原型里的技能审核）
      status: 'pending',
      scanResult: scan,
      authorId: ctx.userId,
    });
    return this.toSkill(await this.mustGet(id), ctx.userName);
  }

  async update(ctx: AuthContext, id: string, input: Partial<SkillInput>): Promise<Skill> {
    const row = await this.mustGet(id);
    if (row.authorId !== ctx.userId && !ctx.permissions.includes('skill:review')) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '只有作者或审核员可以修改技能' });
    }

    const scan = input.prompt ? scanSkillContent(input.prompt) : null;
    if (scan?.level === 'danger') {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: `安全扫描未通过：${scan.hits.join('；')}` });
    }

    await this.db
      .update(schema.skills)
      .set({
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() ?? null } : {}),
        ...(input.prompt ? { prompt: input.prompt.trim() } : {}),
        ...(input.triggerWords ? { triggerWords: input.triggerWords } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
        ...(scan ? { scanResult: scan } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.skills.id, id));
    return this.toSkill(await this.mustGet(id), null);
  }

  /** 审核：通过则上架，驳回则留在作者名下 */
  async review(ctx: AuthContext, id: string, action: 'approve' | 'reject'): Promise<Skill> {
    await this.mustGet(id);
    await this.db
      .update(schema.skills)
      .set({ status: action === 'approve' ? 'published' : 'rejected', updatedAt: new Date() })
      .where(eq(schema.skills.id, id));
    return this.toSkill(await this.mustGet(id), null);
  }

  /** 安装（装配到自己的智能体）：只累加安装量，真正的装配在智能体那边 */
  async install(ctx: AuthContext, id: string): Promise<{ ok: boolean; installCount: number }> {
    const row = await this.mustGet(id);
    const next = row.installCount + 1;
    await this.db.update(schema.skills).set({ installCount: next }).where(eq(schema.skills.id, id));
    return { ok: true, installCount: next };
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.mustGet(id);
    if (row.isBuiltin) throw new AppError(ErrorCode.BAD_REQUEST, { message: '内置技能不能删除' });
    if (row.authorId !== ctx.userId && !ctx.permissions.includes('skill:review')) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '只有作者或审核员可以删除技能' });
    }
    await this.db.update(schema.skills).set({ deletedAt: new Date() }).where(eq(schema.skills.id, id));
  }

  private async mustGet(id: string) {
    const rows = await this.db.select().from(schema.skills).where(eq(schema.skills.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: '技能不存在' });
    return row;
  }

  private toSkill(r: typeof schema.skills.$inferSelect, author: string | null): Skill {
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      triggerWords: r.triggerWords ?? [],
      prompt: r.prompt,
      category: r.category as Skill['category'],
      visibility: r.visibility as Skill['visibility'],
      status: r.status as Skill['status'],
      scanResult: r.scanResult ?? { level: 'pass', hits: [] },
      isBuiltin: r.isBuiltin,
      authorId: r.authorId,
      authorName: author,
      installCount: r.installCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
