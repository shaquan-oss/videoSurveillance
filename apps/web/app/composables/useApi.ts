import type {
  Agent,
  AgentCard,
  ApiResponse,
  AskEvent,
  ChatMessage,
  Citation,
  Conversation,
  FileItem,
  Folder,
  KbFolder,
  KbTreeFile,
  KnowledgeBase,
  MailDraft,
  ModelInfo,
  Paginated,
  RetrievedChunk,
  ScheduledTask,
  Skill,
  StorageUsage,
  User,
} from '@kh/shared';

/**
 * 接口调用层 —— 全站唯一的 HTTP 出口。
 *
 * 三个设计要点：
 * 1. 后端返回统一信封 { success, data, error, requestId }，这里拆开并把错误
 *    变成异常抛出，页面里就不用每次都判 success。
 * 2. 错误码与中文文案来自后端，前端只负责展示，避免两边各写一套提示。
 * 3. SSR 阶段通过 useRequestFetch 自动带上浏览器 Cookie，刷新页面不会闪一下登录页。
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

type FetchOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, unknown>;
  /** 传 FormData 时不要设置 Content-Type，交给浏览器带 boundary */
  formData?: FormData;
};

export function useApi() {
  // SSR 时需要用 useRequestFetch 才能把浏览器的 Cookie 带到服务端请求上
  const fetcher = import.meta.server ? useRequestFetch() : $fetch;

  async function request<T>(path: string, options: FetchOptions = {}): Promise<T> {
    const url = `/api${path.startsWith('/') ? path : `/${path}`}`;

    try {
      const res = (await fetcher(url, {
        method: options.method ?? 'GET',
        credentials: 'include',
        query: options.query,
        body: options.formData ?? (options.body as Record<string, unknown> | undefined),
      })) as ApiResponse<T>;

      if (!res || res.success !== true) {
        throw new ApiError(res?.error?.code ?? 'INTERNAL', res?.error?.message ?? '请求失败', 200, res?.requestId);
      }
      return res.data as T;
    } catch (err) {
      // $fetch 遇到非 2xx 会抛 FetchError，响应体在 err.data 里
      const data = (err as { data?: ApiResponse<unknown> }).data;
      if (data?.error) {
        throw new ApiError(data.error.code, data.error.message, (err as { status?: number }).status ?? 0, data.requestId);
      }
      if (err instanceof ApiError) throw err;
      throw new ApiError('NETWORK_ERROR', '无法连接服务，请检查网络或稍后重试', 0);
    }
  }

  return {
    /* ───────── 认证 ───────── */
    login: (account: string, password: string) =>
      request<{ user: User; expiresInSec: number }>('/auth/login', {
        method: 'POST',
        body: { account, password },
      }),
    logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
    me: () => request<User>('/auth/me'),

    /* ───────── 健康 ───────── */
    health: () =>
      request<{
        ok: boolean;
        checks: Record<string, { ok: boolean; latencyMs: number; message?: string }>;
        /** 检索链路状态：向量模型降级时为 degraded，此时检索只用关键词 */
        retrieval?: { degraded: boolean; reason?: string; since?: string };
        uptimeSec: number;
      }>('/health'),

    /* ───────── 文件 ───────── */
    listFiles: (query: Record<string, unknown>) => request<Paginated<FileItem>>('/files', { query }),
    getFile: (id: string) => request<FileItem>(`/files/${id}`),
    downloadUrl: (id: string) => request<{ url: string; expiresInSec: number; name: string }>(`/files/${id}/download-url`),
    usage: () => request<StorageUsage>('/files/usage'),
    renameFile: (id: string, name: string) =>
      request<FileItem>(`/files/${id}/rename`, {
        method: 'PATCH',
        body: { name },
      }),
    setSecurity: (
      id: string,
      body: {
        securityLevel: string;
        visibleDeptIds: string[];
        visibleUserIds?: string[];
      },
    ) => request<FileItem>(`/files/${id}/security`, { method: 'PATCH', body }),
    favorite: (id: string, value: boolean) =>
      request<FileItem>(`/files/${id}/favorite`, {
        method: 'PATCH',
        body: { value },
      }),
    removeFile: (id: string) => request<{ ok: boolean }>(`/files/${id}`, { method: 'DELETE' }),
    purgeFile: (id: string) => request<{ ok: boolean }>(`/files/${id}/purge`, { method: 'DELETE' }),
    purgeAllTrash: () => request<{ removed: number }>('/files/purge-all', { method: 'POST' }),
    restoreFile: (id: string) => request<{ ok: boolean }>(`/files/${id}/restore`, { method: 'POST' }),
    moveFile: (id: string, folderId: string | null) =>
      request<FileItem>(`/files/${id}/move`, {
        method: 'PATCH',
        body: { folderId },
      }),
    batchMove: (ids: string[], folderId: string | null) =>
      request<{
        results: { id: string; ok: boolean; reason?: string }[];
        okCount: number;
      }>('/files/batch/move', { method: 'POST', body: { ids, folderId } }),
    batchDelete: (ids: string[]) =>
      request<{
        results: { id: string; ok: boolean; reason?: string }[];
        okCount: number;
      }>('/files/batch/delete', { method: 'POST', body: { ids } }),
    upload: (form: FormData) =>
      request<{
        results: {
          name: string;
          ok: boolean;
          file?: FileItem;
          error?: string;
        }[];
        okCount: number;
        failCount: number;
      }>('/files/upload', { method: 'POST', formData: form }),
    previewUrl: (id: string) =>
      request<{
        url: string;
        expiresInSec: number;
        name: string;
        previewable: boolean;
      }>(`/files/${id}/preview-url`),

    /* ───────── 文件夹 ───────── */
    listFolders: () => request<Folder[]>('/files/folders/all'),
    createFolder: (name: string, parentId?: string | null) =>
      request<Folder>('/files/folders', {
        method: 'POST',
        body: { name, parentId: parentId ?? null },
      }),
    renameFolder: (id: string, name: string) =>
      request<{ ok: boolean }>(`/files/folders/${id}`, {
        method: 'PATCH',
        body: { name },
      }),
    removeFolder: (id: string, force = false) =>
      request<{ removed: { folders: number; files: number } }>(`/files/folders/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),

    /* ───────── 模型 ───────── */
    listModels: () => request<ModelInfo[]>('/models'),

    /* ───────── 知识库 ───────── */
    listKbs: () =>
      request<{
        visible: KnowledgeBase[];
        locked: { name: string; fileCount: number }[];
      }>('/kb'),
    createKb: (body: { name: string; description?: string; isTeamSpace?: boolean; securityLevel?: string; visibleDeptIds?: string[] }) =>
      request<KnowledgeBase>('/kb', { method: 'POST', body }),
    removeKb: (kbId: string) => request<{ ok: boolean }>(`/kb/${kbId}`, { method: 'DELETE' }),
    kbTree: (kbId: string) => request<{ folders: KbFolder[]; files: KbTreeFile[] }>(`/kb/${kbId}/tree`),
    ingestToKb: (kbId: string, fileId: string, kbFolderId?: string | null) =>
      request<{ ok: boolean; chunkCount: number }>(`/kb/${kbId}/ingest`, {
        method: 'POST',
        body: { fileId, kbFolderId },
      }),
    /** 批量纳入（文件管理里勾选多个文件时用） */
    ingestFilesToKb: (kbId: string, fileIds: string[], kbFolderId?: string | null) =>
      request<{
        okCount: number;
        failCount: number;
        results: {
          fileId: string;
          name: string;
          ok: boolean;
          error?: string;
        }[];
      }>(`/kb/${kbId}/ingest-files`, {
        method: 'POST',
        body: { fileIds, kbFolderId },
      }),
    /** 纳入整个文件夹：知识库里会镜像出同名目录层级 */
    ingestFolderToKb: (kbId: string, folderId: string, kbFolderId?: string | null) =>
      request<{ okCount: number; failCount: number; folderCount: number }>(`/kb/${kbId}/ingest-folder`, {
        method: 'POST',
        body: { folderId, kbFolderId },
      }),
    /** 上传到知识库（多文件 / 整个文件夹，上传即入库） */
    kbUpload: (kbId: string, form: FormData) =>
      request<{
        okCount: number;
        failCount: number;
        results: {
          name: string;
          ok: boolean;
          fileId?: string;
          chunkCount?: number;
          error?: string;
        }[];
      }>(`/kb/${kbId}/upload`, { method: 'POST', formData: form }),
    kbCreateFolder: (kbId: string, name: string, parentId?: string | null) =>
      request<KbFolder>(`/kb/${kbId}/folders`, {
        method: 'POST',
        body: { name, parentId: parentId ?? null },
      }),
    kbRemoveFolder: (kbId: string, folderId: string) =>
      request<{ ok: boolean }>(`/kb/${kbId}/folders/${folderId}`, {
        method: 'DELETE',
      }),
    kbMoveFile: (kbId: string, fileId: string, kbFolderId: string | null) =>
      request<{ ok: boolean }>(`/kb/${kbId}/files/${fileId}/move`, {
        method: 'PATCH',
        body: { kbFolderId },
      }),
    kbSearch: (kbId: string, query: string, topK?: number) =>
      request<{
        query: string;
        scopeKbIds: string[];
        blockedFileCount: number;
        hits: RetrievedChunk[];
        elapsedMs: number;
      }>(`/kb/${kbId}/search`, { method: 'POST', body: { query, topK } }),
    kbRemoveFile: (fileId: string) => request<{ ok: boolean }>(`/kb/files/${fileId}`, { method: 'DELETE' }),
    kbPreview: (fileId: string) =>
      request<{
        name: string;
        extension: string;
        indexed: boolean;
        blocks: { heading?: string; content: string; page?: number | null }[];
      }>(`/kb/files/${fileId}/preview`),
    kbCreateDocument: (
      kbId: string,
      body: {
        name: string;
        content: string;
        extension?: 'md' | 'csv';
        kbFolderId?: string | null;
      },
    ) => request<FileItem>(`/kb/${kbId}/documents`, { method: 'POST', body }),

    /**
     * 流式提问。
     *
     * 这里必须用原生 fetch 而不是 $fetch —— 只有前者能拿到 ReadableStream 逐块读取；
     * $fetch 会等整个响应结束再返回，流式就白做了。
     * 事件通过 onEvent 回调交给页面，页面按事件类型更新 UI。
     */
    askStream: async (
      body: {
        question: string;
        conversationId?: string | null;
        modelKey?: string;
        scopeKbIds?: string[];
        agentId?: string;
        /** 要直读的文件（用户刚上传的），后端会把整份内容并入上下文 */
        attachFileIds?: string[];
      },
      onEvent: (event: AskEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const res = await fetch('/api/conversations/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
        signal,
      });
      if (!res.ok || !res.body) {
        throw new ApiError('STREAM_FAILED', `提问失败（HTTP ${res.status}）`, res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 事件以空行分隔
        let sep = buffer.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buffer.slice(0, sep).trim();
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf('\n\n');
          if (!raw.startsWith('data:')) continue;
          try {
            onEvent(JSON.parse(raw.slice(5).trim()) as AskEvent);
          } catch {
            // 单个事件解析失败不该中断整条流
          }
        }
      }
    },

    /* ───────── 对话 ───────── */
    listConversations: () => request<Conversation[]>('/conversations'),
    createConversation: (body?: { modelKey?: string; scopeKbIds?: string[] }) =>
      request<Conversation>('/conversations', {
        method: 'POST',
        body: body ?? {},
      }),
    conversationMessages: (id: string) => request<ChatMessage[]>(`/conversations/${id}/messages`),
    ask: (body: { question: string; conversationId?: string; modelKey?: string; scopeKbIds?: string[]; agentId?: string }) =>
      request<{ answer: ChatMessage; citations: Citation[] }>('/conversations/ask', { method: 'POST', body }),
    feedbackMessage: (messageId: string, value: 'up' | 'down', reason?: string) =>
      request<{ ok: boolean }>(`/conversations/messages/${messageId}/feedback`, { method: 'POST', body: { value, reason } }),
    renameConversation: (id: string, title: string) =>
      request<Conversation>(`/conversations/${id}/rename`, {
        method: 'PATCH',
        body: { title },
      }),
    pinConversation: (id: string) => request<Conversation>(`/conversations/${id}/pin`, { method: 'POST' }),
    favoriteConversation: (id: string) =>
      request<Conversation>(`/conversations/${id}/favorite`, {
        method: 'POST',
      }),
    removeConversation: (id: string) => request<{ ok: boolean }>(`/conversations/${id}`, { method: 'DELETE' }),

    /* ───────── 智能体 ───────── */
    listAgents: () => request<AgentCard[]>('/agents'),
    getAgent: (id: string) => request<AgentCard>(`/agents/${id}`),
    createAgent: (body: Partial<Agent>) => request<Agent>('/agents', { method: 'POST', body }),
    updateAgent: (id: string, body: Partial<Agent>) => request<Agent>(`/agents/${id}`, { method: 'PATCH', body }),
    removeAgent: (id: string) => request<{ ok: boolean }>(`/agents/${id}`, { method: 'DELETE' }),
    publishAgent: (id: string) => request<Agent>(`/agents/${id}/publish`, { method: 'POST' }),
    markAgentTested: (id: string) => request<{ ok: boolean }>(`/agents/${id}/tested`, { method: 'POST' }),
    duplicateAgent: (id: string) => request<Agent>(`/agents/${id}/duplicate`, { method: 'POST' }),

    /* ───────── 技能（装配用）───────── */
    listSkills: () => request<Skill[]>('/skills'),
    publishedSkills: () => request<Skill[]>('/skills/published'),
    installSkill: (id: string) =>
      request<{ installCount: number }>(`/skills/${id}/install`, {
        method: 'POST',
      }),
    matchSkills: (text: string) => request<Skill[]>('/skills/match', { query: { text } }),
    createSkill: (body: Partial<Skill>) => request<Skill>('/skills', { method: 'POST', body }),
    updateSkill: (id: string, body: Partial<Skill>) => request<Skill>(`/skills/${id}`, { method: 'PATCH', body }),
    reviewSkill: (id: string, approve: boolean) =>
      request<Skill>(`/skills/${id}/review`, {
        method: 'POST',
        body: { approve },
      }),
    removeSkill: (id: string) => request<{ ok: boolean }>(`/skills/${id}`, { method: 'DELETE' }),

    /* ───────── 邮件（草稿 → 确认发送）───────── */
    mailStatus: () => request<{ configured: boolean }>('/mail/status'),
    listMail: () => request<MailDraft[]>('/mail'),
    getMail: (id: string) => request<MailDraft>(`/mail/${id}`),
    updateMail: (id: string, body: { to?: string[]; cc?: string[]; subject?: string; body?: string }) =>
      request<MailDraft>(`/mail/${id}`, { method: 'PATCH', body }),
    sendMail: (id: string) => request<MailDraft>(`/mail/${id}/send`, { method: 'POST' }),
    removeMail: (id: string) => request<{ ok: boolean }>(`/mail/${id}`, { method: 'DELETE' }),

    /* ───────── 定时任务 ───────── */
    listTasks: () => request<ScheduledTask[]>('/tasks'),
    createTask: (body: { name: string; cron: string; prompt: string; modelKey?: string; scopeKbIds?: string[] }) =>
      request<ScheduledTask>('/tasks', { method: 'POST', body }),
    updateTask: (id: string, body: Partial<ScheduledTask>) => request<ScheduledTask>(`/tasks/${id}`, { method: 'PATCH', body }),
    toggleTask: (id: string, status: 'active' | 'paused') =>
      request<ScheduledTask>(`/tasks/${id}/toggle`, {
        method: 'POST',
        body: { status },
      }),
    removeTask: (id: string) => request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' }),
    taskRuns: (id: string) =>
      request<
        {
          id: string;
          status: string;
          detail: string;
          elapsedMs: number | null;
          startedAt: string;
        }[]
      >(`/tasks/${id}/runs`),
    runTaskNow: (id: string) => request<{ ok: boolean }>(`/tasks/${id}/run-now`, { method: 'POST' }),

    /* ───────── 管理后台 ───────── */
    adminUsers: () => request<unknown[]>('/admin/users'),
    adminRoles: () => request<unknown[]>('/admin/roles'),
    adminDepartments: () => request<unknown[]>('/admin/departments'),
    adminAuditLogs: (limit?: number) => request<unknown[]>(`/admin/audit-logs${limit ? `?limit=${limit}` : ''}`),
    adminAnalytics: (days?: number) =>
      request<{
        days: number;
        missedQuestions: {
          question: string;
          times: number;
          lastAt: string | null;
        }[];
        topQuestions: { question: string; times: number }[];
        daily: { day: string; hit: number; miss: number }[];
      }>(`/admin/analytics${days ? `?days=${days}` : ''}`),
    probeModels: () => request<ModelInfo[]>('/models/probe', { method: 'POST' }),
  };
}
