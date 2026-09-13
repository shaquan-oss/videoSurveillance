import { randomUUID } from 'node:crypto';
import { type AuthContext, type DbHandle, schema } from '@kh/server-core';
import { type Agent, type AgentCard, AppError, ErrorCode } from '@kh/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';

export interface AgentInput {
  name: string;
  description?: string;
  example?: string;
  systemPrompt: string;
  modelKey?: string | null;
  scopeKbIds?: string[];
  triggerWords?: string[];
  skillIds?: string[];
  icon?: string;
  visibility?: Agent['visibility'];
  publishStatus?: Agent['publishStatus'];
  /**
   * 运行模式：local=本地编排+本地 RAG；remote=转发给聚智平台智能体。
   * 选 remote 时必须带 platformAssistantCode，否则对话会直接失败。
   */
  runMode?: AgentRunMode;
  /** 平台侧智能体的 assistantCode，仅 remote 模式需要 */
  platformAssistantCode?: string | null;
}

/** 智能体运行模式。与 shared 的 Agent.runMode 保持一致 */
export type AgentRunMode = 'local' | 'remote';

/**
 * 智能体。
 *
 * 三条规则值得说明：
 * 1. 列表按可见性过滤 —— 自己建的 + 全公司的 + 同部门开放的；草稿只对作者可见。
 * 2. 内置智能体（周报助手等）不允许删除，只允许改提示词和范围。
 * 3. 发布前必须有试跑记录（testedAt），避免没验证过的提示词直接推给全公司。
 */
@Injectable()
export class AgentsService {
  constructor(@Inject(DB_TOKEN) private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  async list(ctx: AuthContext): Promise<AgentCard[]> {
    const rows = await this.db
      .select()
      .from(schema.agents)
      .where(and(isNull(schema.agents.deletedAt), this.visibleCondition(ctx)))
      .orderBy(desc(schema.agents.isBuiltin), desc(schema.agents.runCount), desc(schema.agents.updatedAt));

    if (rows.length === 0) return [];

    const [owners, kbs, skills] = await Promise.all([
      this.db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users),
      this.db
        .select({ id: schema.knowledgeBases.id, name: schema.knowledgeBases.name })
        .from(schema.knowledgeBases)
        .where(isNull(schema.knowledgeBases.deletedAt)),
      this.db.select({ id: schema.skills.id, name: schema.skills.name }).from(schema.skills).where(isNull(schema.skills.deletedAt)),
    ]);

    const ownerName = new Map(owners.map((u) => [u.id, u.name]));
    const kbName = new Map(kbs.map((k) => [k.id, k.name]));
    const skillName = new Map(skills.map((s) => [s.id, s.name]));

    return rows.map((r) => ({
      ...this.toAgent(r, ownerName.get(r.ownerId) ?? null),
      kbNames: r.scopeKbIds.map((id) => kbName.get(id) ?? '已删除的知识库'),
      skillNames: r.skillIds.map((id) => skillName.get(id) ?? '已下架的技能'),
    }));
  }

