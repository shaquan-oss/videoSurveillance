<script setup lang="ts">
import type { ScheduledTask } from '@kh/shared';

const api = useApi();
const { can } = useAuth();

const { data: tasks, refresh: refreshTasks } = await useAsyncData(
  'tasks',
  async () => {
    try {
      return await api.listTasks();
    } catch {
      return [] as ScheduledTask[];
    }
  },
  { default: () => [] as ScheduledTask[] },
);

/**
 * 把「每天早上9点」这类说法变成 cron。
 * 只覆盖办公场景最常见的几种说法；识别不了就明确告诉用户用预设或直接填 ——
 * 做一个猜不准的解析器比不做更糟。
 */
function parseSchedule(text: string): { cron: string; label: string } | null {
  const t = text.replace(/\s/g, '');
  const hourMatch = t.match(/([上下]午)?(\d{1,2})\s*[点:时]/);
  const rawHour = hourMatch ? Number(hourMatch[2]) : 9;
  const h = hourMatch && hourMatch[1] === '下午' && rawHour < 12 ? rawHour + 12 : rawHour;

  if (/每(天|日)/.test(t)) return { cron: `0 ${h} * * *`, label: `每天 ${h}:00` };
  if (/工作日/.test(t)) return { cron: `0 ${h} * * 1-5`, label: `每个工作日 ${h}:00` };
  if (/每周[一二三四五六日天]/.test(t)) {
    const map: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      日: 0,
      天: 0,
    };
    const day = t.match(/每周([一二三四五六日天])/)?.[1] ?? '一';
    return { cron: `0 ${h} * * ${map[day]}`, label: `每周${day} ${h}:00` };
  }
  if (/每月/.test(t)) {
    const dom = Number(t.match(/每月(\d{1,2})[号日]/)?.[1] ?? 1);
    return { cron: `0 ${h} ${dom} * *`, label: `每月 ${dom} 号 ${h}:00` };
  }
  return null;
}

/* ─────────── 创建 ─────────── */
const dialog = ref(false);
const form = reactive({
  name: '',
  schedule: '',
  cron: '',
  prompt: '',
  scopeKbIds: [] as string[],
});
const parsed = ref<{ cron: string; label: string } | null>(null);
const saving = ref(false);
const error = ref('');

const { data: kbsData } = await useAsyncData(
  'tasks-kbs',
  async () => {
    try {
      return await api.listKbs();
    } catch {
      return { visible: [], locked: [] };
    }
  },
  { default: () => ({ visible: [], locked: [] }) },
);
const kbs = computed(() => kbsData.value.visible);

const presets = [
  { label: '每个工作日 9:00', cron: '0 9 * * 1-5' },
  { label: '每天 18:00', cron: '0 18 * * *' },
  { label: '每周一 9:00', cron: '0 9 * * 1' },
  { label: '每月 1 号 9:00', cron: '0 9 1 * *' },
];

function openCreate() {
  Object.assign(form, {
    name: '',
    schedule: '',
    cron: '',
    prompt: '',
    scopeKbIds: [],
  });
  parsed.value = null;
  error.value = '';
  dialog.value = true;
}

function onScheduleInput() {
  parsed.value = parseSchedule(form.schedule);
  if (parsed.value) form.cron = parsed.value.cron;
}

function pickPreset(cron: string, label: string) {
  form.cron = cron;
  form.schedule = label;
  parsed.value = { cron, label };
}

function toggleScope(id: string) {
  form.scopeKbIds = form.scopeKbIds.includes(id) ? form.scopeKbIds.filter((x) => x !== id) : [...form.scopeKbIds, id];
}

async function save() {
  if (!form.name.trim() || !form.cron.trim() || !form.prompt.trim() || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await api.createTask({
      name: form.name.trim(),
      cron: form.cron,
      prompt: form.prompt.trim(),
      scopeKbIds: form.scopeKbIds,
    });
    dialog.value = false;
    toast('已创建定时任务');
    await refreshTasks();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '创建失败';
  } finally {
    saving.value = false;
  }
}

