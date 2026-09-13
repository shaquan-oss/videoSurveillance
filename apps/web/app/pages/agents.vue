<script setup lang="ts">
import type { Agent, AgentCard, KnowledgeBase, ModelInfo, Skill } from '@kh/shared';

const api = useApi();
const { can, user } = useAuth();

const { data: agents, refresh: refreshAgents } = await useAsyncData(
  'agents',
  async () => {
    try {
      return await api.listAgents();
    } catch {
      return [] as AgentCard[];
    }
  },
  { default: () => [] as AgentCard[] },
);

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

const { data: kbsData } = await useAsyncData(
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

const { data: skillsData } = await useAsyncData(
  'skills-for-agent',
  async () => {
    try {
      return await api.publishedSkills();
    } catch {
      return [] as Skill[];
    }
  },
  { default: () => [] as Skill[] },
);
const skills = computed(() => skillsData.value);

const chatModels = computed(() => models.value.filter((m) => m.capabilities?.includes('chat')));

/* ─────────── 卡片 ─────────── */

const myAgents = computed(() => agents.value.filter((a) => a.ownerId === user.value?.id));
const others = computed(() => agents.value.filter((a) => a.ownerId !== user.value?.id));

function visibilityText(a: AgentCard) {
  if (a.visibility === 'company') return '全公司可用';
  if (a.visibility === 'department') return '本部门可用';
  return '仅自己可见';
}

function statusText(a: AgentCard) {
  if (a.publishStatus === 'published') return '已发布';
  if (a.publishStatus === 'disabled') return '已停用';
  return '草稿';
}

async function duplicate(a: AgentCard) {
  try {
    await api.duplicateAgent(a.id);
    toast(`已复制「${a.name}」到我的智能体`);
    await refreshAgents();
  } catch (err) {
    toast(err instanceof Error ? err.message : '复制失败', 'err');
  }
}

async function togglePublish(a: AgentCard) {
  try {
    if (a.publishStatus === 'published') {
      await api.updateAgent(a.id, { publishStatus: 'disabled' });
      toast('已停用');
    } else {
      await api.publishAgent(a.id);
      toast('已发布');
    }
    await refreshAgents();
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败', 'err');
  }
}

async function remove(a: AgentCard) {
  if (a.isBuiltin) {
    toast('内置智能体不能删除，可以改成「停用」', 'err');
    return;
  }
  if (!confirm(`删除智能体「${a.name}」？`)) return;
  try {
    await api.removeAgent(a.id);
    toast('已删除');
    await refreshAgents();
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'err');
  }
}

/* ─────────── 五步向导 ─────────── */

const STEPS = ['基本信息', '选择模型', '挂知识库', '装技能', '权限与发布'] as const;

const dialog = ref(false);
const step = ref(0);
const editingId = ref<string | null>(null);
const saving = ref(false);
const error = ref('');

const form = reactive({
  icon: '🤖',
  name: '',
  description: '',
  example: '',
  triggerWords: '',
  systemPrompt: '',
  modelKey: '',
  scopeKbIds: [] as string[],
  skillIds: [] as string[],
  visibility: 'private' as Agent['visibility'],
  runMode: 'local' as 'local' | 'remote',
  platformAssistantCode: '',
});

const icons = ['🤖', '📝', '✉️', '💰', '📊', '🔍', '📋', '🧾'];

function resetForm() {
  Object.assign(form, {
    icon: '🤖',
    name: '',
    description: '',
    example: '',
    triggerWords: '',
    systemPrompt: '',
    modelKey: '',
    scopeKbIds: [],
    skillIds: [],
    visibility: 'private',
    runMode: 'local',
    platformAssistantCode: '',
  });
  error.value = '';
  testQuestion.value = '';
  testAnswer.value = '';
  tested.value = false;
}

function openCreate() {
  editingId.value = null;
  step.value = 0;
  resetForm();
  dialog.value = true;
}

