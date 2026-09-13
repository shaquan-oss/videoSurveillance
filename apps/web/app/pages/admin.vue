<script setup lang="ts">
import type { ModelInfo } from '@kh/shared';
import { formatBytes } from '@kh/shared';

const api = useApi();
const { can } = useAuth();

const tab = ref<'models' | 'audit' | 'people' | 'usage'>('models');

/* ─────────── 模型与通道 ─────────── */
const { data: models, refresh: refreshModels } = await useAsyncData(
  'admin-models',
  async () => {
    try {
      return await api.listModels();
    } catch {
      return [] as ModelInfo[];
    }
  },
  { default: () => [] as ModelInfo[] },
);

const probing = ref(false);
async function probe() {
  probing.value = true;
  try {
    await api.probeModels();
    await refreshModels();
  } finally {
    probing.value = false;
  }
}

/* ─────────── 审计日志 ─────────── */
const { data: audit, refresh: refreshAudit } = await useAsyncData(
  'admin-audit',
  async () => {
    try {
      return await api.adminAuditLogs(100);
    } catch {
      return [] as unknown[];
    }
  },
  { default: () => [] as unknown[] },
);

/* ─────────── 人员与权限 ─────────── */
const { data: users } = await useAsyncData(
  'admin-users',
  async () => {
    try {
      return await api.adminUsers();
    } catch {
      return [] as unknown[];
    }
  },
  { default: () => [] as unknown[] },
);

const { data: roles } = await useAsyncData(
  'admin-roles',
  async () => {
    try {
      return await api.adminRoles();
    } catch {
      return [] as unknown[];
    }
  },
  { default: () => [] as unknown[] },
);

const { data: departments } = await useAsyncData(
  'admin-depts',
  async () => {
    try {
      return await api.adminDepartments();
    } catch {
      return [] as unknown[];
    }
  },
  { default: () => [] as unknown[] },
);

/* ─────────── 问答分析（阶段5：哪些问题没找到依据）─────────── */
const { data: analytics } = await useAsyncData(
  'admin-analytics',
  async () => {
    try {
      return await api.adminAnalytics(30);
    } catch {
      return null;
    }
  },
  { default: () => null },
);

/* ─────────── 使用分析 ─────────── */
const { data: usage } = await useAsyncData(
  'admin-usage',
  async () => {
    try {
      return await api.usage();
    } catch {
      return null;
    }
  },
  { default: () => null },
);

