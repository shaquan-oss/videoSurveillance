<script setup lang="ts">
import type { AgentCard, ChatMessage, Citation, Conversation, KnowledgeBase, MailDraft, ModelInfo } from '@kh/shared';

const api = useApi();
const { user } = useAuth();

/* ─────────── 会话列表 ─────────── */
const { data: conversations, refresh: refreshConvs } = await useAsyncData(
  'conversations',
  async () => {
    try {
      return await api.listConversations();
    } catch {
      return [] as Conversation[];
    }
  },
  { default: () => [] as Conversation[] },
);

const sessFilter = ref<'all' | 'fav' | 'pin'>('all');
const filteredConvs = computed(() => {
  const list = conversations.value ?? [];
  if (sessFilter.value === 'fav') return list.filter((c) => c.isFavorite);
  if (sessFilter.value === 'pin') return list.filter((c) => c.isPinned);
  return list;
});

const activeId = ref<string | null>(null);
const messages = ref<ChatMessage[]>([]);
const loadingMsgs = ref(false);

/* ─────────── 模型与知识库 ─────────── */
const { data: models } = await useAsyncData(
  'models',
  async () => {
    try {
      return await api.listModels();
    } catch {
      return [] as ModelInfo[];
    }
  },
  { default: () => [] as ModelInfo[] },
);

const { data: kbsData, refresh: refreshKbs } = await useAsyncData(
  'kbs',
  async () => {
    try {
      return await api.listKbs();
    } catch {
      return { visible: [] as KnowledgeBase[], locked: [] };
    }
  },
  { default: () => ({ visible: [] as KnowledgeBase[], locked: [] }) },
);
const kbs = computed(() => kbsData.value.visible);

const chatModels = computed(() => models.value.filter((m) => m.capabilities?.includes('chat')));
const selectedModel = ref('');
const scopeKbIds = ref<string[]>([]);

// 从知识库页「引用到对话」跳转来时，自动限定检索范围
const route = useRoute();
if (route.query.kb) scopeKbIds.value = [String(route.query.kb)];

/* ─────────── 视图状态 ─────────── */
const inThread = computed(() => activeId.value !== null || messages.value.length > 0);
const sending = ref(false);
const input = ref('');

/* ─────────── 引用来源抽屉 ─────────── */
const drawer = ref<Citation | null>(null);

/* ─────────── 会话操作 ─────────── */
const openMenuId = ref<string | null>(null);
const renamingId = ref<string | null>(null);
const renameValue = ref('');

function startNew() {
  activeId.value = null;
  messages.value = [];
  input.value = '';
  openMenuId.value = null;
}

async function openConversation(id: string) {
  activeId.value = id;
  loadingMsgs.value = true;
  openMenuId.value = null;
  try {
    messages.value = await api.conversationMessages(id);
  } catch {
    messages.value = [];
  } finally {
    loadingMsgs.value = false;
  }
}

/**
 * 发送提问。
 *
 * 走流式接口：先把「用户气泡 + 空的助手气泡」画出来，再随着 delta 事件往助手气泡里追加文字，
 * 用户能看到答案一个字一个字出来，而不是干等两三秒。
 */
async function send(text?: string) {
  const q = (text ?? input.value).trim();
  if (!q || sending.value) return;
  sending.value = true;
  input.value = '';
  degradedFrom.value = null;

  const now = new Date().toISOString();
  messages.value.push({
    id: `u-${Date.now()}`,
    conversationId: activeId.value ?? '',
    role: 'user',
    content: q,
    createdAt: now,
  });

  const draft: ChatMessage = {
    id: `a-${Date.now()}`,
    conversationId: activeId.value ?? '',
    role: 'assistant',
    content: '',
    citations: [],
    modelKey: null,
    createdAt: now,
  };
  messages.value.push(draft);
  scrollBottom();

  try {
    await api.askStream(
      {
        question: q,
        ...(activeId.value ? { conversationId: activeId.value } : {}),
        ...(selectedModel.value ? { modelKey: selectedModel.value } : {}),
        ...(scopeKbIds.value.length ? { scopeKbIds: scopeKbIds.value } : {}),
        ...(selectedAgentId.value ? { agentId: selectedAgentId.value } : {}),
      },
      (event) => {
        switch (event.type) {
          case 'start':
            activeId.value = event.conversationId;
            draft.conversationId = event.conversationId;
            draft.runMode = event.runMode;
            break;
          case 'citations':
            draft.citations = event.citations;
            break;
          case 'meta':
            draft.modelKey = event.modelKey;
            draft.runMode = event.runMode;
            if (event.degraded) degradedFrom.value = { modelKey: event.modelKey };
            break;
          case 'delta':
            draft.content += event.text;
            scrollBottom();
            break;
          case 'followUps':
            draft.followUps = event.items;
            break;
          case 'draft':
            setDraft(event.draft, draft.id);
            break;
          case 'done':
            Object.assign(draft, event.message);
            draft.runMode = event.runMode;
            if (event.message.mailDraftId) {
              // 消息落库后带上草稿 id，卡片据此取数据
              drafts.value = { ...drafts.value };
            }
            if (!activeId.value) void refreshConvs();
            break;
          case 'error':
            draft.content = draft.content || `抱歉，回答失败：${event.message}`;
            break;
        }
      },
    );
  } catch (err) {
    draft.content = draft.content || `抱歉，回答失败：${err instanceof Error ? err.message : '未知错误'}`;
  } finally {
    sending.value = false;
    scrollBottom();
  }
}