function openEdit(a: AgentCard) {
  editingId.value = a.id;
  step.value = 0;
  resetForm();
  Object.assign(form, {
    icon: a.icon,
    name: a.name,
    description: a.description ?? '',
    example: a.example ?? '',
    triggerWords: a.triggerWords.join('，'),
    systemPrompt: a.systemPrompt,
    modelKey: a.modelKey ?? '',
    scopeKbIds: [...a.scopeKbIds],
    skillIds: [...a.skillIds],
    visibility: a.visibility,
    runMode: a.runMode ?? 'local',
    platformAssistantCode: a.platformAssistantCode ?? '',
  });
  tested.value = !!a.testedAt;
  dialog.value = true;
}

function toggleScope(id: string) {
  form.scopeKbIds = form.scopeKbIds.includes(id) ? form.scopeKbIds.filter((x) => x !== id) : [...form.scopeKbIds, id];
}

function toggleSkill(id: string) {
  form.skillIds = form.skillIds.includes(id) ? form.skillIds.filter((x) => x !== id) : [...form.skillIds, id];
}

const canNext = computed(() => {
  if (step.value === 0) return !!form.name.trim() && !!form.systemPrompt.trim();
  // 远程模式先把 assistantCode 填了，避免走到最后一步保存时才被后端打回
  if (step.value === 1 && form.runMode === 'remote') return !!form.platformAssistantCode.trim();
  return true;
});

async function saveDraft(): Promise<string | null> {
  if (saving.value) return null;
  saving.value = true;
  error.value = '';
  try {
    const payload = {
      icon: form.icon,
      name: form.name.trim(),
      description: form.description.trim(),
      example: form.example.trim(),
      systemPrompt: form.systemPrompt.trim(),
      triggerWords: form.triggerWords
        .split(/[,，;；\s]+/)
        .map((w) => w.trim())
        .filter(Boolean),
      modelKey: form.modelKey || null,
      scopeKbIds: form.scopeKbIds,
      skillIds: form.skillIds,
      visibility: form.visibility,
      runMode: form.runMode,
      // 本地模式下把 code 一并存着，方便来回切换不用重填；清了也不影响本地链路
      platformAssistantCode: form.platformAssistantCode.trim() || null,
    };
    if (editingId.value) {
      await api.updateAgent(editingId.value, payload);
    } else {
      const created = await api.createAgent(payload);
      editingId.value = created.id;
    }
    await refreshAgents();
    return editingId.value;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败';
    return null;
  } finally {
    saving.value = false;
  }
}

/* ─────────── 试跑（发布前的强制步骤）────────── */

const testQuestion = ref('');
const testAnswer = ref('');
const testing = ref(false);
const tested = ref(false);

async function runTest() {
  const q = testQuestion.value.trim();
  if (!q || testing.value) return;
  // 试跑前先落草稿：未保存的提示词没法试跑，也拿不到 agentId
  const id = editingId.value ?? (await saveDraft());
  if (!id) return;

  testing.value = true;
  testAnswer.value = '';
  try {
    const res = await api.ask({
      question: q,
      agentId: id,
      ...(form.scopeKbIds.length ? { scopeKbIds: form.scopeKbIds } : {}),
    });
    testAnswer.value = res.answer.content;
    await api.markAgentTested(id);
    tested.value = true;
  } catch (err) {
    testAnswer.value = `试跑失败：${err instanceof Error ? err.message : '未知错误'}`;
  } finally {
    testing.value = false;
  }
}

async function publish() {
  const id = editingId.value ?? (await saveDraft());
  if (!id) return;
  if (!tested.value) {
    error.value = '请先试跑一次，确认效果后再发布';
    return;
  }
  try {
    await api.publishAgent(id);
    toast('已发布');
    dialog.value = false;
    await refreshAgents();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '发布失败';
  }
}