const actionLabel: Record<string, string> = {
  'auth.login': '登录',
  'auth.login_failed': '登录失败',
  'auth.logout': '退出',
  'file.upload': '上传文件',
  'file.download': '下载文件',
  'file.delete': '删除文件',
  'file.restore': '恢复文件',
  'file.purge': '彻底删除',
  'file.move': '移动文件',
  'file.security_change': '改密级',
  'folder.delete': '删文件夹',
  'folder.cascade_delete': '级联删文件夹',
  'kb.ingest': '纳入知识库',
  'kb.remove': '移出知识库',
  'kb.search': '检索测试',
  'chat.ask': '提问',
  'chat.answer_failed': '提问未命中',
  'agent.run': '唤起智能体',
  'mail.send': '发送邮件',
};
const getAction = (a: string) => actionLabel[a] ?? a;
const getActor = (row: any) => row?.actorName ?? '—';
const getTarget = (row: any) => row?.targetName ?? '—';
const getWhen = (row: any) => (row?.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN') : '');
</script>

<template>
  <div>
    <div class="ph">
      <div>
        <h1>管理后台</h1>
        <div class="desc">模型通道、审计、人员权限与用量概览。</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'models' }" @click="tab = 'models'">模型与通道</button>
      <button v-if="can('audit:view')" class="tab" :class="{ on: tab === 'audit' }" @click="tab = 'audit'">审计日志</button>
      <button v-if="can('user:manage')" class="tab" :class="{ on: tab === 'people' }" @click="tab = 'people'">人员与权限</button>
      <button class="tab" :class="{ on: tab === 'usage' }" @click="tab = 'usage'">使用分析</button>
    </div>

    <!-- 模型与通道 -->
    <div v-if="tab === 'models'" class="card">
      <div class="card-h">
        <h3>模型清单</h3>
        <span class="spacer" />
        <button class="btn sm" :disabled="probing" @click="probe">{{ probing ? '探测中…' : '重新探测' }}</button>
      </div>
      <table>
        <thead><tr><th>名称</th><th>部署 ID</th><th>能力</th><th>状态</th><th>延迟</th></tr></thead>
        <tbody>
          <tr v-for="m in models" :key="m.key">
            <td>{{ m.displayName }}</td>
            <td class="mono tiny">{{ m.deploymentId }}</td>
            <td class="tiny">{{ (m.capabilities ?? []).join('、') }}</td>
            <td>
              <span class="badge" :class="m.health?.ok ? 'ok' : 'err'">
                {{ m.health?.ok ? '正常' : (m.health ? '异常' : '未探测') }}
              </span>
            </td>
            <td class="num">{{ m.health?.latencyMs ?? '—' }}ms</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 审计日志 -->
    <div v-else-if="tab === 'audit'" class="card">
      <div class="card-h"><h3>最近操作</h3><span class="spacer" /><button class="btn sm" @click="refreshAudit">刷新</button></div>
      <div v-if="!audit.length" class="empty"><div class="t">暂无审计记录</div></div>
      <table v-else>
        <thead><tr><th>动作</th><th>操作人</th><th>对象</th><th>时间</th><th>结果</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in audit" :key="i">
            <td>{{ getAction((row as any).action) }}</td>
            <td>{{ getActor(row) }}</td>
            <td>{{ getTarget(row) }}</td>
            <td class="tiny">{{ getWhen(row) }}</td>
            <td><span class="badge" :class="(row as any).success ? 'ok' : 'err'">{{ (row as any).success ? '成功' : '失败' }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 人员与权限 -->
    <div v-else-if="tab === 'people'" class="people">
      <div class="card">
        <div class="card-h"><h3>成员（{{ users.length }}）</h3></div>
        <table>
          <thead><tr><th>姓名</th><th>账号</th><th>部门</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="(u, i) in users" :key="i">
              <td>{{ (u as any).name }}</td>
              <td class="mono tiny">{{ (u as any).account }}</td>
              <td>{{ (u as any).departmentName ?? '—' }}</td>
              <td><span class="badge" :class="(u as any).isActive ? 'ok' : 'err'">{{ (u as any).isActive ? '在职' : '停用' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-h"><h3>角色（{{ roles.length }}）</h3></div>
        <table>
          <thead><tr><th>角色</th><th>标识</th><th>能力数</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in roles" :key="i">
              <td>{{ (r as any).name }}</td>
              <td class="mono tiny">{{ (r as any).key }}</td>
              <td class="num">{{ (r as any).permissions?.length ?? 0 }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-h"><h3>部门（{{ departments.length }}）</h3></div>
        <table>
          <thead><tr><th>部门</th><th>密级上限</th></tr></thead>
          <tbody>
            <tr v-for="(d, i) in departments" :key="i">
              <td>{{ (d as any).name }}</td>
              <td class="tiny">{{ (d as any).maxSecurityLevel }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 使用分析 -->
    <div v-else-if="tab === 'usage'" class="card">
      <div class="card-h">
        <h3>哪些问题没找到依据</h3>
        <span class="spacer" />
        <span class="tiny">近 30 天 · 这张表直接告诉你该补哪份材料</span>
      </div>
      <div v-if="analytics?.missedQuestions.length" class="miss-list">
        <div v-for="(q, i) in analytics.missedQuestions" :key="i" class="miss-row">
          <span class="miss-q">{{ q.question }}</span>
          <span class="spacer" />
          <span class="tiny num">{{ q.times }} 次</span>
        </div>
      </div>
      <div v-else class="tiny" style="padding: 8px 0">近 30 天没有「未命中」的记录 —— 要么都答上了，要么还没人问。</div>

      <div v-if="analytics?.topQuestions.length" style="margin-top: 22px">
        <div class="tiny" style="margin-bottom: 8px">问得最多的问题</div>
        <table>
          <thead><tr><th>问题</th><th style="width: 80px">次数</th></tr></thead>
          <tbody>
            <tr v-for="(q, i) in analytics.topQuestions" :key="i">
              <td>{{ q.question }}</td>
              <td class="num">{{ q.times }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="analytics?.daily.length" style="margin-top: 22px">
        <div class="tiny" style="margin-bottom: 8px">每日问答（命中 / 未命中）</div>
        <div class="bars">
          <div v-for="d in analytics.daily" :key="d.day" class="bar-col" :title="`${d.day}：命中 ${d.hit}，未命中 ${d.miss}`">
            <div class="bar hit" :style="{ height: `${Math.min(100, d.hit * 8 + (d.hit ? 6 : 0))}%` }" />
            <div class="bar miss" :style="{ height: `${Math.min(100, d.miss * 8 + (d.miss ? 6 : 0))}%` }" />
            <span class="bar-day">{{ d.day }}</span>
          </div>
        </div>
      </div>

      <div class="card-h" style="margin-top: 26px"><h3>存储与文件</h3></div>
      <div v-if="usage" class="usage">
        <div class="stat"><div class="n num">{{ usage.totalFiles }}</div><div class="l">文件总数</div></div>
        <div class="stat"><div class="n num">{{ formatBytes(usage.totalBytes) }}</div><div class="l">占用容量</div></div>
      </div>
      <div v-if="usage && usage.byDepartment.length" style="margin-top: 16px">
        <div class="tiny" style="margin-bottom: 8px">按部门分布</div>
        <table>
          <thead><tr><th>部门</th><th>文件数</th><th>容量</th></tr></thead>
          <tbody>
            <tr v-for="(d, i) in usage.byDepartment" :key="i">
              <td>{{ d.departmentName }}</td>
              <td class="num">{{ d.files }}</td>
              <td class="num">{{ formatBytes(d.bytes) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.miss-list { display: flex; flex-direction: column; }
.miss-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line-soft); font-size: 13px; }
.miss-row:last-child { border-bottom: none; }
.miss-q { color: var(--ink); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.bars { display: flex; align-items: flex-end; gap: 8px; height: 90px; padding-top: 6px; }
.bar-col { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 2px; flex: 1; height: 100%; position: relative; }
.bar { width: 100%; max-width: 26px; border-radius: 3px 3px 0 0; min-height: 2px; }
.bar.hit { background: var(--brand); }
.bar.miss { background: var(--er-t, #A32D2D); opacity: .65; }
.bar-day { font-size: 10.5px; color: var(--ink-3); }

.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
.tab {
  padding: 9px 16px; border: none; background: none; cursor: pointer;
  font-size: 13.5px; font-family: inherit; color: var(--ink-2);
  border-bottom: 2px solid transparent; transition: color var(--t), border-color var(--t);
}
.tab:hover { color: var(--ink); }
.tab.on { color: var(--brand); border-bottom-color: var(--brand); font-weight: 500; }

.people { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.people .card:last-child { grid-column: 1 / -1; }

.usage { display: flex; gap: 32px; padding: 8px 0; }
.stat .n { font-size: 26px; font-weight: 600; letter-spacing: -.02em; }
.stat .l { font-size: 12px; color: var(--ink-3); margin-top: 4px; }

@media (max-width: 1000px) { .people { grid-template-columns: 1fr; } }
</style>
