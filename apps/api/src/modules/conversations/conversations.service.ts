import { randomUUID } from 'node:crypto';
import {
  type AuthContext,
  buildPermissionFilter,
  type DbHandle,
  getModelGateway,
  getVectorStore,
  PlatformAgentClient,
  retrieve,
  schema,
} from '@kh/server-core';
import {
  AppError,
  type AskEvent,
  type ChatMessage,
  type ChatRequest,
  type Citation,
  type Conversation,
  ErrorCode,
  extractMailDraft,
  FOLLOW_UP_MARK,
  fallbackMailDraft,
  type MailDraft,
  type ParsedMailDraft,
  type RetrievedChunk,
  splitFollowUps,
} from '@kh/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';
import { AuditService } from '../audit/audit.service.ts';
import { MailService } from '../mail/mail.service.ts';
import {
  PLATFORM_AGENT_CLIENT_TOKEN,
} from '../platform/platform.tokens.ts';
import {
  PLATFORM_CONFIG_TOKEN,
  type PlatformConfig,
} from '../../config/platform.config.ts';

const HISTORY_LIMIT = 8;
const RETRIEVAL_TOP_K = 5;

/** 流式外发时尾部保留的字符数：够覆盖「```email」这个标记的长度 */
const RESERVE = 8;

/** 邮件草稿的代码块语言标记 */
const MAIL_FENCES = ['email', 'mail'];

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger('Conversations');

  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PLATFORM_AGENT_CLIENT_TOKEN) private readonly platformAgent: PlatformAgentClient | null,
    @Inject(PLATFORM_CONFIG_TOKEN) private readonly platformCfg: PlatformConfig,
  ) {}

  private get db() {
    return this.handle.db;
  }
  private get vector() {
    return getVectorStore(this.handle.db);
  }
  private get model() {
    return getModelGateway();
  }

  /* ─────────── 会话 CRUD ─────────── */

  async list(ctx: AuthContext): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.ownerId, ctx.userId), isNull(schema.conversations.deletedAt)))
      .orderBy(desc(schema.conversations.updatedAt));
    return rows.map((r) => this.toConversation(r));
  }

  async create(ctx: AuthContext, input: { modelKey?: string; scopeKbIds?: string[] }): Promise<Conversation> {
    const id = randomUUID();
    await this.db.insert(schema.conversations).values({
      id,
      ownerId: ctx.userId,
      modelKey: input.modelKey ?? null,
      scopeKbIds: input.scopeKbIds ?? [],
    });
    const row = await this.mustGetConversation(id);
    return this.toConversation(row);
  }

  async getMessages(ctx: AuthContext, conversationId: string): Promise<ChatMessage[]> {
    await this.assertOwner(ctx, conversationId);
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(schema.messages.createdAt);
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      role: r.role as ChatMessage['role'],
      content: r.content,
      citations: (r.citations as Citation[]) ?? [],
      followUps: r.followUps ?? [],
      mailDraftId: r.mailDraftId ?? null,
      modelKey: r.modelKey ?? null,
      elapsedMs: r.elapsedMs ?? null,
      tokensIn: r.tokensIn ?? null,
      tokensOut: r.tokensOut ?? null,
      feedback: (r.feedback as ChatMessage['feedback']) ?? null,
      feedbackReason: r.feedbackReason ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * 载入智能体上下文。
   *
   * 可见性判断写在这里而不是只靠前端过滤 —— 否则任何人拿到 id 就能借用别人的智能体，
   * 连带把它的知识库范围也一起借走。
   */
  private async loadAgentContext(ctx: AuthContext, agentId?: string): Promise<AgentContext | null> {
    if (!agentId) return null;

    const rows = await this.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const agent = rows[0];
    if (!agent || agent.deletedAt || agent.publishStatus === 'disabled') {
      throw new AppError(ErrorCode.NOT_FOUND, { message: '智能体不存在或已停用' });
    }

    const visible =
      agent.ownerId === ctx.userId ||
      agent.visibility === 'company' ||
      (agent.visibility === 'department' && !!agent.departmentId && agent.departmentId === ctx.departmentId);
    if (!visible) throw new AppError(ErrorCode.FORBIDDEN, { message: '这个智能体没有对你开放' });

    let skills: { name: string; prompt: string }[] = [];
    if (agent.skillIds.length > 0) {
      const skillRows = await this.db.select().from(schema.skills).where(inArray(schema.skills.id, agent.skillIds));
      skills = skillRows.filter((sk) => !sk.deletedAt && sk.status === 'published').map((sk) => ({ name: sk.name, prompt: sk.prompt }));
    }

    await this.db
      .update(schema.agents)
      .set({ runCount: sql`${schema.agents.runCount} + 1` })
      .where(eq(schema.agents.id, agentId));

    return {
      id: agent.id,
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      modelKey: agent.modelKey ?? null,
      builtinKey: agent.builtinKey ?? null,
      skills,
      scopeKbIds: agent.scopeKbIds,
      runMode: ((agent as { runMode?: string }).runMode === 'remote' ? 'remote' : 'local'),
      platformAssistantCode:
        ((agent as { platformAssistantCode?: string | null }).platformAssistantCode ?? null) || null,
    };
  }

  /* ─────────── 问答主链路 ─────────── */

  async ask(
    ctx: AuthContext,
    input: ChatRequest,
  ): Promise<{ answer: ChatMessage; citations: Citation[]; degraded: boolean; mailDraft: MailDraft | null }> {
    const agent = await this.loadAgentContext(ctx, input.agentId);
    if (agent?.runMode === 'remote') {
      await this.warnSensitiveKbAccess(ctx, agent);
      return this.runRemoteAsk(ctx, input, agent);
    }
    const conversationId = input.conversationId ?? (await this.create(ctx, { modelKey: input.modelKey, scopeKbIds: input.scopeKbIds })).id;

    // 1. 检索：权限过滤 + 会话范围下推，向量+关键词合并
    const hits = await retrieve({
      store: this.vector,
      query: input.question,
      filter: buildPermissionFilter(ctx),
      kbIds: resolveScope(agent, input.scopeKbIds),
      topK: RETRIEVAL_TOP_K,
    });
    // 附件直读：用户刚上传的文件整份并入上下文，排在检索结果之前
    const attached = await this.loadAttachedChunks(ctx, input.attachFileIds);
    const context = attached.length ? [...attached, ...hits] : hits;
    const citations = buildCitations(context);

    // 2. 保存用户提问，组装上下文并生成
    await this.db.insert(schema.messages).values({
      id: randomUUID(),
      conversationId,
      role: 'user',
      content: input.question,
    });
    const history = await this.recentHistory(conversationId);
    const prompt = buildPrompt(input.question, context, history, agent);
    const result = await this.model.chat(prompt, {
      modelKey: input.modelKey ?? agent?.modelKey ?? undefined,
      temperature: ANSWER_TEMPERATURE,
    });

    // 智能体可能起草了邮件：先落成草稿，正文里把那段 JSON 剥掉
    const { clean, draft: parsedMail } = extractMailDraft(result.content);
    const needsMail = agent?.builtinKey === 'email_assistant';
    // 三级兜底：模型按约定给了 email 块 → 直接用；没给就用一次短调用提取；
    // 连提取都失败才退回正则猜（质量最差，但总比丢掉整封邮件强）
    let mailContent = parsedMail;
    if (!mailContent && needsMail) {
      mailContent = (await this.coerceMailDraft(clean)) ?? fallbackMailDraft(clean);
    }
    const { content: answerText } = splitFollowUps(clean);
    const followUps = await this.suggestFollowUps(input.question, answerText);
    const mailDraft = mailContent
      ? await this.mail.createDraft(ctx, { ...mailContent, conversationId, agentId: input.agentId ?? null })
      : null;

    // 3. 落库回答，并把新会话的标题设为第一条问题的截断
    const answerId = randomUUID();
    const createdAt = new Date();
    const conv = await this.mustGetConversation(conversationId);
    await this.db.insert(schema.messages).values({
      id: answerId,
      conversationId,
      role: 'assistant',
      content: answerText,
      citations: citations as unknown[],
      followUps,
      mailDraftId: mailDraft?.id ?? null,
      retrievedChunkIds: context.map((h) => h.chunkId),
      modelKey: result.model ?? null,
      elapsedMs: result.elapsedMs,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
      createdAt,
    });
    await this.db
      .update(schema.conversations)
      .set({
        messageCount: sql`${schema.conversations.messageCount} + 2`,
        updatedAt: createdAt,
        ...(conv.messageCount === 0 ? { title: input.question.slice(0, 30) } : {}),
      })
      .where(eq(schema.conversations.id, conversationId));

    await this.auditAsk(ctx, input, conversationId, citations, hits, result.model ?? null, !!result.degraded, 0);

    return {
      answer: {
        id: answerId,
        conversationId,
        role: 'assistant',
        content: answerText,
        citations,
        followUps,
        mailDraftId: mailDraft?.id ?? null,
        modelKey: result.model ?? null,
        elapsedMs: result.elapsedMs,
        tokensIn: result.tokensIn ?? null,
        tokensOut: result.tokensOut ?? null,
        feedback: null,
        feedbackReason: null,
        createdAt: createdAt.toISOString(),
      },
      citations,
      /** 首选模型不可用、自动切了备用时告诉前端，界面据此显示降级提示条 */
      degraded: result.degraded ?? false,
      mailDraft,
    };
  }

  /**
   * 流式问答。事件顺序：start → citations → meta → delta* → followUps? → done。
   * 落库统一放在最后做完 —— 用户中途关掉页面也不会留下半截回答。
   */
  async *askStream(ctx: AuthContext, input: ChatRequest): AsyncGenerator<AskEvent, void, unknown> {
    const agent = await this.loadAgentContext(ctx, input.agentId);
    if (agent?.runMode === 'remote') {
      await this.warnSensitiveKbAccess(ctx, agent);
      yield* this.runRemoteStream(ctx, input, agent);
      return;
    }
    const conversationId = input.conversationId ?? (await this.create(ctx, { modelKey: input.modelKey, scopeKbIds: input.scopeKbIds })).id;
    yield { type: 'start', conversationId, runMode: 'local' };

    const hits = await retrieve({
      store: this.vector,
      query: input.question,
      filter: buildPermissionFilter(ctx),
      kbIds: resolveScope(agent, input.scopeKbIds),
      topK: RETRIEVAL_TOP_K,
    });
    // 附件直读：用户刚上传的文件整份并入上下文，排在检索结果之前
    const attached = await this.loadAttachedChunks(ctx, input.attachFileIds);
    const context = attached.length ? [...attached, ...hits] : hits;
    const citations = buildCitations(context);
    yield { type: 'citations', citations };

    await this.db.insert(schema.messages).values({
      id: randomUUID(),
      conversationId,
      role: 'user',
      content: input.question,
    });

    const history = await this.recentHistory(conversationId);
    const prompt = buildPrompt(input.question, context, history, agent);

    const started = Date.now();
    const splitter = new AnswerSplitter();
    let modelKey: string | null = null;
    let degraded = false;

    for await (const ev of this.model.chatStream(prompt, {
      modelKey: input.modelKey ?? agent?.modelKey ?? undefined,
      temperature: ANSWER_TEMPERATURE,
    })) {
      if (ev.type === 'meta') {
        modelKey = ev.modelKey;
        degraded = ev.degraded;
        yield { type: 'meta', modelKey: ev.modelKey, degraded: ev.degraded, runMode: 'local' };
        continue;
      }
      const out = splitter.push(ev.text);
      if (out) yield { type: 'delta', text: out };
    }

    const tail = splitter.flush();
    if (tail) yield { type: 'delta', text: tail };

    // 智能体可能起草了邮件：落成草稿，并把干净正文交给前端
    const { clean, draft: parsedMail } = extractMailDraft(splitter.full);
    const needsMail = agent?.builtinKey === 'email_assistant';
    // 三级兜底：模型按约定给了 email 块 → 直接用；没给就用一次短调用提取；
    // 连提取都失败才退回正则猜（质量最差，但总比丢掉整封邮件强）
    let mailContent = parsedMail;
    if (!mailContent && needsMail) {
      mailContent = (await this.coerceMailDraft(clean)) ?? fallbackMailDraft(clean);
    }
    const { content: answerText } = splitFollowUps(clean);
    const followUps = await this.suggestFollowUps(input.question, answerText);
    if (followUps.length) yield { type: 'followUps', items: followUps };

    const mailDraft = mailContent
      ? await this.mail.createDraft(ctx, { ...mailContent, conversationId, agentId: input.agentId ?? null })
      : null;
    if (mailDraft) yield { type: 'draft', draft: mailDraft };

    const answerId = randomUUID();
    const createdAt = new Date();
    const conv = await this.mustGetConversation(conversationId);
    await this.db.insert(schema.messages).values({
      id: answerId,
      conversationId,
      role: 'assistant',
      content: answerText,
      citations: citations as unknown[],
      followUps,
      mailDraftId: mailDraft?.id ?? null,
      retrievedChunkIds: context.map((h) => h.chunkId),
      modelKey,
      elapsedMs: Date.now() - started,
      createdAt,
    });
    await this.db
      .update(schema.conversations)
      .set({
        messageCount: sql`${schema.conversations.messageCount} + 2`,
        updatedAt: createdAt,
        ...(conv.messageCount === 0 ? { title: input.question.slice(0, 30) } : {}),
      })
      .where(eq(schema.conversations.id, conversationId));

    await this.auditAsk(ctx, input, conversationId, citations, hits, modelKey, degraded, Date.now() - started);

    yield {
      type: 'done',
      degraded,
      runMode: 'local',
      message: {
        id: answerId,
        conversationId,
        role: 'assistant',
        content: answerText,
        citations,
        followUps,
        mailDraftId: mailDraft?.id ?? null,
        modelKey,
        elapsedMs: Date.now() - started,
        tokensIn: null,
        tokensOut: null,
        feedback: null,
        feedbackReason: null,
        createdAt: createdAt.toISOString(),
      },
    };
  }

  /**
   * 生成追问建议。
   *
   * 一开始的做法是让主回答在结尾用一个分隔标记带出追问，但实测模型（尤其长回答时）
   * 经常忽略这个格式要求，追问时有时无。改成回答完成后再发一次很短的调用，稳定得多；
   * 失败也不影响主流程 —— 追问只是锦上添花。
   */
  private async suggestFollowUps(question: string, answer: string): Promise<string[]> {
    if (!answer.trim()) return [];
    try {
      const result = await this.model.chat(
        [
          {
            role: 'system',
            content: [
              '你是企业知识助手。请阅读下面的问答，列出用户最可能接着问的 3 个问题。',
              '要求：只输出这 3 行，不要序号、不要引号、不要任何前言或解释；每行不超过 18 个字。',
              '',
              '示例输出：',
              '住宿发票备注要写什么',
              '出差报告模板在哪下载',
              '超标说明需要谁签字',
            ].join('\n'),
          },
          { role: 'user', content: `原问题：${question}\n\n回答：${answer.slice(0, 500)}` },
        ],
        { maxTokens: 160 },
      );
      return pickFollowUps(result.content);
    } catch {
      return [];
    }
  }

  /**
   * 对话审计。
   * 阶段 5 的里程碑要求「审计里能查到谁在什么时候问了什么、召回哪些片段」，
   * 所以这里把问题、召回片段 id、引用文件、模型与是否降级都记下来。
   * 未命中（资料中没有找到）单独标 failed，方便使用分析页统计「哪些问题没找到依据」。
   */
  private async auditAsk(
    ctx: AuthContext,
    input: ChatRequest,
    conversationId: string,
    citations: Citation[],
    hits: RetrievedChunk[],
    modelKey: string | null,
    degraded: boolean,
    elapsedMs: number,
    runMode: 'local' | 'remote' = 'local',
    platformSessionId: string | null = null,
  ): Promise<void> {
    const missed = citations.length === 0 || hits.length === 0;
    await this.audit.write({
      action: missed ? 'chat.answer_failed' : runMode === 'remote' ? 'agent.run_remote' : 'chat.ask',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'conversation',
      targetId: conversationId,
      targetName: input.question.slice(0, 80),
      detail: {
        question: input.question,
        agentId: input.agentId ?? null,
        scopeKbIds: input.scopeKbIds ?? [],
        modelKey,
        degraded,
        elapsedMs,
        runMode,
        platformSessionId,
        chunkIds: hits.map((h) => h.chunkId),
        files: [...new Set(citations.map((c) => c.fileName))],
      },
      success: !missed,
    });
  }

  /* ─────────── 远程智能体分支 ─────────── */

  /**
   * 软警告护栏：智能体切到 remote 模式且其检索范围含高敏感级知识库时，
   * 写一条审计 + console.warn，但**不阻塞**。目的是让异常配置被人看见，而不是把它挡掉。
   */
  private async warnSensitiveKbAccess(ctx: AuthContext, agent: AgentContext): Promise<void> {
    if (!agent.scopeKbIds.length) return;
    const rows = await this.db
      .select({ id: schema.knowledgeBases.id, name: schema.knowledgeBases.name, securityLevel: schema.knowledgeBases.securityLevel })
      .from(schema.knowledgeBases)
      .where(inArray(schema.knowledgeBases.id, agent.scopeKbIds));
    const sensitive = rows.filter(
      (r) => r.securityLevel === 'confidential' || r.securityLevel === 'restricted',
    );
    if (!sensitive.length) return;
    await this.audit.write({
      action: 'agent.run_mode_guard',
      actorId: ctx.userId,
      actorName: ctx.userName,
      targetType: 'agent',
      targetId: agent.id,
      targetName: agent.name,
      detail: {
        reason: 'remote_agent_scope_sensitive_kb',
        sensitiveKbs: sensitive.map((k) => ({ id: k.id, name: k.name, securityLevel: k.securityLevel })),
      },
    });
    this.logger.warn(
      `[runMode-guard] agent「${agent.name}」启用 remote 模式，scope 内有 ${sensitive.length} 个高敏感级库`,
    );
  }

  /**
   * 读出「附件直读」文件的全部切片。
   *
   * 与 retrieve() 的区别：不做相似度排序、不截断，整份文件按 chunkIndex 全取 ——
   * 用户刚上传文件就提问，通常希望对这份文件有完整理解，而不是 top-K 抽样。
   * 只取当前用户名下的切片（对话页上传的文件 owner 必然是自己），越权取不到就是空。
   */
  private async loadAttachedChunks(ctx: AuthContext, fileIds?: string[]): Promise<RetrievedChunk[]> {
    if (!fileIds?.length) return [];

    const rows = await this.db
      .select({
        chunkId: schema.chunks.id,
        fileId: schema.chunks.fileId,
        fileName: schema.files.name,
        kbId: schema.chunks.kbId,
        content: schema.chunks.content,
        chunkIndex: schema.chunks.chunkIndex,
        page: schema.chunks.page,
      })
      .from(schema.chunks)
      .innerJoin(schema.files, eq(schema.files.id, schema.chunks.fileId))
      .where(
        and(
          inArray(schema.chunks.fileId, fileIds),
          eq(schema.chunks.ownerId, ctx.userId),
          isNull(schema.files.deletedAt),
        ),
      )
      .orderBy(schema.chunks.fileId, schema.chunks.chunkIndex);

    return rows.map((r) => ({
      chunkId: r.chunkId,
      fileId: r.fileId,
      fileName: r.fileName,
      kbId: r.kbId,
      content: r.content,
      // 直读内容不是靠相似度命中的，分数给满，让它们排在检索结果之前
      score: 1,
      chunkIndex: r.chunkIndex,
      page: r.page,
    }));
  }

  private assertRemoteReady(agent: AgentContext): { client: PlatformAgentClient; assistantCode: string } {
    if (!this.platformCfg.enabled || !this.platformAgent) {
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
        message: '平台凭证未配置，该智能体无法切换到 remote 模式',
      });
    }
    if (!agent.platformAssistantCode) {
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, {
        message: '该智能体未填写平台 assistant code，请到后台补齐',
      });
    }
    return { client: this.platformAgent, assistantCode: agent.platformAssistantCode };
  }

  /**
   * 一次性调用远程智能体 —— 用于 ask()（非流式）。
   * 把 stream 一次性聚合到 done，转换 citations/followUps，最后落库。
   */
  private async runRemoteAsk(
    ctx: AuthContext,
    input: ChatRequest,
    agent: AgentContext,
  ): Promise<{ answer: ChatMessage; citations: Citation[]; degraded: boolean; mailDraft: MailDraft | null }> {
    const started = Date.now();
    const conversationId = input.conversationId ?? (await this.create(ctx, {})).id;

    // 用户提问落库，并取回最近多轮历史喂给平台智能体
    await this.db.insert(schema.messages).values({
      id: randomUUID(),
      conversationId,
      role: 'user',
      content: input.question,
    });
    const history = await this.recentHistory(conversationId);
    const existing = await this.mustGetConversation(conversationId);

    // 写 platform_session_id（首次可空）
    if (!existing.platformSessionId && history.length === 0) {
      // 不在这里写 —— 待回答返回时如果有再写
    }

    const { client, assistantCode } = this.assertRemoteReady(agent);
    const platformMessages = this.toPlatformMessages(input.question, history, agent);

    // 聚合流式事件
    let content = '';
    let citations: Citation[] = [];
    let followUps: string[] = [];
    let platformSessionId: string | null = existing.platformSessionId ?? null;
    let degraded = false;
    let sawAny = false;

    try {
      for await (const ev of client.chatStream({
        assistantCode,
        messages: platformMessages,
        platformSessionId: platformSessionId ?? undefined,
      })) {
        sawAny = true;
        if (ev.type === 'delta') content += ev.content;
        else if (ev.type === 'reference') citations = remoteRefsToCitations(ev.items);
        else if (ev.type === 'recommend') followUps = ev.questions.slice(0, 3);
        else if (ev.type === 'session') platformSessionId = ev.platformSessionId;
        else if (ev.type === 'progress') continue;
        else if (ev.type === 'done') break;
      }
    } catch (err) {
      degraded = true;
      this.logger.warn(`remote agent 调用失败：${(err as Error).message}`);
      await this.audit.write({
        action: 'chat.answer_failed',
        actorId: ctx.userId,
        actorName: ctx.userName,
        targetType: 'agent',
        targetId: agent.id,
        targetName: agent.name,
        detail: {
          runMode: 'remote',
          error: (err as Error).message,
          platformSessionId,
        },
        success: false,
      });
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, { message: '远程智能体暂不可用', detail: (err as Error).message });
    }

    if (!sawAny) {
      throw new AppError(ErrorCode.MODEL_UNAVAILABLE, { message: '远程智能体未返回任何内容' });
    }

    await this.db.update(schema.conversations).set({ platformSessionId }).where(eq(schema.conversations.id, conversationId));

    const answerId = randomUUID();
    const createdAt = new Date();
    await this.db.insert(schema.messages).values({
      id: answerId,
      conversationId,
      role: 'assistant',
      content,
      citations: citations as unknown[],
      followUps,
      retrievedChunkIds: [],
      modelKey: agent.name,
      elapsedMs: Date.now() - started,
      createdAt,
    });
    await this.db
      .update(schema.conversations)
      .set({
        messageCount: sql`${schema.conversations.messageCount} + 2`,
        updatedAt: createdAt,
        ...(existing.messageCount === 0 ? { title: input.question.slice(0, 30) } : {}),
      })
      .where(eq(schema.conversations.id, conversationId));

    await this.auditAsk(
      ctx,
      input,
      conversationId,
      citations,
      [],
      agent.name,
      degraded,
      Date.now() - started,
      'remote',
      platformSessionId,
    );

    return {
      answer: {
        id: answerId,
        conversationId,
        role: 'assistant',
        content,
        citations,
        followUps,
        mailDraftId: null,
        modelKey: agent.name,
        elapsedMs: Date.now() - started,
        tokensIn: null,
        tokensOut: null,
        feedback: null,
        feedbackReason: null,
        createdAt: createdAt.toISOString(),
      },
      citations,
      degraded,
      mailDraft: null,
    };
  }

  /**
   * 流式调用远程智能体 —— 用于 askStream()。
   * 复用客户端原生 SSE 事件 → 直接翻译为本系统的 AskEvent。
   */
  private async *runRemoteStream(
    ctx: AuthContext,
    input: ChatRequest,
    agent: AgentContext,
  ): AsyncGenerator<AskEvent, void, unknown> {
    const started = Date.now();
    const conversationId = input.conversationId ?? (await this.create(ctx, {})).id;
    yield { type: 'start', conversationId, runMode: 'remote' };

    await this.db.insert(schema.messages).values({
      id: randomUUID(),
      conversationId,
      role: 'user',
      content: input.question,
    });
    const history = await this.recentHistory(conversationId);
    const existing = await this.mustGetConversation(conversationId);

    const { client, assistantCode } = this.assertRemoteReady(agent);
    const platformMessages = this.toPlatformMessages(input.question, history, agent);

    let content = '';
    let citations: Citation[] = [];
    let followUps: string[] = [];
    let platformSessionId: string | null = existing.platformSessionId ?? null;
    let degraded = false;

    yield { type: 'meta', modelKey: agent.name, degraded: false, runMode: 'remote' };

    try {
      for await (const ev of client.chatStream({
        assistantCode,
        messages: platformMessages,
        platformSessionId: platformSessionId ?? undefined,
      })) {
        if (ev.type === 'delta') {
          content += ev.content;
          yield { type: 'delta', text: ev.content };
        } else if (ev.type === 'reference') {
          citations = remoteRefsToCitations(ev.items);
          yield { type: 'citations', citations };
        } else if (ev.type === 'recommend') {
          followUps = ev.questions.slice(0, 3);
          if (followUps.length) yield { type: 'followUps', items: followUps };
        } else if (ev.type === 'session') {
          platformSessionId = ev.platformSessionId;
        } else if (ev.type === 'progress') {
          /* 进度事件不直接对外 —— 留作审计与可观测性扩展 */
        } else if (ev.type === 'done') {
          break;
        }
      }
    } catch (err) {
      degraded = true;
      this.logger.warn(`remote stream 失败：${(err as Error).message}`);
      await this.audit.write({
        action: 'chat.answer_failed',
        actorId: ctx.userId,
        actorName: ctx.userName,
        targetType: 'agent',
        targetId: agent.id,
        targetName: agent.name,
        detail: {
          runMode: 'remote',
          error: (err as Error).message,
          platformSessionId,
        },
        success: false,
      });
      yield { type: 'error', message: '远程智能体暂不可用' };
      return;
    }

    if (platformSessionId) {
      await this.db
        .update(schema.conversations)
        .set({ platformSessionId })
        .where(eq(schema.conversations.id, conversationId));
    }

    const answerId = randomUUID();
    const createdAt = new Date();
    await this.db.insert(schema.messages).values({
      id: answerId,
      conversationId,
      role: 'assistant',
      content,
      citations: citations as unknown[],
      followUps,
      retrievedChunkIds: [],
      modelKey: agent.name,
      elapsedMs: Date.now() - started,
      createdAt,
    });
    await this.db
      .update(schema.conversations)
      .set({
        messageCount: sql`${schema.conversations.messageCount} + 2`,
        updatedAt: createdAt,
        ...(existing.messageCount === 0 ? { title: input.question.slice(0, 30) } : {}),
      })
      .where(eq(schema.conversations.id, conversationId));

    await this.auditAsk(
      ctx,
      input,
      conversationId,
      citations,
      [],
      agent.name,
      degraded,
      Date.now() - started,
      'remote',
      platformSessionId,
    );

    yield {
      type: 'done',
      degraded,
      runMode: 'remote',
      message: {
        id: answerId,
        conversationId,
        role: 'assistant',
        content,
        citations,
        followUps,
        mailDraftId: null,
        modelKey: agent.name,
        elapsedMs: Date.now() - started,
        tokensIn: null,
        tokensOut: null,
        feedback: null,
        feedbackReason: null,
        createdAt: createdAt.toISOString(),
      },
    };
  }

  /** 把本系统上下文（智能体人设 + 历史 + 当前问题）翻译成平台消息形态 */
  private toPlatformMessages(question: string, history: { role: string; content: string }[], agent: AgentContext) {
    const systemParts: string[] = [];
    if (agent.systemPrompt) systemParts.push(agent.systemPrompt);
    for (const s of agent.skills) systemParts.push(`[${s.name}]\n${s.prompt}`);

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    if (systemParts.length) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }
    for (const h of history) {
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: 'user', content: question });
    return messages;
  }

  /**
   * 兜底：模型没按约定格式输出 email 代码块时，单独调一次模型做结构化提取。
   *
   * 为什么不直接用正则从回答里猜：实测模型常把自己的思考过程一起写出来，
   * 正则会把「事项：…」「需要对方做的事：…」当成邮件正文，主题也会被填成分析结论。
   * 多花一次调用换一封能直接发出去的邮件，值。
   */
  private async coerceMailDraft(answer: string): Promise<ParsedMailDraft | null> {
    // 输入太短说明这一轮压根没写邮件，此时硬让模型「提取」只会让它凭空编一封
    // （实测编出过一整套不存在的项目进度和署名日期）。宁可没有草稿。
    if (answer.trim().length < 80) return null;
    try {
      const result = await this.model.chat(
        [
          {
            role: 'system',
            content: [
              '从下面这段内容里提取出一封待发邮件，只输出 JSON，不要任何解释：',
              '{"to":[],"cc":[],"subject":"主题","body":"正文"}',
              '· subject 是邮件事由，20 字以内；',
              '· body 只放邮件正文本身（称呼、内容、落款），不要包含分析、清单、说明性文字；',
              '· 正文里的换行写成 \\n；',
              '· 邮箱地址未知就留空数组，不要编造。',
            ].join('\n'),
          },
          { role: 'user', content: answer.slice(0, 2000) },
        ],
        { maxTokens: 700 },
      );
      return extractMailDraft('```email\n' + result.content + '\n```').draft;
    } catch {
      return null;
    }
  }

  /* ─────────── 反馈与删除 ─────────── */

  async feedback(ctx: AuthContext, messageId: string, value: 'up' | 'down', reason?: string): Promise<void> {
    await this.db
      .update(schema.messages)
      .set({ feedback: value, feedbackReason: reason ?? null })
      .where(eq(schema.messages.id, messageId));
  }

  async rename(ctx: AuthContext, conversationId: string, title: string): Promise<Conversation> {
    await this.assertOwner(ctx, conversationId);
    await this.db
      .update(schema.conversations)
      .set({ title: title.trim().slice(0, 120), updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));
    return this.toConversation(await this.mustGetConversation(conversationId));
  }

  async togglePin(ctx: AuthContext, conversationId: string): Promise<Conversation> {
    await this.assertOwner(ctx, conversationId);
    const row = await this.mustGetConversation(conversationId);
    await this.db.update(schema.conversations).set({ isPinned: !row.isPinned }).where(eq(schema.conversations.id, conversationId));
    return this.toConversation(await this.mustGetConversation(conversationId));
  }

  async toggleFavorite(ctx: AuthContext, conversationId: string): Promise<Conversation> {
    await this.assertOwner(ctx, conversationId);
    const row = await this.mustGetConversation(conversationId);
    await this.db.update(schema.conversations).set({ isFavorite: !row.isFavorite }).where(eq(schema.conversations.id, conversationId));
    return this.toConversation(await this.mustGetConversation(conversationId));
  }

  async remove(ctx: AuthContext, conversationId: string): Promise<void> {
    await this.assertOwner(ctx, conversationId);
    await this.db.update(schema.conversations).set({ deletedAt: new Date() }).where(eq(schema.conversations.id, conversationId));
  }

  /* ─────────── 内部 ─────────── */

  private async mustGetConversation(id: string) {
    const rows = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: '会话不存在' });
    return row;
  }

  private async assertOwner(ctx: AuthContext, conversationId: string): Promise<void> {
    const row = await this.mustGetConversation(conversationId);
    if (row.ownerId !== ctx.userId) throw new AppError(ErrorCode.FORBIDDEN, { message: '你无权访问该会话' });
  }

  private async recentHistory(conversationId: string): Promise<{ role: string; content: string }[]> {
    const rows = await this.db
      .select({ role: schema.messages.role, content: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(HISTORY_LIMIT);
    return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  }

  private toConversation(r: typeof schema.conversations.$inferSelect): Conversation {
    return {
      id: r.id,
      title: r.title,
      ownerId: r.ownerId,
      modelKey: r.modelKey ?? null,
      scopeKbIds: r.scopeKbIds ?? [],
      messageCount: r.messageCount,
      isPinned: r.isPinned,
      isFavorite: r.isFavorite,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}

/**
 * 把平台原生的「引用」事件翻译成本系统的 Citation。
 *
 * 关键点：远程引用对应的是聚智知识库文档，本系统没有 fileId/kbId，
 * 所以 fileId/kbId 留空、kbName 标注「远程知识库」、chunkId 复用平台 docId 便于去重。
 * 前端按 fileId 缺失识别为「远端来源」，渲染细节卡片而不是回链本地预览。
 */
function remoteRefsToCitations(
  refs: { id: string; source?: string; snippet?: string; page?: number }[],
): Citation[] {
  return refs.map((r, i) => ({
    index: i + 1,
    fileId: '',
    fileName: r.source ?? r.id,
    kbId: '',
    kbName: '远程知识库',
    chunkId: r.id,
    page: r.page ?? null,
    snippet: r.snippet,
  }));
}

/** 把召回的片段转成引用列表，回答里用 [1][2] 回链 */
function buildCitations(hits: RetrievedChunk[]): Citation[] {
  const seen = new Map<string, number>();
  return hits
    .map((h) => {
      const idx = seen.get(h.fileId) ?? 0;
      seen.set(h.fileId, idx + 1);
      return {
        index: 0,
        fileId: h.fileId,
        fileName: h.fileName,
        kbId: h.kbId,
        chunkId: h.chunkId,
        page: h.page ?? null,
        snippet: h.content.slice(0, 200),
        score: h.score,
      };
    })
    .map((c, i) => ({ ...c, index: i + 1 }));
}

/** 智能体上下文：人设提示词 + 装配技能的提示词片段 */
export interface AgentContext {
  id: string;
  name: string;
  systemPrompt: string;
  /** 智能体自己指定的模型，空表示跟随全局默认 */
  modelKey: string | null;
  /** 内置标识：周报助手 / 邮件助手 / 报账流程，用于触发对应能力 */
  builtinKey: string | null;
  skills: { name: string; prompt: string }[];
  /** 智能体自己挂的检索范围，非空时优先于请求里传的 */
  scopeKbIds: string[];
  /** 运行模式：local=本地 RAG + LLM；remote=转发到聚智平台智能体 */
  runMode: 'local' | 'remote';
  /** 远程模式下需要的 assistant code；runMode=remote 时必须填 */
  platformAssistantCode: string | null;
}

/**
 * 问答的采样温度。
 *
 * 平台默认温度偏高，实测同一问题会补出制度里根本没有的材料项（例如凭空要求「合同复印件」）。
 * 制度问答要的是「照着资料说」，创造性越低越忠实，所以显式压低。
 */
const ANSWER_TEMPERATURE = 0.2;

/**
 * 引用标注要求。默认人设与智能体人设都要带上它 —— 「每句话有出处」是制度问答的底线。
 *
 * 附一个例子是因为纯规则约束力不够：实测模型经常整篇不标 [n]，
 * 给了样子之后稳定得多。最后一条专治「资料不全就自己补」的幻觉。
 */
const CITATION_RULE = [
  '· 凡是来自资料的结论，都在该句末尾紧跟 [n]（n 是资料编号），不标编号等于这句话没有依据；',
  '  例：资料 [1] 写「一线城市 500 元每晚」，就写成「一线城市住宿标准 500 元每晚 [1]」；',
  '· 资料里没有列出的材料项、金额、时限一律不要补充，宁可说明「资料中没有提到」。',
];

/** 无智能体时的默认人设（企业知识助手） */
const DEFAULT_SYSTEM = [
  '你是企业知识助手。先判断问题属于哪一类，再决定怎么回答：',
  '',
  '【业务问题】问的是公司制度、流程、费用、报销、材料、合同、项目资料等内部信息：',
  '· 只依据下面提供的资料回答；',
  ...CITATION_RULE,
  '· 资料里确实没有的，说明「资料中没有找到」，并指出还缺哪类材料。',
  '',
  '【其他问题】不属于上面范围的，例如写代码、通用知识、技术问题、算数、翻译、打招呼、',
  '问你的能力或系统怎么用：用你自己的知识正常、完整地回答。',
  '· 不要说「资料中没有」，不要引用资料，也不要建议对方补充资料；',
  '· 拿不准属于哪一类时，按这一类处理：直接回答，不要拒答、不要反问对方要更多信息。',
  '',
  '总体上简洁、分点、不说套话。',
].join('\n');

/** 组装模型上下文：系统提示 + 历史 + 引用片段 + 当前问题 */
function buildPrompt(question: string, hits: RetrievedChunk[], history: { role: string; content: string }[], agent?: AgentContext | null) {
  // 智能体模式下用它的专属人设；通用要求仍保留，保证引用标注和「不拒答」这两条底线不被绕过
  const system = agent
    ? [
        `你是「${agent.name}」。${agent.systemPrompt}`,
        agent.skills.length ? `\n【已装配技能】\n${agent.skills.map((sk) => `· ${sk.name}\n${sk.prompt}`).join('\n\n')}` : '',
        '',
        '【通用要求】',
        ...CITATION_RULE,
        '· 与资料无关的问题（写代码、通用知识、寒暄）直接用自身知识回答，不要拒答或反问要资料；',
        '· 简洁、分点、不说套话。',
      ]
        .filter(Boolean)
        .join('\n')
    : DEFAULT_SYSTEM;

  const context = hits.length
    ? `\n\n参考资料：\n${hits.map((h, i) => `[${i + 1}]《${h.fileName}》${h.page ? `第 ${h.page} 页` : ''}\n${h.content}`).join('\n\n')}`
    : '\n\n（本次没有检索到相关资料：业务问题就说明未找到，其他问题直接用你自己的知识回答。）';

  return [
    { role: 'system' as const, content: system },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: `问题：${question}${context}` },
  ];
}

/**
 * 流式输出时过滤掉不该给用户看的部分。
 *
 * 两类内容需要拦在外面：
 * 1. 邮件草稿块（```email {...}）—— 它是给系统落库的结构化数据，不该显示成 JSON；
 * 2. 追问标记（---追问---）—— 早期方案留下的兜底，模型偶尔还会吐出来。
 *
 * 做法是：这些标记一旦出现就停止外发，只累积到 buffer 里供解析；
 * 并且始终保留尾部若干字符不吐，避免标记的前半截被当成正文发出去。
 */
class AnswerSplitter {
  private buffer = '';
  private emitted = 0;
  private stopped = false;

  push(piece: string): string {
    if (this.stopped) return '';
    this.buffer += piece;

    const cut = this.findStop();
    let limit: number;
    if (cut >= 0) {
      this.stopped = true;
      limit = cut;
    } else {
      limit = Math.max(0, this.buffer.length - RESERVE);
    }

    if (limit <= this.emitted) return '';
    const out = this.buffer.slice(this.emitted, limit);
    this.emitted = limit;
    return out;
  }

  flush(): string {
    if (this.stopped) return '';
    if (this.findStop() >= 0) return '';
    const out = this.buffer.slice(this.emitted);
    this.emitted = this.buffer.length;
    return out;
  }

  private findStop(): number {
    const candidates = MAIL_FENCES.map((lang) => this.buffer.indexOf('```' + lang)).filter((i) => i >= 0);
    const follow = this.buffer.indexOf(FOLLOW_UP_MARK);
    if (follow >= 0) candidates.push(follow);
    return candidates.length ? Math.min(...candidates) : -1;
  }

  get full(): string {
    return this.buffer;
  }
}

/**
 * 从模型的追问输出里挑出真正可用的那几条。
 * 模型偶尔会复述指令（「用户最可能接着问的3个问题如下」）或把带引用的正文捞进来，
 * 这里按几个简单特征过滤掉，宁少勿滥。
 */
function pickFollowUps(raw: string): string[] {
  const banned = ['如下', '以下', '示例', '问题如下', '追问', '要求：', '输出'];
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter((line) => line.length >= 4 && line.length <= 24)
    .filter((line) => !/[[\]（）()「」"']/.test(line))
    .filter((line) => !banned.some((word) => line.includes(word)))
    .slice(0, 3);
}

/**
 * 决定这次检索的范围。
 * 智能体挂了知识库就以它为准 —— 否则用户随手取消一个 @ 就能让它去翻不该翻的库。
 */
function resolveScope(agent: AgentContext | null, requested?: string[]): string[] {
  if (agent && agent.scopeKbIds.length > 0) return agent.scopeKbIds;
  return requested ?? [];
}