async function saveOnly() {
  const id = await saveDraft();
  if (id) {
    toast('已保存为草稿');
    dialog.value = false;
    await refreshAgents();
  }
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
  <div>
    <div class="ph">
      <div>
        <h1>智能体</h1>
        <div class="desc">预置了人设、知识范围与技能的助手。点一下就带进对话，不用每次重述要求。</div>
      </div>
      <div class="spacer" />
      <button v-if="can('agent:create')" class="btn primary" @click="openCreate">＋ 创建智能体</button>
    </div>

    <div v-if="!agents.length" class="empty">
      <div class="t">还没有智能体</div>
      <div class="d">创建一个「报销助手」或「制度问答」试试。</div>
      <button v-if="can('agent:create')" class="btn primary sm" style="margin-top: 8px" @click="openCreate">创建第一个智能体</button>
    </div>

    <div v-else class="grid">
      <div v-for="a in agents" :key="a.id" class="card agent-card">
        <div class="agent-head">
          <span class="agent-ico">{{ a.icon }}</span>
          <div class="agent-titles">
            <div class="agent-name">
              {{ a.name }}
              <span v-if="a.isBuiltin" class="tag builtin">内置</span>
              <span v-if="a.runMode === 'remote'" class="tag remote" title="对话转发给聚智平台的原生智能体">远程</span>
              <span class="tag" :class="a.publishStatus">{{ statusText(a) }}</span>
            </div>
            <div class="tiny">{{ visibilityText(a) }}<template v-if="a.runCount"> · 用过 {{ a.runCount }} 次</template></div>
          </div>
        </div>

        <p class="agent-desc">
          <span class="like">说起来就像：</span>{{ a.example || a.description || '（无示例问法）' }}
        </p>

        <div class="meta">
          <span class="tiny">
            {{ a.kbNames.length ? `知识库：${a.kbNames.join('、')}` : '知识范围：全部可见知识库' }}
          </span>
          <span v-if="a.skillNames?.length" class="tiny">技能：{{ a.skillNames.join('、') }}</span>
        </div>

        <div class="agent-foot">
          <NuxtLink :to="{ path: '/chat', query: { agent: a.id } }" class="btn sm primary">对话</NuxtLink>
          <button class="btn sm" @click="openEdit(a)">编辑</button>
          <button class="btn sm" @click="duplicate(a)">复制</button>
          <span class="spacer" />
          <button v-if="!a.isBuiltin" class="btn sm" @click="togglePublish(a)">
            {{ a.publishStatus === 'published' ? '停用' : '发布' }}
          </button>
          <button v-if="!a.isBuiltin" class="btn sm danger" @click="remove(a)">删除</button>
        </div>
      </div>
    </div>

    <!-- 五步创建向导 -->
    <div v-if="dialog" class="mask" @click.self="dialog = false">
      <div class="modal" style="max-width: 760px">
        <div class="modal-h">
          <h3>{{ editingId ? '编辑智能体' : '创建智能体' }}</h3>
          <button class="x" @click="dialog = false">×</button>
        </div>

        <div class="steps">
          <span v-for="(s, i) in STEPS" :key="s" class="st" :class="{ on: i === step, done: i < step }">{{ i + 1 }} {{ s }}</span>
        </div>

        <div class="modal-b">
          <!-- 1 基本信息 -->
          <template v-if="step === 0">
            <div class="field">
              <label>图标</label>
              <div class="chips">
                <button v-for="ic in icons" :key="ic" class="chip icon-chip" :class="{ on: form.icon === ic }" @click="form.icon = ic">{{ ic }}</button>
              </div>
            </div>
            <div class="field"><label>名称</label><input v-model="form.name" placeholder="例如：报账小助手" /></div>
            <div class="field">
              <label>一句话说明</label>
              <input v-model="form.description" placeholder="例如：回答报账、报销、票据与差旅标准问题" />
            </div>
            <div class="field">
              <label>示例问法（列表页显示为「说起来就像：…」，选中后填入输入框）</label>
              <input v-model="form.example" placeholder="例如：报账需要哪些材料，依据是哪一条" />
            </div>
            <div class="field">
              <label>触发词（可选，用逗号分隔）</label>
              <input v-model="form.triggerWords" placeholder="例如：报账，报销，发票" />
            </div>
            <div class="field">
              <label>人设提示词</label>
              <textarea
                v-model="form.systemPrompt"
                rows="6"
                placeholder="定义它的行为边界，例如：你是报账助手，只依据知识库里的制度回答，每条结论标 [n]，制度里没有的明确说没找到…"
              />
            </div>
          </template>

          <!-- 2 运行模式与模型 -->
          <template v-else-if="step === 1">
            <div class="field">
              <label>运行模式</label>
              <div class="chips">
                <button class="chip" :class="{ on: form.runMode === 'local' }" @click="form.runMode = 'local'">本地</button>
                <button class="chip" :class="{ on: form.runMode === 'remote' }" @click="form.runMode = 'remote'">远程</button>
              </div>
              <div class="tiny">
                <template v-if="form.runMode === 'local'">
                  在本系统内完成检索与生成：模型、知识库、技能都在本地生效。
                </template>
                <template v-else>
                  转发给聚智平台的原生智能体，检索与生成都由平台负责。本地的模型、知识库、技能配置对远程回答不生效。
                </template>
              </div>
            </div>

            <div v-if="form.runMode === 'local'" class="field">
              <label>默认模型</label>
              <select v-model="form.modelKey" class="sel" style="width: 100%">
                <option value="">跟随全局默认</option>
                <option v-for="m in chatModels" :key="m.key" :value="m.key">
                  {{ m.displayName }}<template v-if="m.health">（{{ m.health.ok ? `正常 ${m.health.latencyMs}ms` : '不可用' }}）</template>
                </option>
              </select>
              <div class="tiny">模型不可用时系统会自动切到备用模型，并在回答上方提示。</div>
            </div>

            <div v-else class="field">
              <label>平台智能体编码（assistantCode）</label>
              <input v-model="form.platformAssistantCode" placeholder="在聚智平台智能体详情页获取" />
              <div class="tiny">
                需先在聚智平台创建好智能体并关联知识库。服务端 <code>.env</code> 还须配好
                <code>PLATFORM_HOST</code> / <code>PLATFORM_APP_ID</code> / <code>PLATFORM_APP_SECRET</code>，否则远程调用会直接失败。
              </div>
            </div>
          </template>

          <!-- 3 挂知识库 -->
          <template v-else-if="step === 2">
            <div v-if="form.runMode === 'remote'" class="mode-warn">
              当前是远程模式：检索由聚智平台的智能体自己做，这里选的本地知识库范围不生效。
            </div>
            <div class="field">
              <label>检索范围（不选 = 全部可见知识库）</label>
              <div class="chips">
                <button v-for="kb in kbs" :key="kb.id" class="chip" :class="{ on: form.scopeKbIds.includes(kb.id) }" @click="toggleScope(kb.id)">
                  {{ kb.name }}
                </button>
                <span v-if="!kbs.length" class="tiny">暂无知识库</span>
              </div>
              <div class="tiny">选了范围后，即使用户在对话里取消 @，也不会越界检索。</div>
            </div>
          </template>

          <!-- 4 装技能 -->
          <template v-else-if="step === 3">
            <div v-if="form.runMode === 'remote'" class="mode-warn">
              当前是远程模式：技能由聚智平台的智能体自己编排，这里装配的本地技能不生效。
            </div>
            <div class="field">
              <label>装配技能（可多选）</label>
              <div class="skill-list">
                <button
                  v-for="sk in skills"
                  :key="sk.id"
                  class="skill-item"
                  :class="{ on: form.skillIds.includes(sk.id) }"
                  @click="toggleSkill(sk.id)"
                >
                  <span class="sk-name">{{ sk.name }}</span>
                  <span class="sk-desc">{{ sk.description }}</span>
                  <span v-if="form.skillIds.includes(sk.id)" class="sk-ck">✓</span>
                </button>
                <span v-if="!skills.length" class="tiny">暂无已上架技能</span>
              </div>
            </div>
          </template>

          <!-- 5 权限与发布 -->
          <template v-else>
            <div class="field">
              <label>可见范围</label>
              <div class="chips">
                <button class="chip" :class="{ on: form.visibility === 'private' }" @click="form.visibility = 'private'">仅自己</button>
                <button class="chip" :class="{ on: form.visibility === 'department' }" @click="form.visibility = 'department'">本部门</button>
                <button class="chip" :class="{ on: form.visibility === 'company' }" @click="form.visibility = 'company'">全公司</button>
              </div>
            </div>

            <div class="field">
              <label>试跑（发布前必须做一次）</label>
              <div class="test-row">
                <input v-model="testQuestion" placeholder="问它一句，看看回答是否符合预期" @keyup.enter="runTest" />
                <button class="btn sm primary" :disabled="testing || !testQuestion.trim()" @click="runTest">
                  {{ testing ? '试跑中…' : '试跑' }}
                </button>
              </div>
              <div v-if="testAnswer" class="test-out">{{ testAnswer }}</div>
              <div v-if="tested" class="tiny ok-line">✓ 已试跑过，可以发布</div>
            </div>

            <div v-if="error" class="alert err">{{ error }}</div>
          </template>
        </div>

        <div class="modal-f">
          <button v-if="step > 0" class="btn" @click="step--">上一步</button>
          <span class="spacer" />
          <button class="btn" @click="dialog = false">取消</button>
          <button v-if="step < STEPS.length - 1" class="btn primary" :disabled="!canNext" @click="step++">下一步</button>
          <template v-else>
            <button class="btn" :disabled="saving" @click="saveOnly">保存为草稿</button>
            <button class="btn primary" :disabled="saving || !tested" @click="publish">发布</button>
          </template>
        </div>
      </div>
    </div>

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
.agent-card { display: flex; flex-direction: column; gap: 11px; padding: 18px; }
.agent-head { display: flex; align-items: center; gap: 11px; }
.agent-ico {
  width: 38px; height: 38px; border-radius: 10px; background: var(--brand-s);
  display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0;
}
.agent-titles { min-width: 0; }
.agent-name { font-size: 14.5px; font-weight: 500; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tag { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: var(--g100); color: var(--ink-3); font-weight: 400; }
.tag.published { background: var(--ok-s, #EAF3DE); color: var(--ok-t, #3B6D11); }
.tag.disabled { background: var(--er-s, #FCEBEB); color: var(--er-t, #A32D2D); }
.tag.builtin { background: var(--brand-s); color: var(--brand); }
.tag.remote { background: #ece1ff; color: #6b3fb5; }

/* 远程模式下「这块配置不生效」的提示条 */
.mode-warn {
  margin-bottom: 12px;
  padding: 9px 12px;
  border-radius: var(--r-sm);
  background: #f5efff;
  color: #6b3fb5;
  font-size: 12px;
  line-height: 1.6;
}
.agent-desc { font-size: 12.5px; color: var(--ink-2); line-height: 1.65; margin: 0; flex: 1; }
.like { color: var(--ink-3); }
.meta { display: flex; flex-direction: column; gap: 3px; }
.agent-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.steps { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 22px 14px; }
.st { font-size: 12px; color: var(--ink-3); border: 1px solid var(--line); border-radius: 999px; padding: 4px 11px; background: var(--surface); }
.st.on { color: var(--brand); border-color: var(--brand); background: var(--brand-s); font-weight: 500; }
.st.done { color: var(--ok-t, #3B6D11); border-color: var(--ok-l, var(--line)); }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  height: 30px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--r-full);
  background: var(--surface); font-size: 12.5px; font-family: inherit; color: var(--ink); cursor: pointer;
}
.chip.on { border-color: var(--brand); background: var(--brand-s); color: var(--brand); font-weight: 500; }
.icon-chip { width: 38px; padding: 0; font-size: 17px; }

.skill-list { display: flex; flex-direction: column; gap: 8px; }
.skill-item {
  display: flex; flex-direction: column; gap: 3px; text-align: left; width: 100%;
  padding: 11px 13px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--surface); cursor: pointer; font-family: inherit; position: relative;
}
.skill-item.on { border-color: var(--brand); background: var(--brand-s); }
.sk-name { font-size: 13px; font-weight: 500; color: var(--ink); }
.sk-desc { font-size: 11.5px; color: var(--ink-3); }
.sk-ck { position: absolute; right: 12px; top: 11px; color: var(--brand); }

.test-row { display: flex; gap: 8px; }
.test-row input { flex: 1; }
.test-out {
  margin-top: 10px; padding: 11px 13px; background: var(--g50); border-radius: var(--r-sm);
  font-size: 12.5px; line-height: 1.75; color: var(--ink); white-space: pre-wrap; max-height: 220px; overflow-y: auto;
}
.ok-line { color: var(--ok-t, #3B6D11); margin-top: 6px; }

textarea {
  width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 10px 12px; font-size: 13px; font-family: inherit; outline: none;
  background: var(--surface); color: var(--ink);
}
textarea:focus { border-color: var(--b400); }

.toasts { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 200; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { padding: 10px 18px; border-radius: var(--r-sm); background: var(--g900); color: #fff; font-size: 13px; }
.toast.err { background: var(--er-t); }
</style>