function scrollBottom() {
  nextTick(() => {
    const el = document.getElementById('msgScroll');
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/** 首选模型不可用、自动切了备用时，顶部显示提示条（原型里的 degrade 条） */
const degradedFrom = ref<{ modelKey: string } | null>(null);

function modelName(key: string) {
  return models.value.find((m) => m.key === key)?.displayName ?? key;
}

/**
 * 回答是否真的用到了引用。
 *
 * 检索到的片段和「模型实际引用」是两回事：模型可能压根没用（比如问的是寒暄），
 * 这时不该把引用卡片摆出来装作有依据。判断依据就是正文里有没有 [1] [2] 这样的标记。
 */
function usedCitations(m: ChatMessage) {
  return !!m.citations?.length && /\[\d+\]/.test(m.content);
}

/**
 * 引用是否来自远端（聚智平台）。
 *
 * 后端约定：远程模式下 fileId/kbId 都留空，kbName 填「远程知识库」。
 * 用 fileId 是否为空判断最稳——本地引用必有 UUID 形式的 fileId。
 */
function isRemoteCite(c: Citation): boolean {
  return !c.fileId;
}

/** 只有「没引用 + 明确说没找到」才是真的未命中，避免和引用卡片同时出现 */
function missedKb(m: ChatMessage) {
  return m.role === 'assistant' && !usedCitations(m) && /资料中没有|未找到|没有找到/.test(m.content);
}

/* ─────────── 边聊边补资料 ─────────── */
const uploadInput = ref<HTMLInputElement | null>(null);
const uploadTarget = ref<string | null>(null);
const uploading = ref(false);

function pickUpload() {
  const target = scopeKbIds.value[0] ?? (kbs.value.length === 1 ? kbs.value[0]!.id : null);
  if (!target) {
    toast('先点下方的 @ 知识库选一个，再上传', 'err');
    return;
  }
  uploadTarget.value = target;
  const el = uploadInput.value;
  if (!el) return;
  el.value = '';
  el.click();
}

async function onUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length || !uploadTarget.value) return;

  const form = new FormData();
  for (const f of files) {
    form.append('files', f);
    form.append('relPaths', f.name);
  }

  uploading.value = true;
  try {
    const res = await api.kbUpload(uploadTarget.value, form);
    toast(`已上传并纳入 ${res.okCount} 个文件${res.failCount ? `，${res.failCount} 个未能解析` : ''}`);
    await refreshKbs();
  } catch (err) {
    toast(err instanceof Error ? err.message : '上传失败', 'err');
  } finally {
    uploading.value = false;
  }
}

/* ─────────── 反馈 ─────────── */
const feedbackOpenFor = ref<string | null>(null);
async function feedback(msg: ChatMessage, value: 'up' | 'down', reason?: string) {
  try {
    await api.feedbackMessage(msg.id, value, reason);
    msg.feedback = value;
    msg.feedbackReason = reason ?? null;
    feedbackOpenFor.value = null;
  } catch {
    /* 忽略反馈失败 */
  }
}

/* ─────────── 会话菜单动作 ─────────── */
async function renameConv() {
  if (!renamingId.value) return;
  await api.renameConversation(renamingId.value, renameValue.value);
  renamingId.value = null;
  await refreshConvs();
}
async function pinConv(id: string) {
  await api.pinConversation(id);
  await refreshConvs();
  openMenuId.value = null;
}
async function favConv(id: string) {
  await api.favoriteConversation(id);
  await refreshConvs();
  openMenuId.value = null;
}
async function delConv(id: string) {
  if (!confirm('删除这个会话？')) return;
  await api.removeConversation(id);
  if (activeId.value === id) startNew();
  await refreshConvs();
}

/* ─────────── @ 引用 / / 技能 菜单 ─────────── */
const atOpen = ref(false);
const slashOpen = ref(false);

/**
 * @菜单的关闭行为。
 *
 * 原来只能"再点一次按钮"才能关，但用户普遍期望点空白处或按 Esc 就能关掉 ——
 * 菜单还会盖住下方的示例卡片，关不掉很恼人。
 * atMenuRef 同时包住按钮与菜单，据此判断点击是否落在它们之外。
 */
const atMenuRef = ref<HTMLElement | null>(null);

function onDocClick(e: MouseEvent) {
  if (!atOpen.value) return;
  const el = atMenuRef.value;
  if (el && !el.contains(e.target as Node)) atOpen.value = false;
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && atOpen.value) atOpen.value = false;
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKeydown);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKeydown);
});

function toggleScope(id: string) {
  scopeKbIds.value = scopeKbIds.value.includes(id) ? scopeKbIds.value.filter((x) => x !== id) : [...scopeKbIds.value, id];
}

/* ─────────── 示例卡片 ─────────── */
const examples = [
  {
    q: '差旅报销要准备哪些材料？流程是怎么走的？',
    label: '政策问答',
    icon: 'M3 2.5h7.5L13 5v8.5H3zM5.5 7h5M5.5 9.5h3.5',
  },
  {
    q: '设备巡检周期是怎么规定的？',
    label: '知识库没有的',
    icon: 'M8 5.5v3M8 10.5v.5',
    warn: true,
  },
];

const { renderMarkdown } = useMarkdown();

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

async function copyText(s: string) {
  try {
    await navigator.clipboard.writeText(s);
    toast('已复制回答');
  } catch {
    /* 忽略 */
  }
}

/* ─────────── 智能体 ─────────── */
const { data: agents } = await useAsyncData(
  'chat-agents',
  async () => {
    try {
      return await api.listAgents();
    } catch {
      return [] as AgentCard[];
    }
  },
  { default: () => [] as AgentCard[] },
);

const selectedAgentId = ref('');
const activeAgent = computed(() => agents.value.find((a) => a.id === selectedAgentId.value) ?? null);

/** 选中智能体：它的示例指令直接填进输入框，用户改两个字就能发 */
function pickAgent(agent: AgentCard) {
  selectedAgentId.value = selectedAgentId.value === agent.id ? '' : agent.id;
  if (selectedAgentId.value) input.value = agent.example || '';
}

function clearAgent() {
  selectedAgentId.value = '';
}