/* ─────────── 操作 ─────────── */
const runsOf = ref<string | null>(null);
const runs = ref<
  {
    id: string;
    status: string;
    detail: string;
    elapsedMs: number | null;
    startedAt: string;
  }[]
>([]);

async function toggleRuns(task: ScheduledTask) {
  if (runsOf.value === task.id) {
    runsOf.value = null;
    return;
  }
  runsOf.value = task.id;
  runs.value = [];
  try {
    runs.value = await api.taskRuns(task.id);
  } catch {
    /* 记录拿不到不影响列表 */
  }
}

async function toggle(task: ScheduledTask) {
  try {
    await api.toggleTask(task.id, task.status === 'active' ? 'paused' : 'active');
    toast(task.status === 'active' ? '已暂停' : '已恢复');
    await refreshTasks();
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败', 'err');
  }
}

async function runNow(task: ScheduledTask) {
  try {
    await api.runTaskNow(task.id);
    toast('已排入执行，一分钟内开始跑');
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败', 'err');
  }
}

async function remove(task: ScheduledTask) {
  if (!confirm(`删除定时任务「${task.name}」？`)) return;
  try {
    await api.removeTask(task.id);
    toast('已删除');
    await refreshTasks();
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'err');
  }
}

function whenText(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const unit =
    abs < 3600000
      ? `${Math.round(abs / 60000)} 分钟`
      : abs < 86400000
        ? `${Math.round(abs / 3600000)} 小时`
        : `${Math.round(abs / 86400000)} 天`;
  const stamp = d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${stamp}（${diff > 0 ? '还有' : '已过'} ${unit}）`;
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
        <h1>定时任务</h1>
        <div class="desc">让助手按点自己干活：每天早上整理待办、每周提醒上传票据。执行结果会通知你。</div>
      </div>
      <div class="spacer" />
      <button v-if="can('task:manage')" class="btn primary" @click="openCreate">＋ 新建任务</button>
    </div>

    <div v-if="!tasks.length" class="empty">
      <div class="t">还没有定时任务</div>
      <div class="d">试试「每个工作日 9:00 汇总昨天上传的文件」。</div>
      <button v-if="can('task:manage')" class="btn primary sm" style="margin-top: 8px" @click="openCreate">新建第一个任务</button>
    </div>

    <div v-else class="list">
      <div v-for="t in tasks" :key="t.id" class="card task-card">
        <div class="t-head">
          <div class="t-titles">
            <div class="t-name">
              {{ t.name }}
              <span class="tag" :class="t.status">{{ t.status === 'active' ? '运行中' : '已暂停' }}</span>
            </div>
            <div class="tiny">{{ t.cron }} · 上次 {{ t.lastRunAt ? whenText(t.lastRunAt) : '未执行' }}</div>
          </div>
          <span class="spacer" />
          <span class="tiny">下次：{{ whenText(t.nextRunAt) }}</span>
        </div>

        <p class="t-prompt">{{ t.prompt }}</p>

        <div class="t-ops">
          <button class="btn sm" @click="runNow(t)">立即执行</button>
          <button class="btn sm" @click="toggleRuns(t)">{{ runsOf === t.id ? '收起记录' : '执行记录' }}</button>
          <button class="btn sm" @click="toggle(t)">{{ t.status === 'active' ? '暂停' : '恢复' }}</button>
          <span class="spacer" />
          <button class="btn sm danger" @click="remove(t)">删除</button>
        </div>

        <div v-if="runsOf === t.id" class="runs">
          <div v-if="!runs.length" class="tiny">还没有执行记录。</div>
          <div v-for="r in runs" :key="r.id" class="run-row">
            <span class="badge" :class="r.status === 'success' ? 'ok' : 'err'">
              {{ r.status === 'success' ? '成功' : '失败' }}
            </span>
            <span class="tiny">{{ new Date(r.startedAt).toLocaleString('zh-CN') }}</span>
            <span v-if="r.elapsedMs" class="tiny num">{{ r.elapsedMs }}ms</span>
            <span class="run-detail">{{ r.detail }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建 -->
    <div v-if="dialog" class="mask" @click.self="dialog = false">
      <div class="modal" style="max-width: 560px">
        <div class="modal-h"><h3>新建定时任务</h3><button class="x" @click="dialog = false">×</button></div>
        <div class="modal-b">
          <div class="field"><label>任务名称</label><input v-model="form.name" placeholder="例如：每日票据提醒" /></div>

          <div class="field">
            <label>什么时候跑</label>
            <input v-model="form.schedule" placeholder="用一句话说，例如：每个工作日早上9点" @input="onScheduleInput" />
            <div class="presets">
              <button v-for="p in presets" :key="p.cron" class="chip" @click="pickPreset(p.cron, p.label)">{{ p.label }}</button>
            </div>
            <div v-if="form.schedule && !parsed" class="tiny warn-line">没听懂这句话，请用上面的预设，或直接在下面填 cron。</div>
            <div v-if="parsed" class="preview">
              <span class="tiny">解析结果</span>
              <b>{{ parsed.label }}</b>
              <span class="tiny mono">{{ parsed.cron }}</span>
            </div>
          </div>

          <div class="field">
            <label>cron 表达式（5 段：分 时 日 月 周）</label>
            <input v-model="form.cron" class="mono" placeholder="0 9 * * 1-5" />
          </div>

          <div class="field">
            <label>要它做什么</label>
            <textarea v-model="form.prompt" rows="4" placeholder="例如：汇总昨天各部门上传的票据文件，列出缺失清单并提醒对应负责人。" />
          </div>

          <div class="field">
            <label>检索范围（不选 = 全部可见知识库）</label>
            <div class="chips">
              <button
                v-for="kb in kbs"
                :key="kb.id"
                class="chip"
                :class="{ on: form.scopeKbIds.includes(kb.id) }"
                @click="toggleScope(kb.id)"
              >
                {{ kb.name }}
              </button>
            </div>
          </div>

          <div v-if="error" class="alert err">{{ error }}</div>
        </div>
        <div class="modal-f">
          <span class="tiny">周末自动跳过</span>
          <span class="spacer" />
          <button class="btn" @click="dialog = false">取消</button>
          <button
            class="btn primary"
            :disabled="saving || !form.name.trim() || !form.cron.trim() || !form.prompt.trim()"
            @click="save"
          >
            {{ saving ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.list { display: flex; flex-direction: column; gap: 14px; }
.task-card { display: flex; flex-direction: column; gap: 11px; padding: 18px; }
.t-head { display: flex; align-items: flex-start; gap: 12px; }
.t-titles { min-width: 0; }
.t-name { font-size: 14.5px; font-weight: 500; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tag { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--g100); color: var(--ink-3); font-weight: 400; }
.tag.active { background: var(--ok-s, #EAF3DE); color: var(--ok-t, #3B6D11); }
.t-prompt { font-size: 12.5px; color: var(--ink-2); line-height: 1.7; margin: 0; }
.t-ops { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.runs { display: flex; flex-direction: column; gap: 6px; padding: 12px; background: var(--g50); border-radius: var(--r-sm); }
.run-row { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.run-detail { color: var(--ink-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.chips, .presets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.chip {
  height: 28px; padding: 0 11px; border: 1px solid var(--line); border-radius: var(--r-full);
  background: var(--surface); font-size: 12px; font-family: inherit; color: var(--ink); cursor: pointer;
}
.chip.on { border-color: var(--brand); background: var(--brand-s); color: var(--brand); font-weight: 500; }
.preview { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 9px 12px; background: var(--brand-s); border-radius: var(--r-sm); font-size: 12.5px; }
.warn-line { color: var(--wn-t, #BA7517); margin-top: 6px; }

textarea {
  width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 10px 12px; font-size: 13px; font-family: inherit; outline: none;
  background: var(--surface); color: var(--ink);
}
.mono { font-family: var(--font-mono), ui-monospace, Menlo, monospace; }

.toasts { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 200; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { padding: 10px 18px; border-radius: var(--r-sm); background: var(--g900); color: #fff; font-size: 13px; }
.toast.err { background: var(--er-t); }
</style>
