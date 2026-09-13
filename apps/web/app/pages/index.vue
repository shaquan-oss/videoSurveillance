<script setup lang="ts">
import type { FileItem } from '@kh/shared';
import { formatBytes, formatRelativeTime, type ScheduledTask } from '@kh/shared';

const api = useApi();
const { user, can } = useAuth();
const { levelLabel, levelColor } = useFileMeta();

/**
 * 用 useAsyncData 而不是 onMounted：
 * 服务端渲染时就把数据取好，首屏 HTML 里直接有内容和系统状态，不会先闪骨架屏。
 */
const { data: usage } = await useAsyncData(
  'usage',
  async () => {
    try {
      return await api.usage();
    } catch {
      return null;
    }
  },
  { default: () => null },
);

const {
  data: recent,
  pending: loading,
  refresh: refreshRecent,
} = await useAsyncData(
  'recent-files',
  async () => {
    try {
      return (
        await api.listFiles({
          page: 1,
          pageSize: 5,
          sortBy: 'updatedAt',
          sortOrder: 'desc',
        })
      ).items;
    } catch {
      return [] as FileItem[];
    }
  },
  { default: () => [] as FileItem[] },
);

const { data: tasks, refresh: refreshTasks } = await useAsyncData(
  'workbench-tasks',
  async () => {
    try {
      return await api.listTasks();
    } catch {
      return [] as ScheduledTask[];
    }
  },
  { default: () => [] as ScheduledTask[] },
);

const { data: health } = await useAsyncData(
  'health',
  async () => {
    try {
      return await api.health();
    } catch {
      return null;
    }
  },
  { default: () => null },
);

const loadError = ref('');

const greeting = computed(() => {
  const h = new Date().getHours();
  const part = h < 6 ? '凌晨好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return `${part}，${user.value?.name ?? ''}`;
});

const checkLabels: Record<string, string> = {
  database: '数据库 PostgreSQL',
  redis: '缓存 Redis',
  storage: '对象存储 MinIO',
};

async function load() {
  await Promise.all([refreshRecent(), refreshNuxtData('usage'), refreshNuxtData('health')]);
}

/* ─────────── 定时任务 ─────────── */
async function toggleTask(task: ScheduledTask) {
  try {
    await api.toggleTask(task.id, task.status === 'active' ? 'paused' : 'active');
    await refreshTasks();
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败', 'err');
  }
}