/* ─────────── 邮件草稿（外发前必须人工确认）────────── */
const drafts = ref<Record<string, MailDraft>>({});
const draftEditingId = ref<string | null>(null);
const draftBusy = ref<string | null>(null);
const draftNotice = ref('');

async function initMailStatus() {
  try {
    const { configured } = await api.mailStatus();
    if (!configured) draftNotice.value = '系统未配置邮件服务，确认后会把内容存为待发送，可复制正文自行发送';
  } catch {
    /* 邮件服务状态拿不到不影响主流程 */
  }
}
void initMailStatus();

function draftOf(m: ChatMessage): MailDraft | null {
  return m.mailDraftId ? (drafts.value[m.mailDraftId] ?? null) : null;
}

function setDraft(draft: MailDraft, messageId: string) {
  drafts.value = { ...drafts.value, [draft.id]: draft };
  // 让卡片能按消息 id 找到：消息上的 mailDraftId 来自 done 事件
  latestDraftMessage.value = messageId;
}

/** done 事件里的 message 才带 mailDraftId，流式期间先用 draft 事件记下 */
const latestDraftMessage = ref<string>('');

async function confirmSend(draft: MailDraft) {
  if (draftBusy.value) return;
  draftBusy.value = draft.id;
  try {
    const updated = await api.sendMail(draft.id);
    drafts.value = { ...drafts.value, [updated.id]: updated };
    toast(updated.status === 'sent' ? '邮件已发送' : '已存为待发送（未配置邮件服务）');
  } catch (err) {
    toast(err instanceof Error ? err.message : '发送失败', 'err');
  } finally {
    draftBusy.value = null;
  }
}

async function saveDraftEdit(draft: MailDraft, patch: Partial<MailDraft>) {
  draftBusy.value = draft.id;
  try {
    const updated = await api.updateMail(draft.id, {
      to: patch.to,
      cc: patch.cc,
      subject: patch.subject,
      body: patch.body,
    });
    drafts.value = { ...drafts.value, [updated.id]: updated };
    draftEditingId.value = null;
    toast('草稿已更新');
  } catch (err) {
    toast(err instanceof Error ? err.message : '保存失败', 'err');
  } finally {
    draftBusy.value = null;
  }
}

async function discardDraft(draft: MailDraft) {
  try {
    await api.removeMail(draft.id);
    const next = { ...drafts.value };
    delete next[draft.id];
    drafts.value = next;
    toast('草稿已丢弃');
  } catch (err) {
    toast(err instanceof Error ? err.message : '丢弃失败', 'err');
  }
}

const draftEditForm = reactive({ to: '', cc: '', subject: '', body: '' });

function openDraftEdit(draft: MailDraft) {
  Object.assign(draftEditForm, {
    to: draft.to.join(', '),
    cc: draft.cc.join(', '),
    subject: draft.subject,
    body: draft.body,
  });
  draftEditingId.value = draft.id;
}

function submitDraftEdit(draft: MailDraft) {
  void saveDraftEdit(draft, {
    to: draftEditForm.to
      .split(/[,;，；]/)
      .map((v) => v.trim())
      .filter(Boolean),
    cc: draftEditForm.cc
      .split(/[,;，；]/)
      .map((v) => v.trim())
      .filter(Boolean),
    subject: draftEditForm.subject,
    body: draftEditForm.body,
  });
}

/* ─────────── 轻提示 ─────────── */
const toasts = ref<{ id: number; text: string; kind: 'ok' | 'err' }[]>([]);
let seq = 0;
function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  const id = ++seq;
  toasts.value.push({ id, text, kind });
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 3000);
}
</script>

