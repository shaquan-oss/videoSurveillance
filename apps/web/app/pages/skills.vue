<script setup lang="ts">
import type { Skill } from '@kh/shared';

const api = useApi();
const { can } = useAuth();

const { data: skills, refresh: refreshSkills } = await useAsyncData(
  'skills',
  async () => {
    try {
      return await api.listSkills();
    } catch {
      return [] as Skill[];
    }
  },
  { default: () => [] as Skill[] },
);

const published = computed(() => skills.value.filter((s) => s.status === 'published'));
const mine = computed(() => skills.value.filter((s) => s.status !== 'published'));

/* ─────────── 上传 ─────────── */
const dialog = ref(false);
const form = reactive({
  name: '',
  description: '',
  triggerText: '',
  prompt: '',
});
const saving = ref(false);
const error = ref('');

function openUpload() {
  Object.assign(form, {
    name: '',
    description: '',
    triggerText: '',
    prompt: '',
  });
  error.value = '';
  dialog.value = true;
}

async function upload() {
  if (!form.name.trim() || !form.prompt.trim() || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await api.createSkill({
      name: form.name.trim(),
      description: form.description.trim(),
      triggerWords: form.triggerText.split(/[,，、\s]+/).filter(Boolean),
      prompt: form.prompt.trim(),
    });
    dialog.value = false;
    toast('已提交，等待审核');
    await refreshSkills();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '提交失败';
  } finally {
    saving.value = false;
  }
}

async function install(s: Skill) {
  try {
    const { installCount } = await api.installSkill(s.id);
    toast(`已安装「${s.name}」（${installCount} 次安装）`);
  } catch (err) {
    toast(err instanceof Error ? err.message : '安装失败', 'err');
  }
}

async function review(s: Skill, approve: boolean) {
  try {
    await api.reviewSkill(s.id, approve);
    toast(approve ? '已上架' : '已驳回');
    await refreshSkills();
  } catch (err) {
    toast(err instanceof Error ? err.message : '审核失败', 'err');
  }
}

async function removeSkill(s: Skill) {
  if (!confirm(`删除技能「${s.name}」？`)) return;
  try {
    await api.removeSkill(s.id);
    toast('已删除');
    await refreshSkills();
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'err');
  }
}

const statusLabel: Record<string, string> = {
  pending: '待审核',
  published: '已上架',
  rejected: '已驳回',
};

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
        <h1>技能商城</h1>
        <div class="desc">对话里可用的小能力：触发词唤起，拼进模型上下文执行。</div>
      </div>
      <div class="spacer" />
      <button v-if="can('skill:upload')" class="btn primary" @click="openUpload">＋ 上传技能</button>
    </div>

    <!-- 已上架 -->
    <div class="section-t">已上架</div>
    <div v-if="!published.length" class="empty">
      <div class="t">还没有已上架的技能</div>
      <div class="d">上传一个技能并通过审核后，会出现在这里供大家安装。</div>
    </div>
    <div v-else class="grid">
      <div v-for="s in published" :key="s.id" class="card skill-card">
        <div class="skill-name">{{ s.name }}</div>
        <p class="skill-desc">{{ s.description || '（无描述）' }}</p>
        <div class="skill-tags">
          <span v-for="t in s.triggerWords.slice(0, 3)" :key="t" class="tag">{{ t }}</span>
        </div>
        <div class="skill-foot">
          <span class="tiny num">安装 {{ s.installCount }} 次</span>
          <span class="spacer" />
          <button class="btn sm" @click="install(s)">安装</button>
        </div>
      </div>
    </div>

    <!-- 我上传的（待审核 / 已驳回） -->
    <template v-if="mine.length">
      <div class="section-t" style="margin-top: 24px">我上传的</div>
      <div class="card">
        <table>
          <thead><tr><th>名称</th><th>状态</th><th>触发词</th><th style="text-align: right">操作</th></tr></thead>
          <tbody>
            <tr v-for="s in mine" :key="s.id">
              <td>{{ s.name }}</td>
              <td><span class="badge" :class="s.status === 'rejected' ? 'err' : ''">{{ statusLabel[s.status] }}</span></td>
              <td class="tiny">{{ s.triggerWords.join('、') || '—' }}</td>
              <td style="text-align: right">
                <button v-if="can('skill:review') && s.status === 'pending'" class="act" @click="review(s, true)">通过</button>
                <button v-if="can('skill:review') && s.status === 'pending'" class="act danger" @click="review(s, false)">驳回</button>
                <button class="act danger" @click="removeSkill(s)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 上传对话框 -->
    <div v-if="dialog" class="mask" @click.self="dialog = false">
      <div class="modal" style="max-width: 520px">
        <div class="modal-h"><h3>上传技能</h3><button class="x" @click="dialog = false">×</button></div>
        <div class="modal-b">
          <div class="field"><label>名称</label><input v-model="form.name" placeholder="例如：报销单填写" /></div>
          <div class="field"><label>触发词（逗号分隔）</label><input v-model="form.triggerText" placeholder="例如：报销单、差旅报销" /></div>
          <div class="field"><label>描述（可选）</label><input v-model="form.description" placeholder="一句话说明用途" /></div>
          <div class="field"><label>技能指令</label><textarea v-model="form.prompt" rows="4" placeholder="被唤起时拼进模型上下文的指令，例如：按报销单模板逐项询问并汇总…" /></div>
          <div v-if="error" class="alert err">{{ error }}</div>
        </div>
        <div class="modal-f">
          <span class="spacer" />
          <button class="btn" @click="dialog = false">取消</button>
          <button class="btn primary" :disabled="saving || !form.name.trim() || !form.prompt.trim()" @click="upload">{{ saving ? '提交中…' : '提交审核' }}</button>
        </div>
      </div>
    </div>

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.section-t { font-size: 12.5px; font-weight: 500; color: var(--ink-3); margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.skill-card { display: flex; flex-direction: column; gap: 10px; padding: 18px; }
.skill-name { font-size: 14.5px; font-weight: 500; }
.skill-desc { font-size: 12.5px; color: var(--ink-2); line-height: 1.6; margin: 0; flex: 1; }
.skill-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { font-size: 11px; color: var(--brand); background: var(--brand-s); padding: 2px 8px; border-radius: var(--r-full); }
.skill-foot { display: flex; align-items: center; gap: 10px; }

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