async function removeTask(task: ScheduledTask) {
  if (!confirm(`删除定时任务「${task.name}」？`)) return;
  try {
    await api.removeTask(task.id);
    await refreshTasks();
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'err');
  }
}

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
        <h1>{{ greeting }}</h1>
        <div class="desc">文件统一管理、知识库问答、智能体与技能，都从这里开始。</div>
      </div>
      <div class="spacer" />
      <NuxtLink to="/chat" class="btn">开始提问</NuxtLink>
      <NuxtLink v-if="can('file:upload')" to="/files" class="btn primary">上传文件</NuxtLink>
    </div>

    <div v-if="loadError" class="alert err" style="margin-bottom: 18px">
      <div>
        <b>加载失败</b>
        <div style="margin-top: 4px">{{ loadError }}</div>
      </div>
    </div>

    <!-- 三个数字：一行细线分栏，不用浮起的卡片，避免视觉噪音 -->
    <div class="stats">
      <div class="stat">
        <div class="n num">{{ loading ? '—' : (usage?.totalFiles ?? 0) }}</div>
        <div class="l">你有权查看的文件</div>
      </div>
      <div class="stat">
        <div class="n num">{{ loading ? '—' : formatBytes(usage?.totalBytes ?? 0) }}</div>
        <div class="l">占用容量</div>
      </div>
      <div class="stat">
        <div class="n num">{{ loading ? '—' : (user?.permissions?.length ?? 0) }}</div>
        <div class="l">你的操作能力</div>
      </div>
    </div>

    <div class="cols">
      <div class="card">
        <div class="card-h">
          <h3>最近更新</h3>
          <span class="spacer" />
          <NuxtLink to="/files" class="tiny">全部文件 →</NuxtLink>
        </div>

        <div v-if="loading" style="padding: 18px 20px; display: flex; flex-direction: column; gap: 12px">
          <div v-for="i in 3" :key="i" class="skel" :style="{ width: `${88 - i * 9}%` }" />
        </div>

        <div v-else-if="recent.length === 0" class="empty">
          <div class="t">还没有文件</div>
          <div class="d">
            先上传一份制度或材料，之后就能在「文件管理」里统一管理，
            并逐步纳入知识库供问答引用。
          </div>
          <NuxtLink v-if="can('file:upload')" to="/files" class="btn primary sm" style="margin-top: 8px">
            去上传第一份文件
          </NuxtLink>
        </div>

        <table v-else>
          <thead>
            <tr>
              <th>名称</th>
              <th class="col-hide-md">密级</th>
              <th class="col-hide-md">修改人</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in recent" :key="f.id">
              <td>
                <div class="fname">
                  <span class="ext">{{ f.extension.toUpperCase() }}</span>
                  <span class="tname">{{ f.name }}</span>
                </div>
              </td>
              <td class="col-hide-md">
                <span class="secret">
                  <i :style="{ background: levelColor(f.securityLevel) }" />
                  {{ levelLabel(f.securityLevel) }}
                </span>
              </td>
              <td class="col-hide-md">{{ f.ownerName ?? '—' }}</td>
              <td class="tiny">{{ formatRelativeTime(f.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="side">
        <div class="card">
          <div class="card-h"><h3>系统状态</h3></div>
          <div class="card-b checks">
            <template v-if="loading">
              <div v-for="i in 3" :key="i" class="skel" style="width: 70%" />
            </template>
            <template v-else-if="health && health.checks">
              <div v-for="(c, key) in (health.checks ?? {})" :key="key" class="check">
                <span class="badge" :class="c.ok ? 'ok' : 'err'">
                  <span class="dot" />{{ c.ok ? '正常' : '异常' }}
                </span>
                <span class="ck-name">{{ checkLabels[key] ?? key }}</span>
                <span class="spacer" />
                <span class="tiny num">{{ c.latencyMs }}ms</span>
              </div>
              <!-- 向量模型降级不是服务故障，但会直接影响答准率，必须让人看见 -->
              <div v-if="health.retrieval?.degraded" class="degraded-note">
                检索降级：向量模型不可用，当前仅用关键词检索
              </div>
            </template>
            <div v-else class="tiny">无法获取状态</div>
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <h3>定时任务</h3>
            <span class="spacer" />
            <NuxtLink to="/admin" class="tiny">管理 →</NuxtLink>
          </div>
          <div class="card-b">
            <div v-if="!tasks.length" class="tiny">还没有定时任务。</div>
            <div v-for="t in tasks" :key="t.id" class="task-row">
              <span class="task-name">{{ t.name }}</span>
              <span class="badge" :class="t.status === 'active' ? 'ok' : ''">{{ t.status === 'active' ? '运行中' : '已暂停' }}</span>
              <span class="spacer" />
              <button class="act" @click="toggleTask(t)">{{ t.status === 'active' ? '暂停' : '恢复' }}</button>
              <button class="act danger" @click="removeTask(t)">删除</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>演示提示</h3></div>
          <div class="card-b">
            <p class="tip">
              把制度、材料<b>上传</b>到文件管理 → <b>纳入知识库</b> →
              在<b>智能体对话</b>里提问，即可得到带引用来源的回答。
            </p>
            <p class="tip" style="margin-top: 10px">
              用 <span class="mono">tech01</span> 和 <span class="mono">finance01</span> 分别登录，
              可以看到权限隔离：财务部限定文件对技术部不可见、也检索不到。
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: grid; grid-template-columns: repeat(3, 1fr);
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--sh-xs); margin-bottom: 18px;
}
.stat { padding: 18px 20px; border-right: 1px solid var(--line-soft); }
.stat:last-child { border-right: none; }
.stat .n { font-size: 24px; font-weight: 600; letter-spacing: -.02em; line-height: 1.2; }
.stat .l { font-size: 12px; color: var(--ink-3); margin-top: 4px; }

.cols { display: grid; grid-template-columns: 1.55fr 1fr; gap: 16px; align-items: start; }
.side { display: flex; flex-direction: column; gap: 16px; }

.fname { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ext {
  width: 22px; height: 24px; border-radius: 4px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 8.5px; font-weight: 600; background: var(--brand-s); color: var(--brand);
}
.tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.checks { display: flex; flex-direction: column; gap: 12px; }
.check { display: flex; align-items: center; gap: 10px; }
.ck-name { font-size: 12.5px; color: var(--ink-2); }
.degraded-note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--wn-t, #B8801A);
}

.tip { font-size: 12.5px; color: var(--ink-2); line-height: 1.75; margin: 0; }
.tip .mono { background: var(--g100); padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }

.task-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.task-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.toasts { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 200; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { padding: 10px 18px; border-radius: var(--r-sm); background: var(--g900); color: #fff; font-size: 13px; }
.toast.err { background: var(--er-t); }

@media (max-width: 1000px) {
  .cols { grid-template-columns: 1fr; }
  .stats { grid-template-columns: 1fr; }
  .stat { border-right: none; border-bottom: 1px solid var(--line-soft); }
  .stat:last-child { border-bottom: none; }
}
</style>