<template>
  <div class="chat">
    <!-- 左栏：会话 -->
    <aside class="sp">
      <div class="sp-h">
        <h3>会话</h3>
        <span class="spacer" />
        <button class="btn sm" @click="startNew">新建</button>
      </div>
      <div class="sp-filters">
        <span class="chip" :class="{ on: sessFilter === 'all' }" @click="sessFilter = 'all'">全部</span>
        <span class="chip" :class="{ on: sessFilter === 'fav' }" @click="sessFilter = 'fav'">收藏</span>
        <span class="chip" :class="{ on: sessFilter === 'pin' }" @click="sessFilter = 'pin'">置顶</span>
      </div>
      <div class="sp-list">
        <div v-if="!filteredConvs.length" class="tiny" style="padding: 14px 10px; color: var(--ink-3)">暂无会话</div>
        <div
          v-for="c in filteredConvs"
          :key="c.id"
          class="se"
          :class="{ active: activeId === c.id }"
          @click="openConversation(c.id)"
        >
          <span class="t">{{ c.title }}</span>
          <span class="sm" @click.stop="openMenuId = openMenuId === c.id ? null : c.id">···</span>
          <div class="tiny">{{ c.scopeKbIds.length ? `${c.scopeKbIds.length} 个库` : '全部库' }} · {{ new Date(c.updatedAt).toLocaleDateString('zh-CN') }}</div>
        </div>
      </div>

      <!-- 会话菜单 -->
      <div v-if="openMenuId" class="sess-menu" @click.stop>
        <div class="mi" @click="renamingId = openMenuId; renameValue = conversations.find(x => x.id === openMenuId)?.title ?? ''; openMenuId = null">重命名</div>
        <div class="mi" @click="pinConv(openMenuId)">置顶 / 取消置顶</div>
        <div class="mi" @click="favConv(openMenuId)">收藏 / 取消收藏</div>
        <div class="msep" />
        <div class="mi danger" @click="delConv(openMenuId)">删除</div>
      </div>
    </aside>

    <!-- 主区 -->
    <div class="th">
      <div class="th-h">
        <span class="th-title">{{ inThread ? (conversations.find(c => c.id === activeId)?.title ?? '对话') : '新会话' }}</span>
        <span class="spacer" />
        <span v-if="!inThread" class="tiny">直接说要做的事，或 @ 引用文件</span>
        <button v-else class="btn sm" @click="startNew">返回首页</button>
      </div>

      <!-- hero：新会话 -->
      <div v-if="!inThread" class="hero">
        <h2>今天帮你做什么？</h2>
        <div class="hero-sub">用一句话把事说清楚就行：找制度、写材料，我会自己从知识库里找依据。</div>

        <!-- 智能体：点一下就带上它的提示词与知识范围 -->
        <div v-if="agents.length" class="agent-row">
          <button
            v-for="a in agents"
            :key="a.id"
            class="agent-card"
            :class="{ on: selectedAgentId === a.id, remote: a.runMode === 'remote' }"
            @click="pickAgent(a)"
          >
            <span class="ac-ico">{{ a.icon }}</span>
            <span class="ac-body">
              <span class="ac-name">
                {{ a.name }}
                <span v-if="a.runMode === 'remote'" class="badge-remote" title="走聚智平台：模型与 RAG 都在远程">远程</span>
              </span>
              <span class="ac-desc">{{ a.description }}</span>
            </span>
          </button>
        </div>

        <div class="comp big">
          <textarea v-model="input" placeholder="例如：差旅报销要准备哪些材料？流程是怎么走的？" @keydown.enter.exact.prevent="send()" />
          <!-- atMenuRef 同时包住按钮与菜单，供「点击外部关闭」判断边界 -->
          <div ref="atMenuRef" class="at-wrap">
            <div class="cbar">
              <button class="upbtn" :disabled="uploading" @click="pickUpload">
                {{ uploading ? '上传中…' : '＋ 上传文件' }}
              </button>
              <button class="pill" :class="{ on: atOpen }" @click="atOpen = !atOpen; slashOpen = false"><span class="mention">@</span>引用知识库</button>
              <span class="spacer" />
              <button v-if="activeAgent" class="pill on" @click="clearAgent">
                {{ activeAgent.icon }} {{ activeAgent.name }} ×
              </button>
              <div class="mp">
                <select v-model="selectedModel" class="mp-select">
                  <option value="">默认模型</option>
                  <option v-for="m in chatModels" :key="m.key" :value="m.key">{{ m.displayName }}</option>
                </select>
              </div>
              <button class="send" :disabled="sending" @click="send()">发送</button>
            </div>
            <div v-if="atOpen" class="menu-wide">
              <div class="mh">引用知识库，限定这次回答的范围</div>
              <div v-for="kb in kbs" :key="kb.id" class="mwi" @click="toggleScope(kb.id)">
                <span class="nm">{{ kb.name }}</span>
                <span v-if="scopeKbIds.includes(kb.id)" class="ck">✓</span>
              </div>
              <div v-if="!kbs.length" class="mh">还没有知识库</div>
              <div v-else class="mh mh-foot">点击空白处或按 Esc 关闭 · 上传的文件会进入所选知识库</div>
            </div>
          </div>
        </div>

        <div class="hint-line">回答只引用你有权限查看且已纳入知识库的文件，点击引用可查看原文</div>

        <div class="examples">
          <div v-for="(ex, i) in examples" :key="i" class="excard" @click="send(ex.q)">
            <span class="ei" :class="{ warn: ex.warn }">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path :d="ex.icon" /></svg>
            </span>
            <div><div class="et">{{ ex.label }}</div><div class="ed">{{ ex.q }}</div></div>
          </div>
        </div>
      </div>

      <!-- 消息流 -->
      <div v-else class="msgs" id="msgScroll">
        <div v-if="degradedFrom" class="degrade">
          <span>首选模型当前不可用，已自动切换到「{{ modelName(degradedFrom.modelKey) }}」继续回答。</span>
          <span class="spacer" />
          <button class="btn sm" @click="degradedFrom = null">知道了</button>
        </div>

        <div v-if="loadingMsgs" class="tiny" style="padding: 20px; text-align: center; color: var(--ink-3)">加载中…</div>

        <template v-for="m in messages" :key="m.id">
          <div class="iw" :class="{ me: m.role === 'user' }">
            <div class="av" :class="m.role">{{ m.role === 'user' ? (user?.name?.[0] ?? '我') : 'AI' }}</div>
            <div class="iw-body">
              <!-- 远程模式徽标：放在气泡上方最显眼位置，避免用户把远程答案误以为本地处理 -->
              <div v-if="m.role === 'assistant' && m.runMode === 'remote'" class="runmode-tag remote">
                <span class="dot" />走聚智平台：模型与知识库检索都在远程
              </div>
              <div v-if="m.content" class="bub" v-html="m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content)" />
              <div v-else class="bub typing">正在检索知识库并组织回答<span class="dots"><i /><i /><i /></span></div>

              <!-- 引用卡片 -->
              <div v-if="usedCitations(m)" class="cites">
                <div
                  v-for="c in m.citations"
                  :key="c.index"
                  class="cite"
                  :class="{ remote: isRemoteCite(c) }"
                  :title="isRemoteCite(c) ? '远端引用：原文在聚智平台' : '点击查看原文片段'"
                  @click="isRemoteCite(c) ? toast('远端引用：原文在聚智平台，本地无法查看', 'err') : (drawer = c)"
                >
                  <span class="cite-ico">{{ isRemoteCite(c) ? 'CLOUD' : (c.fileName.includes('.pdf') ? 'PDF' : 'DOC') }}</span>
                  <span class="cite-txt">{{ isRemoteCite(c) ? (c.kbName || '远程知识库') : (c.fileName + (c.page ? ` · 第 ${c.page} 页` : '')) }}</span>
                </div>
              </div>

              <!-- 找不到依据 -->
              <div v-if="missedKb(m)" class="failnote">
                <span>已检索知识库，未命中相关片段。可能该制度尚未上传，或未纳入知识库，或你没有权限。</span>
              </div>

              <!-- 邮件草稿：外发前必须人工确认 -->
              <div v-if="draftOf(m)" class="mailcard">
                <div class="mc-h">
                  <span class="mc-dot" :class="draftOf(m)!.status"></span>
                  <span class="mc-title">邮件草稿</span>
                  <span class="mc-status">
                    {{
                      draftOf(m)!.status === 'sent'
                        ? '已发送'
                        : draftOf(m)!.status === 'unsent'
                          ? '待发送（未配置邮件服务）'
                          : draftOf(m)!.status === 'failed'
                            ? '发送失败'
                            : '待你确认'
                    }}
                  </span>
                </div>

                <template v-if="draftEditingId === draftOf(m)!.id">
                  <label class="mc-f"><span>收件人</span><input v-model="draftEditForm.to" placeholder="多个用逗号隔开" /></label>
                  <label class="mc-f"><span>抄送</span><input v-model="draftEditForm.cc" placeholder="可留空" /></label>
                  <label class="mc-f"><span>主题</span><input v-model="draftEditForm.subject" /></label>
                  <label class="mc-f"><span>正文</span><textarea v-model="draftEditForm.body" rows="7" /></label>
                  <div class="mc-ops">
                    <button class="btn sm" @click="draftEditingId = null">取消</button>
                    <button class="btn sm primary" :disabled="draftBusy === draftOf(m)!.id" @click="submitDraftEdit(draftOf(m)!)">保存</button>
                  </div>
                </template>

                <template v-else>
                  <div class="mc-row"><span class="mc-k">收件人</span><span class="mc-v">{{ draftOf(m)!.to.join('、') || '（待补填）' }}</span></div>
                  <div v-if="draftOf(m)!.cc.length" class="mc-row"><span class="mc-k">抄送</span><span class="mc-v">{{ draftOf(m)!.cc.join('、') }}</span></div>
                  <div class="mc-row"><span class="mc-k">主题</span><span class="mc-v">{{ draftOf(m)!.subject }}</span></div>
                  <pre class="mc-body">{{ draftOf(m)!.body }}</pre>
                  <div v-if="draftOf(m)!.error" class="mc-err">{{ draftOf(m)!.error }}</div>
                  <div class="mc-ops">
                    <template v-if="draftOf(m)!.status !== 'sent'">
                      <button class="btn sm" @click="openDraftEdit(draftOf(m)!)">修改措辞</button>
                      <button class="btn sm" @click="discardDraft(draftOf(m)!)">丢弃</button>
                      <button class="btn sm primary" :disabled="draftBusy === draftOf(m)!.id" @click="confirmSend(draftOf(m)!)">
                        {{ draftBusy === draftOf(m)!.id ? '发送中…' : '确认发送' }}
                      </button>
                    </template>
                    <button v-else class="btn sm" @click="copyText(draftOf(m)!.body)">复制正文</button>
                  </div>
                  <div v-if="draftNotice && draftOf(m)!.status !== 'sent'" class="mc-hint">{{ draftNotice }}</div>
                </template>
              </div>

              <!-- 追问建议：点一下就接着问 -->
              <div v-if="m.role === 'assistant' && m.followUps?.length" class="askchips">
                <span v-for="(f, fi) in m.followUps" :key="fi" class="ac" @click="send(f)">{{ f }}</span>
              </div>

              <!-- 回答操作 -->
              <div v-if="m.role === 'assistant'" class="ans-ops">
                <button class="btn sm" @click="copyText(m.content)">复制</button>
              </div>

              <!-- 反馈 -->
              <div v-if="m.role === 'assistant'" class="fb">
                <span class="tiny">这个回答有帮助吗</span>
                <button class="fbbtn" :class="{ on: m.feedback === 'up' }" @click="feedback(m, 'up')">有帮助</button>
                <button class="fbbtn" :class="{ on: m.feedback === 'down' }" @click="feedbackOpenFor = feedbackOpenFor === m.id ? null : m.id">有问题</button>
              </div>
              <div v-if="feedbackOpenFor === m.id" class="fbreasons">
                <div class="tiny">哪里有问题？</div>
                <span class="rsn" @click="feedback(m, 'down', '找不到依据')">找不到依据</span>
                <span class="rsn" @click="feedback(m, 'down', '答得不对')">答得不对</span>
                <span class="rsn" @click="feedback(m, 'down', '内容不完整')">内容不完整</span>
              </div>
            </div>
          </div>
        </template>

      </div>

      <!-- 输入区（有会话时） -->
      <div v-if="inThread" class="comp-area">
        <div class="comp">
          <textarea v-model="input" placeholder="继续说，或 @ 引用知识库…" @keydown.enter.exact.prevent="send()" />
          <div class="cbar">
            <button class="upbtn" :disabled="uploading" @click="pickUpload">
              {{ uploading ? '上传中…' : '＋ 上传文件' }}
            </button>
            <button v-for="kb in kbs" :key="kb.id" class="pill" :class="{ on: scopeKbIds.includes(kb.id) }" @click="toggleScope(kb.id)">@{{ kb.name }}</button>
            <button v-if="activeAgent" class="pill on" @click="clearAgent">
              {{ activeAgent.icon }} {{ activeAgent.name }} ×
            </button>
            <span class="spacer" />
            <select v-model="selectedModel" class="mp-select">
              <option value="">默认模型</option>
              <option v-for="m in chatModels" :key="m.key" :value="m.key">{{ m.displayName }}</option>
            </select>
            <button class="send" :disabled="sending" @click="send()">发送</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 引用来源抽屉 -->
    <div v-if="drawer" class="drawer-mask" @click.self="drawer = null">
      <aside class="drawer">
        <div class="drawer-h"><span class="t">引用来源</span><span class="spacer" /><button class="btn sm" @click="drawer = null">关闭</button></div>
        <div class="drawer-b">
          <h4>{{ drawer.fileName }}</h4>
          <div class="tiny" style="margin-bottom: 14px">{{ drawer.page ? `第 ${drawer.page} 页` : '' }}</div>
          <div class="src-pass">{{ drawer.snippet }}</div>
          <div class="tiny" style="margin-top: 14px">这是回答所引用的原文片段。</div>
        </div>
      </aside>
    </div>

    <!-- 重命名对话框 -->
    <div v-if="renamingId" class="mask" @click.self="renamingId = null">
      <div class="modal" style="max-width: 380px">
        <div class="modal-h"><h3>重命名会话</h3><button class="x" @click="renamingId = null">×</button></div>
        <div class="modal-b"><input v-model="renameValue" @keyup.enter="renameConv" /></div>
        <div class="modal-f"><span class="spacer" /><button class="btn" @click="renamingId = null">取消</button><button class="btn primary" @click="renameConv">保存</button></div>
      </div>
    </div>

    <!--
      文件选择器放在最外层：hero（新会话）与会话内两个工具栏都要用它。
      模板 ref 同名会被后者覆盖，所以只能留一份，且不能被 v-if 影响。
    -->
    <input ref="uploadInput" type="file" multiple style="display: none" @change="onUpload" />

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.chat { display: flex; height: calc(100vh - 56px - 26px - 40px); gap: 16px; }
.sp {
  width: 230px; flex-shrink: 0; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--r);
  display: flex; flex-direction: column; overflow: hidden;
}
.sp-h { display: flex; align-items: center; padding: 12px 14px; }
.sp-h h3 { font-size: 14px; font-weight: 500; margin: 0; }
.sp-filters { display: flex; gap: 6px; padding: 0 12px 8px; }
.chip { height: 24px; padding: 0 9px; border-radius: var(--r-full); font-size: 11.5px; display: flex; align-items: center; cursor: pointer; color: var(--ink-2); border: 1px solid transparent; }
.chip.on { color: var(--brand); background: var(--brand-s); }
.sp-list { flex: 1; overflow-y: auto; padding: 4px 8px 8px; position: relative; }
.se { position: relative; padding: 9px 10px; border-radius: var(--r-sm); cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.se:hover { background: var(--g100); }
.se.active { background: var(--brand-s); }
.se .t { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.se.active .t { color: var(--brand); font-weight: 500; }
.se .sm { position: absolute; right: 8px; top: 7px; color: var(--ink-3); font-size: 12px; }
.sess-menu {
  position: fixed; width: 172px; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-sm); box-shadow: var(--sh-pop); padding: 5px; z-index: 300;
  top: 50%; left: 260px; display: flex; flex-direction: column;
}
.mi { padding: 8px 10px; border-radius: var(--r-xs); font-size: 12.5px; cursor: pointer; color: var(--ink); }
.mi:hover { background: var(--g100); }
.mi.danger { color: var(--er-t); }
.msep { height: 1px; background: var(--line-soft); margin: 4px 0; }

.th { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
.th-h { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line-soft); }
.th-title { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.hero { flex: 1; overflow-y: auto; padding: 40px 60px; display: flex; flex-direction: column; align-items: center; }
.hero h2 { font-size: 22px; font-weight: 500; letter-spacing: -.01em; margin: 0 0 8px; }
.hero-sub { font-size: 13px; color: var(--ink-2); margin-bottom: 28px; text-align: center; }

.comp { position: relative; width: 100%; max-width: 720px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--sh-xs); padding: 12px; }
.comp textarea { width: 100%; min-height: 60px; border: none; outline: none; resize: none; font-size: 14px; font-family: inherit; background: transparent; color: var(--ink); }
.cbar { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.pill { display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--r-full); background: var(--surface); font-size: 12px; cursor: pointer; color: var(--ink-2); font-family: inherit; }
.pill.on { border-color: var(--brand); color: var(--brand); background: var(--brand-s); }
.mention { font-weight: 600; color: var(--brand); }
.mp-select { height: 26px; border: 1px solid var(--line); border-radius: var(--r-sm); font-size: 12px; font-family: inherit; background: var(--surface); color: var(--ink); padding: 0 6px; cursor: pointer; }
.send { margin-left: auto; height: 32px; padding: 0 16px; border: none; border-radius: var(--r-sm); background: var(--brand); color: #fff; font-size: 13px; cursor: pointer; font-family: inherit; }
.send:disabled { opacity: .5; cursor: not-allowed; }

.menu-wide { position: absolute; bottom: 66px; left: 12px; width: 260px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm); box-shadow: var(--sh-pop); padding: 6px; z-index: 20; }
/* 菜单底部的操作提示，与上面的知识库列表隔开 */
.mh-foot { border-top: 1px solid var(--line-soft); margin-top: 4px; padding-top: 8px; }
.mh { font-size: 11.5px; color: var(--ink-3); padding: 6px 8px; }
.mwi { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--r-xs); font-size: 13px; cursor: pointer; }
.mwi:hover { background: var(--g100); }
.mwi .nm { flex: 1; }
.mwi .ck { color: var(--brand); font-weight: 600; }