  async get(ctx: AuthContext, id: string): Promise<AgentCard> {
    const row = await this.mustGetVisible(ctx, id);
    const owner = (
      await this.db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, row.ownerId)).limit(1)
    )[0];
    return {
      ...this.toAgent(row, owner?.name ?? null),
      kbNames: [],
      skillNames: [],
    };
  }

  async create(ctx: AuthContext, input: AgentInput): Promise<Agent> {
    await this.assertNameFree(input.name, null);
    if (!input.systemPrompt.trim()) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: '人设提示词不能为空' });
    }

    const runMode = input.runMode ?? 'local';
    const platformAssistantCode = input.platformAssistantCode?.trim() || null;
    assertRunModeValid(runMode, platformAssistantCode);

    const id = randomUUID();
    await this.db.insert(schema.agents).values({
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
      example: input.example?.trim() ?? null,
      systemPrompt: input.systemPrompt.trim(),
      modelKey: input.modelKey ?? null,
      scopeKbIds: input.scopeKbIds ?? [],
      triggerWords: input.triggerWords ?? [],
      skillIds: input.skillIds ?? [],
      icon: input.icon ?? '🤖',
      publishStatus: input.publishStatus ?? 'draft',
      visibility: input.visibility ?? 'private',
      runMode,
      platformAssistantCode,
      ownerId: ctx.userId,
      departmentId: ctx.departmentId,
    });
    return this.toAgent(await this.mustGet(id), null);
  }

  async update(ctx: AuthContext, id: string, input: Partial<AgentInput>): Promise<Agent> {
    const row = await this.assertOwner(ctx, id);
    if (input.name) await this.assertNameFree(input.name, id);

    // 运行模式支持「只切 mode」或「只改 code」，按合并后的值校验，避免误报
    const nextRunMode = input.runMode ?? (row.runMode as AgentRunMode) ?? 'local';
    const nextCode =
      input.platformAssistantCode !== undefined
        ? input.platformAssistantCode?.trim() || null
        : row.platformAssistantCode;
    assertRunModeValid(nextRunMode, nextCode);

    await this.db
      .update(schema.agents)
      .set({
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() ?? null } : {}),
        ...(input.example !== undefined ? { example: input.example?.trim() ?? null } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt.trim() } : {}),
        ...(input.modelKey !== undefined ? { modelKey: input.modelKey } : {}),
        ...(input.scopeKbIds ? { scopeKbIds: input.scopeKbIds } : {}),
        ...(input.triggerWords ? { triggerWords: input.triggerWords } : {}),
        ...(input.skillIds ? { skillIds: input.skillIds } : {}),
        ...(input.icon ? { icon: input.icon } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
        ...(input.publishStatus ? { publishStatus: input.publishStatus } : {}),
        ...(input.runMode !== undefined ? { runMode: nextRunMode } : {}),
        ...(input.platformAssistantCode !== undefined ? { platformAssistantCode: nextCode } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.agents.id, id));
    return this.toAgent(await this.mustGet(id), null);
  }

  /**
   * 发布。
   * 校验三件事：名称不与他人重复、提示词非空、试跑过至少一次。
   * 第三条是原型里的「未试跑不允许发布」，能挡掉一批没验证的人设。
   */
  async publish(ctx: AuthContext, id: string): Promise<Agent> {
    const row = await this.assertOwner(ctx, id);
    if (!row.systemPrompt.trim()) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: '请先填写人设提示词' });
    }
    if (!row.testedAt) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: '请先在右侧试跑一次，确认效果后再发布' });
    }
    await this.db.update(schema.agents).set({ publishStatus: 'published', updatedAt: new Date() }).where(eq(schema.agents.id, id));
    return this.toAgent(await this.mustGet(id), null);
  }

  /** 记录一次试跑：发布前校验的依据，同时把最后一次试跑用的模型记下 */
  async markTested(ctx: AuthContext, id: string): Promise<void> {
    await this.assertOwner(ctx, id);
    await this.db.update(schema.agents).set({ testedAt: new Date() }).where(eq(schema.agents.id, id));
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.assertOwner(ctx, id);
    if (row.isBuiltin) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: '内置智能体不能删除，可以改成「停用」' });
    }
    await this.db.update(schema.agents).set({ deletedAt: new Date(), publishStatus: 'disabled' }).where(eq(schema.agents.id, id));
  }

  /** 复制一份成自己的（基于别人的智能体二次调整） */
  async duplicate(ctx: AuthContext, id: string): Promise<Agent> {
    const row = await this.mustGetVisible(ctx, id);
    const name = await this.freeNameCopy(row.name);
    const newId = randomUUID();
    await this.db.insert(schema.agents).values({
      id: newId,
      name,
      description: row.description,
      example: row.example,
      systemPrompt: row.systemPrompt,
      modelKey: row.modelKey,
      scopeKbIds: row.scopeKbIds,
      triggerWords: row.triggerWords,
      skillIds: row.skillIds,
      icon: row.icon,
      publishStatus: 'draft',
      visibility: 'private',
      ownerId: ctx.userId,
      departmentId: ctx.departmentId,
    });
    return this.toAgent(await this.mustGet(newId), null);
  }

  /* ─────────── 内部 ─────────── */

  private visibleCondition(ctx: AuthContext) {
    const parts = [eq(schema.agents.ownerId, ctx.userId), eq(schema.agents.visibility, 'company')];
    if (ctx.departmentId) {
      parts.push(and(eq(schema.agents.visibility, 'department'), eq(schema.agents.departmentId, ctx.departmentId))!);
    }
    return or(...parts)!;
  }

  private async mustGet(id: string) {
    const rows = await this.db.select().from(schema.agents).where(eq(schema.agents.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: '智能体不存在' });
    return row;
  }

  private async mustGetVisible(ctx: AuthContext, id: string) {
    const rows = await this.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, id), isNull(schema.agents.deletedAt), this.visibleCondition(ctx)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, { message: '智能体不存在或未对你开放' });
    return row;
  }

  private async assertOwner(ctx: AuthContext, id: string) {
    const row = await this.mustGet(id);
    if (row.ownerId !== ctx.userId) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '只有创建者可以修改这个智能体' });
    }
    return row;
  }

  private async assertNameFree(name: string, exceptId: string | null): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError(ErrorCode.BAD_REQUEST, { message: '名称不能为空' });
    const rows = await this.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.name, trimmed), isNull(schema.agents.deletedAt)));
    if (rows.some((r) => r.id !== exceptId)) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: `名称「${trimmed}」已被占用，换一个` });
    }
  }

  private async freeNameCopy(base: string): Promise<string> {
    for (let i = 1; i < 50; i++) {
      const candidate = i === 1 ? `${base} 副本` : `${base} 副本 ${i}`;
      const rows = await this.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.name, candidate), isNull(schema.agents.deletedAt)));
      if (rows.length === 0) return candidate;
    }
    return `${base} 副本 ${randomUUID().slice(0, 4)}`;
  }

  /** 校验技能 id 是否都存在且已上架，避免装配了空技能 */
  async validSkillIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: schema.skills.id })
      .from(schema.skills)
      .where(and(inArray(schema.skills.id, ids), isNull(schema.skills.deletedAt)));
    return rows.map((r) => r.id);
  }

  private toAgent(r: typeof schema.agents.$inferSelect, owner: string | null): Agent {
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      // 示例问法缺失时退回描述：老数据与用户自建的智能体往往只填了描述，
      // 卡片上「说起来就像：…」空着比退而显示描述更难看
      example: r.example ?? r.description ?? null,
      systemPrompt: r.systemPrompt,
      modelKey: r.modelKey ?? null,
      scopeKbIds: r.scopeKbIds ?? [],
      triggerWords: r.triggerWords ?? [],
      skillIds: r.skillIds ?? [],
      publishStatus: r.publishStatus as Agent['publishStatus'],
      visibility: r.visibility as Agent['visibility'],
      isBuiltin: r.isBuiltin,
      builtinKey: r.builtinKey ?? null,
      runCount: r.runCount,
      testedAt: r.testedAt ? r.testedAt.toISOString() : null,
      icon: r.icon,
      ownerId: r.ownerId,
      ownerName: owner,
      isPublic: r.visibility === 'company',
      // 老数据 runMode 列不存在或为 null 时一律按本地处理，避免 UI 误判
      runMode: (r.runMode ?? 'local') as 'local' | 'remote',
      platformAssistantCode: r.platformAssistantCode ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}

/**
 * 远程模式必须带 assistantCode —— 缺了它对话会走到 platform 分支后直接抛错，
 * 与其等到用户提问才失败，不如在保存配置时就拦住。
 */
function assertRunModeValid(runMode: AgentRunMode, code: string | null | undefined): void {
  if (runMode === 'remote' && !code?.trim()) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: '远程模式需要填写聚智平台的智能体编码（assistantCode）',
    });
  }
}