.hint-line { font-size: 11.5px; color: var(--ink-3); margin: 14px 0 24px; text-align: center; }
.examples { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; max-width: 720px; }
.excard { display: flex; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: var(--r); cursor: pointer; transition: border-color var(--t); }
.excard:hover { border-color: var(--b400); }
.ei { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; background: var(--brand-s); color: var(--brand); display: flex; align-items: center; justify-content: center; }
.ei.warn { background: var(--seal-soft); color: var(--seal); }
.et { font-size: 13px; font-weight: 500; }
.ed { font-size: 12px; color: var(--ink-2); margin-top: 3px; }

.msgs { flex: 1; overflow-y: auto; padding: 24px 40px; display: flex; flex-direction: column; gap: 22px; }
.iw { display: flex; gap: 12px; max-width: 82%; }
.iw.me { align-self: flex-end; flex-direction: row-reverse; }
.av { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 500; }
.av.ai { background: var(--brand); color: #fff; }
.av.me { background: var(--g300); color: var(--ink); }
.iw-body { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.bub { padding: 11px 14px; border-radius: var(--r); font-size: 13.5px; line-height: 1.75; background: var(--g50); word-break: break-word; }
.iw.me .bub { background: var(--brand); color: #fff; }
.bub :deep(.cite-mark) { color: var(--brand); font-weight: 500; font-size: 11px; vertical-align: super; margin: 0 1px; }

/* 回答里的 Markdown 排版 */
.bub :deep(p) { margin: 0 0 10px; line-height: 1.78; }
.bub :deep(p:last-child) { margin-bottom: 0; }
.bub :deep(h1), .bub :deep(h2), .bub :deep(h3), .bub :deep(h4) { font-size: 14px; font-weight: 500; margin: 16px 0 8px; line-height: 1.5; }
.bub :deep(h1:first-child), .bub :deep(h2:first-child), .bub :deep(h3:first-child) { margin-top: 0; }
.bub :deep(ul), .bub :deep(ol) { margin: 0 0 10px; padding-left: 20px; }
.bub :deep(li) { margin: 3px 0; line-height: 1.75; }
.bub :deep(li > p) { margin: 0; }
.bub :deep(strong) { font-weight: 500; }
.bub :deep(a) { color: var(--brand); text-decoration: underline; text-underline-offset: 2px; }
.bub :deep(blockquote) { margin: 0 0 10px; padding: 2px 0 2px 12px; border-left: 3px solid var(--line); color: var(--ink-2); }
.bub :deep(hr) { border: 0; border-top: 1px solid var(--line-soft); margin: 16px 0; }
.bub :deep(table) { border-collapse: collapse; width: 100%; margin: 0 0 12px; font-size: 12.5px; }
.bub :deep(th), .bub :deep(td) { border: 1px solid var(--line); padding: 6px 9px; text-align: left; }
.bub :deep(th) { background: var(--g50); font-weight: 500; }

/* 行内代码与代码块 */
.bub :deep(code) { font-family: var(--font-mono), ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; background: var(--g100); padding: 1px 5px; border-radius: 4px; }
.bub :deep(pre) { margin: 0 0 12px; padding: 12px 14px; background: var(--g50); border: 1px solid var(--line-soft); border-radius: var(--r-sm); overflow-x: auto; }
.bub :deep(pre code) { background: none; padding: 0; font-size: 12.5px; line-height: 1.68; }

/* 代码高亮配色 */
.bub :deep(.hljs-keyword), .bub :deep(.hljs-built_in), .bub :deep(.hljs-type) { color: #a626a4; }
.bub :deep(.hljs-string), .bub :deep(.hljs-attr), .bub :deep(.hljs-regexp) { color: #50a14f; }
.bub :deep(.hljs-number), .bub :deep(.hljs-literal) { color: #986801; }
.bub :deep(.hljs-comment), .bub :deep(.hljs-quote) { color: #9ca0a8; font-style: italic; }
.bub :deep(.hljs-title), .bub :deep(.hljs-function), .bub :deep(.hljs-section) { color: #4078f2; }
.bub :deep(.hljs-variable), .bub :deep(.hljs-params), .bub :deep(.hljs-property) { color: #383a42; }
.bub :deep(.hljs-meta) { color: #986801; }

.cites { display: flex; flex-wrap: wrap; gap: 8px; }
.cite { display: flex; align-items: center; gap: 7px; padding: 6px 10px; background: var(--surface); border: 1px solid var(--line-soft); border-radius: var(--r-sm); cursor: pointer; font-size: 12px; }
.cite:hover { border-color: var(--b400); }
.cite-ico { font-size: 10px; font-weight: 600; color: var(--brand); background: var(--brand-s); padding: 2px 5px; border-radius: 3px; }
.cite-txt { color: var(--ink-2); }

/* 远端引用：紫底，不可点开抽屉，鼠标悬浮提示「原文在聚智平台」 */
.cite.remote { background: var(--seal-soft, #f5efff); border-color: #d6c5f2; cursor: not-allowed; }
.cite.remote .cite-ico { color: #6b3fb5; background: #ece1ff; }
.cite.remote:hover { border-color: #d6c5f2; }
.cite.remote .cite-txt { color: #6b3fb5; }

/* 远端回答徽标：放在 assistant 气泡上方，让用户一眼看到这条不是本地走的 */
.runmode-tag {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px; border-radius: var(--r-full);
  font-size: 11px; line-height: 1.4; align-self: flex-start;
}
.runmode-tag.remote { background: var(--seal-soft, #f5efff); color: #6b3fb5; }
.runmode-tag .dot { width: 6px; height: 6px; border-radius: 50%; background: #6b3fb5; }

/* 智能体卡片的「远程」角标 —— 远端智能体一眼可辨 */
.badge-remote {
  display: inline-block; margin-left: 6px; padding: 0 6px; height: 16px; line-height: 16px;
  font-size: 10px; font-weight: 500; color: #6b3fb5; background: #ece1ff;
  border-radius: 8px; vertical-align: middle;
}
.agent-card.remote { border-color: #d6c5f2; }
.agent-card.remote.on { background: #ece1ff; }

.failnote { padding: 10px 12px; background: var(--wn-s); color: var(--wn-t); border-radius: var(--r-sm); font-size: 12px; line-height: 1.6; }
.ans-ops { display: flex; gap: 8px; }
.fb { display: flex; align-items: center; gap: 10px; }
.fbbtn { height: 26px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--r-full); background: var(--surface); font-size: 12px; cursor: pointer; color: var(--ink-2); font-family: inherit; }
.fbbtn.on { border-color: var(--brand); color: var(--brand); background: var(--brand-s); }
.fbreasons { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

.upbtn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  font-size: 12px;
  font-family: inherit;
  color: var(--ink-2);
  cursor: pointer;
  transition: border-color var(--t), color var(--t);
}
.upbtn:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); }
.upbtn:disabled { color: var(--ink-3); cursor: default; }

.agent-row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin: 18px 0 4px; }
.agent-card {
  display: flex; align-items: flex-start; gap: 9px; max-width: 260px; text-align: left;
  padding: 11px 13px; border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--surface); cursor: pointer; font-family: inherit;
  transition: border-color var(--t), background var(--t);
}
.agent-card:hover { border-color: var(--brand); }
.agent-card.on { border-color: var(--brand); background: var(--brand-s, var(--g50)); }
.ac-ico { font-size: 16px; line-height: 1.2; }
.ac-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ac-name { font-size: 13px; font-weight: 500; color: var(--ink); }
.ac-desc { font-size: 11.5px; color: var(--ink-3); line-height: 1.5; }

.mailcard {
  margin-top: 12px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--surface); overflow: hidden; max-width: 560px;
}
.mc-h { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--g50); border-bottom: 1px solid var(--line-soft); }
.mc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--wn-t, #BA7517); }
.mc-dot.sent { background: var(--ok-t, #3B6D11); }
.mc-dot.failed { background: var(--er-t, #A32D2D); }
.mc-title { font-size: 12.5px; font-weight: 500; color: var(--ink); }
.mc-status { margin-left: auto; font-size: 11.5px; color: var(--ink-3); }
.mc-row { display: flex; gap: 10px; padding: 7px 12px 0; font-size: 12.5px; }
.mc-k { color: var(--ink-3); flex-shrink: 0; width: 42px; }
.mc-v { color: var(--ink); min-width: 0; word-break: break-all; }
.mc-body {
  margin: 9px 12px 0; padding: 10px 12px; background: var(--g50); border-radius: var(--r-sm);
  font-family: inherit; font-size: 12.5px; line-height: 1.7; color: var(--ink);
  white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto;
}
.mc-err { margin: 8px 12px 0; font-size: 12px; color: var(--er-t); }
.mc-hint { margin: 8px 12px 0; font-size: 11.5px; color: var(--ink-3); }
.mc-ops { display: flex; gap: 8px; padding: 10px 12px 12px; }
.mc-f { display: flex; align-items: flex-start; gap: 10px; padding: 8px 12px 0; font-size: 12.5px; color: var(--ink-3); }
.mc-f > span { width: 42px; flex-shrink: 0; padding-top: 6px; }
.mc-f input, .mc-f textarea {
  flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 6px 9px; font-size: 12.5px; font-family: inherit; outline: none; resize: vertical;
}

.askchips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.ac {
  font-size: 12.5px;
  color: var(--brand);
  background: var(--brand-s, var(--g100));
  border-radius: 999px;
  padding: 5px 13px;
  cursor: pointer;
  transition: background var(--t);
}
.ac:hover { background: var(--brand-t, var(--g200)); }

.degrade {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 26px 14px;
  padding: 10px 14px;
  border: 1px solid var(--wn-l, var(--line));
  background: var(--wn-s, var(--g50));
  color: var(--wn-t, var(--ink-2));
  border-radius: var(--r-sm);
  font-size: 12.5px;
}
.rsn { padding: 4px 10px; border: 1px solid var(--line); border-radius: var(--r-full); font-size: 11.5px; cursor: pointer; color: var(--ink-2); }
.rsn:hover { border-color: var(--brand); color: var(--brand); }

.typing { font-size: 13px; color: var(--ink-2); }
.dots i { display: inline-block; width: 4px; height: 4px; border-radius: 50%; background: var(--ink-3); margin-left: 3px; animation: blink 1.2s infinite; }
.dots i:nth-child(2) { animation-delay: .2s; }
.dots i:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }

.comp-area { padding: 12px 16px; border-top: 1px solid var(--line-soft); }
.comp-area .comp textarea { min-height: 44px; }

.drawer-mask { position: fixed; inset: 0; z-index: 250; background: rgba(16, 24, 40, .28); display: flex; justify-content: flex-end; }
.drawer { width: 440px; max-width: 92vw; background: var(--surface); display: flex; flex-direction: column; box-shadow: var(--sh-lg); }
.drawer-h { display: flex; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--line-soft); }
.drawer-h .t { font-size: 14px; font-weight: 500; }
.drawer-b { flex: 1; overflow-y: auto; padding: 20px; }
.drawer-b h4 { font-size: 15px; margin: 0 0 6px; }
.src-pass { padding: 14px; background: var(--g50); border-radius: var(--r-sm); font-size: 13px; line-height: 1.8; }

.mask { position: fixed; inset: 0; z-index: 300; background: rgba(16, 24, 40, .45); display: flex; align-items: center; justify-content: center; }
.modal { width: 100%; max-width: 400px; background: var(--surface); border-radius: var(--r-l); box-shadow: var(--sh-pop); overflow: hidden; }
.modal-h { display: flex; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--line-soft); }
.modal-h h3 { font-size: 14px; margin: 0; font-weight: 500; }
.x { margin-left: auto; border: none; background: none; font-size: 18px; cursor: pointer; color: var(--ink-3); }
.modal-b { padding: 20px; }
.modal-b input { width: 100%; height: 36px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 12px; font-size: 13px; font-family: inherit; outline: none; }
.modal-f { display: flex; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--line-soft); }

.toasts { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 400; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { padding: 10px 18px; border-radius: var(--r-sm); background: var(--g900); color: #fff; font-size: 13px; }
.toast.err { background: var(--er-t); }
</style>
