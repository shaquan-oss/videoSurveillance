<script setup lang="ts">
import { buildKbTree, formatRelativeTime, getBaseName, type KbTreeFile, type KbTreeNode, kbTreePath } from '@kh/shared';

const api = useApi();
const { levelLabel } = useFileMeta();

/* ─────────── 知识库树 ─────────── */
const { data: kbsData, refresh: refreshKbs } = await useAsyncData(
  'kb-list',
  async () => {
    try {
      return await api.listKbs();
    } catch {
      return { visible: [], locked: [] };
    }
  },
  { default: () => ({ visible: [], locked: [] }) },
);

const searchText = ref('');

const visibleLibs = computed(() => kbsData.value.visible);
const myLibs = computed(() => visibleLibs.value.filter((k) => !k.isTeamSpace));
const teamLibs = computed(() => visibleLibs.value.filter((k) => k.isTeamSpace));
const lockedLibs = computed(() => kbsData.value.locked);

/** 搜索框同时匹配知识库名与「当前已展开的知识库」里的文件名 */
function match(name: string) {
  const q = searchText.value.trim();
  return q === '' || name.includes(q);
}

function matchLib(k: { id: string; name: string }) {
  if (match(k.name)) return true;
  const q = searchText.value.trim();
  return q !== '' && k.id === activeKbId.value && tree.value.files.some((f) => f.name.includes(q));
}

const myFiltered = computed(() => myLibs.value.filter(matchLib));
const teamFiltered = computed(() => teamLibs.value.filter(matchLib));
const lockedFiltered = computed(() => lockedLibs.value.filter((k) => match(k.name)));

const activeKbId = ref<string | null>(visibleLibs.value[0]?.id ?? null);
const activeKb = computed(() => visibleLibs.value.find((k) => k.id === activeKbId.value) ?? null);

/* ─────────── 文件树 ─────────── */
const {
  data: tree,
  refresh: refreshTree,
  pending: treeLoading,
} = await useAsyncData(
  'kb-tree',
  async () => {
    if (!activeKbId.value) return { folders: [], files: [] as KbTreeFile[] };
    try {
      return await api.kbTree(activeKbId.value);
    } catch {
      return { folders: [], files: [] as KbTreeFile[] };
    }
  },
  {
    default: () => ({ folders: [], files: [] as KbTreeFile[] }),
    watch: [activeKbId],
  },
);

function selectKb(id: string) {
  activeKbId.value = id;
  selectedFile.value = null;
  preview.value = null;
}

/* ─────────── 文件预览（结构化）─────────── */
const selectedFile = ref<KbTreeFile | null>(null);
const preview = ref<{
  name: string;
  indexed: boolean;
  blocks: { heading?: string; content: string; page?: number | null }[];
} | null>(null);
const previewLoading = ref(false);

async function selectFile(f: KbTreeFile) {
  selectedFile.value = f;
  previewLoading.value = true;
  preview.value = null;
  try {
    preview.value = await api.kbPreview(f.id);
  } catch {
    preview.value = {
      name: f.name,
      indexed: f.indexStatus === 'indexed',
      blocks: [{ content: '预览加载失败' }],
    };
  } finally {
    previewLoading.value = false;
  }
}

/* ─────────── 检索测试 ─────────── */
const searchOpen = ref(false);
const searchQuery = ref('');
const searchHits = ref<
  {
    chunkId: string;
    fileId: string;
    fileName: string;
    content: string;
    score: number;
    page?: number | null;
  }[]
>([]);
const searchElapsed = ref(0);
const searching = ref(false);

async function doSearch() {
  const q = searchQuery.value.trim();
  if (!q || searching.value || !activeKbId.value) return;
  searching.value = true;
  try {
    const res = await api.kbSearch(activeKbId.value, q, 5);
    searchHits.value = res.hits;
    searchElapsed.value = res.elapsedMs;
  } catch (err) {
    toast(err instanceof Error ? err.message : '检索失败', 'err');
  } finally {
    searching.value = false;
  }
}

/* ─────────── 操作 ─────────── */
async function downloadOriginal(f: KbTreeFile) {
  try {
    const { url } = await api.downloadUrl(f.id);
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    toast(err instanceof Error ? err.message : '下载失败', 'err');
  }
}
async function viewOriginal(f: KbTreeFile) {
  try {
    const { url } = await api.previewUrl(f.id);
    window.open(url, '_blank', 'noopener');
  } catch {
    /* preview URL 不支持的文件直接忽略 */
  }
}
async function reparseFile(f: KbTreeFile) {
  if (!activeKbId.value || !confirm(`重新解析「${f.name}」？`)) return;
  try {
    await api.ingestToKb(activeKbId.value, f.id);
    toast('已重新解析');
    await refreshTree();
    await refreshKbs();
  } catch (err) {
    toast(err instanceof Error ? err.message : '重新解析失败', 'err');
  }
}
async function removeFromKb(f: KbTreeFile) {
  if (!confirm(`把「${f.name}」从知识库移除？其切片也会一并删除。`)) return;
  try {
    await api.kbRemoveFile(f.id);
    toast('已从知识库移除');
    if (selectedFile.value?.id === f.id) {
      selectedFile.value = null;
      preview.value = null;
    }
    await Promise.all([refreshTree(), refreshKbs()]);
  } catch (err) {
    toast(err instanceof Error ? err.message : '移除失败', 'err');
  }
}

/* ─────────── 知识库级操作 ─────────── */
async function removeKb(k: { id: string; name: string }) {
  if (!confirm(`删除知识库「${k.name}」？\n\n库内文件脱离知识库（文件本体保留在文件管理），切片会被清除。`)) return;
  try {
    await api.removeKb(k.id);
    toast('知识库已删除');
    if (activeKbId.value === k.id) {
      activeKbId.value = null;
      selectedFile.value = null;
      preview.value = null;
    }
    await refreshKbs();
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'err');
  }
}

/* ─────────── 新建知识库 ─────────── */
const kbDialog = ref(false);
const kbForm = reactive({ name: '', description: '', isTeamSpace: false });
const kbSaving = ref(false);

function openCreate() {
  Object.assign(kbForm, { name: '', description: '', isTeamSpace: false });
  kbDialog.value = true;
}
async function doCreate() {
  if (!kbForm.name.trim() || kbSaving.value) return;
  kbSaving.value = true;
  try {
    const created = await api.createKb({
      name: kbForm.name.trim(),
      description: kbForm.description.trim(),
      isTeamSpace: kbForm.isTeamSpace,
    });
    kbDialog.value = false;
    toast(`已创建「${created.name}」`);
    await refreshKbs();
    activeKbId.value = created.id;
  } catch (err) {
    toast(err instanceof Error ? err.message : '创建失败', 'err');
  } finally {
    kbSaving.value = false;
  }
}

/* ─────────── 「+」菜单：新建文档 / 表格 / 文件夹 / 上传 ─────────── */
const newMenuOpen = ref(false);

function toggleNewMenu() {
  if (!activeKbId.value) {
    toast('请先选择一个知识库', 'err');
    return;
  }
  newMenuOpen.value = !newMenuOpen.value;
}

function runNewAction(action: () => void) {
  newMenuOpen.value = false;
  action();
}

/* ─────────── 新建文档 / 表格（.md / .csv） ─────────── */
const docDialog = ref(false);
const docForm = reactive({
  name: '',
  content: '',
  extension: 'md' as 'md' | 'csv',
  parentId: null as string | null,
});
const docSaving = ref(false);

function openCreateDoc(extension: 'md' | 'csv' = 'md') {
  if (!activeKbId.value) {
    toast('请先选择一个知识库', 'err');
    return;
  }
  Object.assign(docForm, { name: '', content: '', extension });
  docDialog.value = true;
}

async function doCreateDoc() {
  if (!docForm.name.trim() || !docForm.content.trim() || !activeKbId.value || docSaving.value) return;
  docSaving.value = true;
  try {
    const file = await api.kbCreateDocument(activeKbId.value, {
      name: docForm.name.trim(),
      content: docForm.content,
      extension: docForm.extension,
      kbFolderId: docForm.parentId,
    });
    docDialog.value = false;
    toast(`已新建「${file.name}」并纳入知识库`);
    await Promise.all([refreshTree(), refreshKbs()]);
    selectFile(file as KbTreeFile);
  } catch (err) {
    toast(err instanceof Error ? err.message : '新建失败', 'err');
  } finally {
    docSaving.value = false;
  }
}

/* ─────────── 新建文件夹（可在任意层级下建子目录） ─────────── */
const folderDialog = ref(false);
const folderForm = reactive({ name: '', parentId: null as string | null });
const folderSaving = ref(false);

function openNewFolder(parentId: string | null = null) {
  if (!activeKbId.value) {
    toast('请先选择一个知识库', 'err');
    return;
  }
  Object.assign(folderForm, { name: '', parentId });
  folderDialog.value = true;
}

async function doCreateFolder() {
  if (!folderForm.name.trim() || !activeKbId.value || folderSaving.value) return;
  folderSaving.value = true;
  try {
    const created = await api.kbCreateFolder(activeKbId.value, folderForm.name.trim(), folderForm.parentId);
    folderDialog.value = false;
    toast(`已新建目录「${created.name}」`);
    await refreshTree();
  } catch (err) {
    toast(err instanceof Error ? err.message : '新建目录失败', 'err');
  } finally {
    folderSaving.value = false;
  }
}

async function removeKbFolder(node: KbTreeNode) {
  if (!activeKbId.value) return;
  if (!confirm(`删除目录「${node.name}」？\n\n子目录会一并删除；目录内的文件仍保留在知识库里，只是回到库根。`)) return;
  try {
    await api.kbRemoveFolder(activeKbId.value, node.id);
    toast('目录已删除');
    await Promise.all([refreshTree(), refreshKbs()]);
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'err');
  }
}

/* ─────────── 上传到知识库（多文件 / 整个文件夹，上传即入库） ─────────── */
const uploadInput = ref<HTMLInputElement | null>(null);
const uploadFolderInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

/**
 * 本次上传落到库内哪个目录；null = 库根。
 * 在目录树某一行点「↥」时传入该目录，省掉「先切进去再传」这一步。
 */
const uploadTarget = ref<{ id: string | null; name: string | null }>({
  id: null,
  name: null,
});

function pickUploadFiles(target?: KbTreeNode) {
  uploadTarget.value = target ? { id: target.id, name: target.name } : { id: null, name: null };
  const el = uploadInput.value;
  if (!el) return;
  el.value = '';
  el.click();
}

function pickUploadFolder(target?: KbTreeNode) {
  uploadTarget.value = target ? { id: target.id, name: target.name } : { id: null, name: null };
  const el = uploadFolderInput.value;
  if (!el) return;
  el.value = '';
  el.click();
}

/** 目录树上点「上传」：直接把文件传到该目录，不用先切进去 */
function onTreeUpload(node: KbTreeNode, kind: 'files' | 'folder') {
  if (kind === 'folder') pickUploadFolder(node);
  else pickUploadFiles(node);
}

/** 上传后按相对路径在库内保留目录层级，所以这里把 webkitRelativePath 一起带上 */
async function onKbUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []) as (File & {
    webkitRelativePath?: string;
  })[];
  input.value = '';
  if (!files.length) return toast('没有识别到任何文件', 'err');
  if (!activeKbId.value) return;

  const form = new FormData();
  for (const f of files) {
    form.append('files', f);
    form.append('relPaths', f.webkitRelativePath || f.name);
  }
  // 指定了目标目录时，相对路径里没有层级就挂到它下面
  if (uploadTarget.value.id) form.append('kbFolderId', uploadTarget.value.id);

  uploading.value = true;
  try {
    const res = await api.kbUpload(activeKbId.value, form);
    const where = uploadTarget.value.name ? `到「${uploadTarget.value.name}」` : '';
    const failed = res.failCount ? `，${res.failCount} 个未能解析（${res.results.find((r) => !r.ok)?.error ?? ''}）` : '';
    toast(`已上传并纳入${where} ${res.okCount} 个文件${failed}`, res.okCount ? 'ok' : 'err');
    await Promise.all([refreshTree(), refreshKbs()]);
  } catch (err) {
    toast(err instanceof Error ? err.message : '上传失败', 'err');
  } finally {
    uploading.value = false;
    uploadTarget.value = { id: null, name: null };
  }
}

/* ─────────── 调整文件在库内的目录 ─────────── */
const moveTarget = ref<KbTreeFile | null>(null);
const moveBusy = ref(false);

function openMove(f: KbTreeFile) {
  moveTarget.value = f;
}

async function doMove(kbFolderId: string | null) {
  if (!activeKbId.value || !moveTarget.value || moveBusy.value) return;
  moveBusy.value = true;
  try {
    await api.kbMoveFile(activeKbId.value, moveTarget.value.id, kbFolderId);
    toast('已调整目录');
    moveTarget.value = null;
    await refreshTree();
  } catch (err) {
    toast(err instanceof Error ? err.message : '移动失败', 'err');
  } finally {
    moveBusy.value = false;
  }
}

/** 目录下拉用的扁平列表（带层级缩进） */
const folderOptions = computed(() => {
  const out: { id: string; label: string }[] = [];
  const walk = (nodes: KbTreeNode[], depth: number) => {
    for (const n of nodes) {
      if (n.kind !== 'folder') continue;
      out.push({ id: n.id, label: `${'　'.repeat(depth)}${n.name}` });
      walk(n.children, depth + 1);
    }
  };
  walk(kbTree.value, 0);
  return out;
});

/* ─────────── 轻提示 ─────────── */
const toasts = ref<{ id: number; text: string; kind: 'ok' | 'err' }[]>([]);
let seq = 0;
function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  const id = ++seq;
  toasts.value.push({ id, text, kind });
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 3000);
}

/**
 * 把 block.content 拆成 li 项（非空行）。
 * 返回 { type, items }，由模板决定渲染 ul 还是 p。
 */
function splitContent(content: string): {
  type: 'list' | 'text';
  items: string[];
} {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 1) return { type: 'list', items: lines };
  if (lines.length === 1 && lines[0]!.length > 60) return { type: 'text', items: [lines[0]!] };
  return { type: 'list', items: lines };
}

/* ─────────── 左栏目录树 ─────────── */

/** 扁平 folders/files 组装成嵌套树，交给 KbTreeNode 递归渲染 */
const kbTree = computed(() => buildKbTree(tree.value.folders, tree.value.files));

/** 左栏前两组分组，模板用同一份结构渲染 */
const groups = computed(() => [
  {
    key: 'mine',
    label: '我的知识库',
    items: myFiltered.value,
    hint: '还没有知识库，点右侧「＋」新建',
  },
  {
    key: 'team',
    label: '团队空间',
    items: teamFiltered.value,
    hint: '暂无团队空间',
  },
]);

/** 选中文件所在的文件夹路径（面包屑用），如 ['行政法规'] */
const crumbPath = computed(() => {
  const f = selectedFile.value;
  if (!f) return [];
  return (kbTreePath(kbTree.value, f.id) ?? []).map((n) => n.name);
});

/** 预览顶部的摘要条：取首个有内容的块开头，帮读者快速判断是不是要找的文件 */
const abstract = computed(() => {
  const first = preview.value?.blocks.find((b) => b.content.trim());
  if (!first) return '';
  const text = first.content.trim().replace(/\s+/g, ' ');
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
});

function onTreeSelect(node: KbTreeNode) {
  if (node.file) void selectFile(node.file);
}

/* ─────────── 文件行「···」菜单 ─────────── */
const fileMenu = ref<{ file: KbTreeFile; x: number; y: number } | null>(null);

function openFileMenu(node: KbTreeNode, event: MouseEvent) {
  if (!node.file) return;
  fileMenu.value = { file: node.file, x: event.clientX, y: event.clientY };
}

/** 菜单里的文件统一取这一份，避免模板里到处断言非空 */
const menuFile = computed(() => fileMenu.value?.file ?? null);

function runMenuAction(action: (f: KbTreeFile) => void | Promise<void>) {
  const f = menuFile.value;
  fileMenu.value = null;
  if (f) void action(f);
}

/** 深度优先取树里第一个文件，用于首屏默认选中 */
function firstFileOf(nodes: KbTreeNode[]): KbTreeFile | null {
  for (const node of nodes) {
    if (node.file) return node.file;
    const sub = firstFileOf(node.children);
    if (sub) return sub;
  }
  return null;
}

// 首屏就展开左栏树并选中第一个文件：右栏直接是正文，与原型一致（SSR 也会渲染出来）
const firstFile = firstFileOf(kbTree.value);
if (!selectedFile.value && firstFile) await selectFile(firstFile);
</script>

<template>
  <div class="kb2">
    <!-- ============ 左栏：知识库树 ============ -->
    <div class="ktree">
      <div class="ktree-h">
        <div class="knav-search">
          <input v-model="searchText" placeholder="搜索知识库与文件" />
        </div>
      </div>
      <div class="ktree-body">
        <template v-for="g in groups" :key="g.key">
          <div class="kgrp" :style="g.key === 'team' ? 'margin-top: 14px' : undefined">
            <span>{{ g.label }}</span>
            <span class="spacer" />
            <span class="add" title="新建知识库" @click="openCreate">＋</span>
          </div>
          <div v-if="!g.items.length" class="khint">{{ g.hint }}</div>

          <template v-for="k in g.items" :key="k.id">
            <div class="klib" :class="{ on: activeKbId === k.id }" @click="selectKb(k.id)">
              <span class="chev">{{ activeKbId === k.id ? '▾' : '▸' }}</span>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 2.5h7.5L13 5v8.5H3z" /></svg>
              <span class="nm">{{ k.name }}</span>
              <span class="ct num">{{ k.fileCount }}</span>
              <button class="kb-rm" title="删除知识库" @click.stop="removeKb(k)">×</button>
            </div>
            <!-- 选中的知识库就地展开文件树：文件夹可继续下钻，点文件在右侧看正文 -->
            <div v-if="activeKbId === k.id" class="kfiles">
              <template v-if="treeLoading">
                <div class="khint">加载中…</div>
              </template>
              <template v-else-if="!kbTree.length">
                <div class="khint">这个库还是空的：点右上「＋ 新建」上传文件，或从「文件管理」把已有内容纳入</div>
              </template>
              <template v-else>
                <KbTreeNode
                  v-for="node in kbTree"
                  :key="node.id"
                  :node="node"
                  :depth="1"
                  :selected-id="selectedFile?.id ?? null"
                  @select="onTreeSelect"
                  @menu="openFileMenu"
                  @new-sub="(n) => openNewFolder(n.id)"
                  @remove-folder="removeKbFolder"
                  @upload="onTreeUpload"
                />
              </template>
            </div>
          </template>
        </template>

        <div class="kgrp" style="margin-top: 14px">
          <span>不在我的可见范围</span>
        </div>
        <div v-if="!lockedFiltered.length" class="khint">—</div>
        <div v-for="l in lockedFiltered" :key="l.name" class="klib lock" title="看不到的库可以申请权限，不会静默忽略。">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M6 7V5.5a2 2 0 014 0V7" /></svg>
          <span class="nm">{{ l.name }}</span><span class="ct num">{{ l.fileCount }}</span>
        </div>
        <div v-if="lockedFiltered.length" class="khint">看不到的库可以申请权限，不会静默忽略。</div>
      </div>
    </div>

    <!-- ============ 右栏：文件预览/检索 ============ -->
    <div class="pv">
      <template v-if="!activeKb">
        <div class="empty">
          <div class="t">选择一个知识库</div>
          <div class="d">从左侧选一个知识库，查看里面的文件，或点右上「新建文档」直接写一份纳进来。</div>
        </div>
      </template>

      <template v-else>
        <div class="pv-h">
          <span class="crumb">
            {{ activeKb.name }}
            <template v-if="crumbPath.length">/{{ crumbPath.join('/') }}</template>
            <template v-if="selectedFile">/{{ selectedFile.name }}</template>
          </span>
          <span class="spacer" />
          <button v-if="selectedFile" class="btn sm" @click="downloadOriginal(selectedFile)">下载</button>
          <button class="btn sm" @click="searchOpen = !searchOpen">检索测试</button>
          <div class="new-wrap">
            <button class="btn sm primary" @click="toggleNewMenu">
              ＋ 新建<template v-if="uploading">（上传中…）</template>
            </button>
            <div v-if="newMenuOpen" class="new-mask" @click="newMenuOpen = false" />
            <div v-if="newMenuOpen" class="new-menu" @click.stop>
              <button @click="runNewAction(() => openCreateDoc('md'))">新建文档（.md）</button>
              <button @click="runNewAction(() => openCreateDoc('csv'))">新建表格（.csv）</button>
              <button @click="runNewAction(() => openNewFolder(null))">新建文件夹</button>
              <div class="msep" />
              <button :disabled="uploading" @click="runNewAction(pickUploadFiles)">上传文件</button>
              <button :disabled="uploading" @click="runNewAction(pickUploadFolder)">上传文件夹</button>
            </div>
          </div>
          <input ref="uploadInput" type="file" multiple style="display: none" @change="onKbUpload" />
          <input ref="uploadFolderInput" type="file" webkitdirectory directory multiple style="display: none" @change="onKbUpload" />
        </div>

        <!-- 检索测试面板（原型 hitbox） -->
        <div v-if="searchOpen" class="hitbox">
          <div style="width: 100%; display: flex; align-items: center; gap: 9px">
            <span style="font-size: 12.5px; font-weight: 500">检索测试</span>
            <span class="tiny">验证在这个知识库里提问，能不能召回正确的片段</span>
          </div>
          <div class="field"><input v-model="searchQuery" placeholder="例如：住宿标准是多少" @keyup.enter="doSearch" /></div>
          <button class="btn sm" :disabled="searching" @click="doSearch">{{ searching ? '检索中…' : '检索' }}</button>
          <div v-if="searchHits.length" class="hits" style="width: 100%">
            <div class="tiny">召回 {{ searchHits.length }} 片段 · 耗时 {{ searchElapsed }}ms</div>
            <div v-for="h in searchHits" :key="h.chunkId" class="frag">
              <b>相似度 {{ h.score.toFixed(2) }}</b> ·《{{ h.fileName }}》<span v-if="h.page">第 {{ h.page }} 页</span>
              <div class="frag-body">{{ h.content.slice(0, 200) }}</div>
            </div>
          </div>
        </div>

        <!-- 未选中文件：只做提示，文件已在左栏树里，不再重复列一遍 -->
        <div v-if="!selectedFile" class="empty">
          <div class="t">从左侧选一个文件</div>
          <div class="d">左栏是知识库的文件树，点任意文件即可在这里查看正文。</div>
          <div v-if="!treeLoading && !tree.files.length" style="margin-top: 12px; display: flex; gap: 8px">
            <button class="btn primary sm" @click="pickUploadFiles()">上传文件</button>
            <button class="btn sm" @click="openNewFolder(null)">新建文件夹</button>
          </div>
        </div>

        <!-- 选中文件：正文（h3 + 列表）+ 元信息 -->
        <div v-else class="pv-body">
          <h1 class="pv-title">{{ getBaseName(selectedFile.name) }}</h1>
          <div class="tiny pv-hint">
            {{ selectedFile.name }}<template v-if="crumbPath.length"> · {{ crumbPath.join(' / ') }}</template>
          </div>

          <div v-if="previewLoading" class="tiny" style="padding: 24px 0">加载中…</div>
          <div v-else-if="preview && !preview.indexed" class="empty">
            <div class="t">尚未纳入</div>
            <div class="d">该文件还未解析，点「重新解析」即可处理。</div>
          </div>
          <div v-else-if="preview" class="doc-txt">
            <div v-if="abstract" class="doc-quote">{{ abstract }}</div>
            <template v-for="(b, bi) in preview.blocks" :key="bi">
              <h3 v-if="b.heading">{{ b.heading }}</h3>
              <ul v-if="splitContent(b.content).type === 'list'">
                <li v-for="(line, li) in splitContent(b.content).items" :key="li">{{ line }}</li>
              </ul>
              <p v-else>{{ splitContent(b.content).items[0] }}</p>
            </template>
            <div v-if="!preview.blocks.length" class="tiny">（无文本内容）</div>
          </div>

          <!-- 底部元信息：与原型一致的信息网格 -->
          <div class="pv-meta">
            <div class="mi">
              <label>所属知识库</label>
              <span>{{ activeKb.name }}<template v-if="crumbPath.length"> / {{ crumbPath.join(' / ') }}</template></span>
            </div>
            <div class="mi"><label>密级与可见范围</label><span>{{ levelLabel(selectedFile.securityLevel) }}</span></div>
            <div class="mi"><label>索引状态</label><span>{{ selectedFile.chunkCount }} 片段</span></div>
            <div class="mi"><label>最近更新</label><span>{{ formatRelativeTime(selectedFile.updatedAt) }}</span></div>
            <div class="mi"><label>负责人</label><span>{{ selectedFile.ownerName ?? '—' }}</span></div>
          </div>
        </div>
      </template>
    </div>

    <!-- ============ 新建知识库 ============ -->
    <div v-if="kbDialog" class="mask" @click.self="kbDialog = false">
      <div class="modal" style="max-width: 440px">
        <div class="modal-h"><h3>新建知识库</h3><button class="x" @click="kbDialog = false">×</button></div>
        <div class="modal-b">
          <div class="field"><label>名称</label><input v-model="kbForm.name" placeholder="例如：报账知识库" @keyup.enter="doCreate" /></div>
          <div class="field"><label>描述（可选）</label><input v-model="kbForm.description" /></div>
          <div class="field"><label class="ck-row"><input type="checkbox" v-model="kbForm.isTeamSpace" /> 作为团队空间（全公司可见）</label></div>
        </div>
        <div class="modal-f">
          <span class="spacer" />
          <button class="btn" @click="kbDialog = false">取消</button>
          <button class="btn primary" :disabled="kbSaving || !kbForm.name.trim()" @click="doCreate">{{ kbSaving ? '创建中…' : '创建' }}</button>
        </div>
      </div>
    </div>

    <!-- ============ 在知识库内新建文档 ============ -->
    <div v-if="docDialog" class="mask" @click.self="docDialog = false">
      <div class="modal" style="max-width: 620px">
        <div class="modal-h">
          <h3>新建文档到「{{ activeKb?.name }}」</h3>
          <button class="x" @click="docDialog = false">×</button>
        </div>
        <div class="modal-b">
          <div style="display: flex; gap: 10px">
            <input v-model="docForm.name" class="grow" placeholder="文档名（不含扩展名）" style="flex: 1; height: 36px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 12px; font-size: 13px; font-family: inherit; outline: none" />
            <select v-model="docForm.extension" class="grow" style="height: 36px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 10px; font-size: 13px; font-family: inherit; background: var(--surface)">
              <option value="md">.md</option>
              <option value="csv">.csv</option>
            </select>
          </div>
          <textarea v-model="docForm.content" rows="12" placeholder="用 # 一级标题分隔章节，每段换行会被解析为列表项；保存后自动解析并加入知识库。" style="margin-top: 10px; width: 100%; min-height: 220px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; font-size: 13px; font-family: ui-monospace, SF Mono, Consolas, monospace; outline: none; resize: vertical" />
        </div>
        <div class="modal-f">
          <span class="spacer" />
          <button class="btn" @click="docDialog = false">取消</button>
          <button class="btn primary" :disabled="docSaving || !docForm.name.trim() || !docForm.content.trim()" @click="doCreateDoc">{{ docSaving ? '解析中…' : '保存并纳入' }}</button>
        </div>
      </div>
    </div>

    <!-- ============ 新建文件夹（可在任意层级下建子目录） ============ -->
    <div v-if="folderDialog" class="mask" @click.self="folderDialog = false">
      <div class="modal" style="max-width: 420px">
        <div class="modal-h">
          <h3>新建文件夹{{ folderForm.parentId ? '（子目录）' : '' }}</h3>
          <button class="x" @click="folderDialog = false">×</button>
        </div>
        <div class="modal-b">
          <div class="field">
            <label>名称</label>
            <input
              v-model="folderForm.name"
              class="grow"
              placeholder="例如：制度文件"
              @keyup.enter="doCreateFolder"
            />
          </div>
          <div class="tiny">
            {{ folderForm.parentId ? `将建在所选目录下` : `将建在「${activeKb?.name}」根目录下` }}
          </div>
        </div>
        <div class="modal-f">
          <span class="spacer" />
          <button class="btn" @click="folderDialog = false">取消</button>
          <button class="btn primary" :disabled="folderSaving || !folderForm.name.trim()" @click="doCreateFolder">
            {{ folderSaving ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ============ 调整文件在库内的目录 ============ -->
    <div v-if="moveTarget" class="mask" @click.self="moveTarget = null">
      <div class="modal" style="max-width: 440px">
        <div class="modal-h">
          <h3>移动「{{ moveTarget.name }}」</h3>
          <button class="x" @click="moveTarget = null">×</button>
        </div>
        <div class="modal-b">
          <div class="tiny" style="margin-bottom: 10px">
            只改变它在知识库里的位置，文件本身仍在「文件管理」原处，不下载、不复制。
          </div>
          <button class="move-opt" @click="doMove(null)">库根目录</button>
          <button v-for="o in folderOptions" :key="o.id" class="move-opt" @click="doMove(o.id)">
            {{ o.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- ============ 文件行「···」菜单 ============ -->
    <template v-if="fileMenu && menuFile">
      <div class="menu-mask" @click="fileMenu = null" @contextmenu.prevent="fileMenu = null" />
      <div class="kmenu" :style="{ left: `${fileMenu.x}px`, top: `${fileMenu.y}px` }" @click.stop>
        <button class="mi" @click="runMenuAction(downloadOriginal)">下载</button>
        <button class="mi" @click="runMenuAction(viewOriginal)">查看原文件</button>
        <button class="mi" @click="runMenuAction(openMove)">移动到…</button>
        <button class="mi" @click="runMenuAction(reparseFile)">重新解析</button>
        <div class="msep" />
        <button class="mi danger" @click="runMenuAction(removeFromKb)">从知识库移除</button>
      </div>
    </template>

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.kb2 { display: flex; gap: 16px; height: calc(100vh - 56px - 26px - 40px); }
.ktree {
  width: 300px; min-width: 260px; flex: 0 0 auto; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--r);
  display: flex; flex-direction: column; overflow: hidden;
}
.ktree-h { padding: 12px; }
.knav-search input { width: 100%; height: 32px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 10px; font-size: 12.5px; outline: none; background: var(--surface); color: var(--ink); font-family: inherit; }
.ktree-body { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
.kgrp { display: flex; align-items: center; padding: 10px 6px 6px; font-size: 11.5px; color: var(--ink-3); }
.kgrp .add { cursor: pointer; color: var(--ink-3); font-size: 14px; line-height: 1; user-select: none; }
.kgrp .add:hover { color: var(--brand); }
.klib { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-radius: var(--r-sm); cursor: pointer; font-size: 13px; color: var(--ink-2); }
.klib:hover { background: var(--g100); }
.klib.on { background: var(--brand-s); color: var(--brand); }
.klib.lock { cursor: not-allowed; opacity: .65; color: var(--ink-3); }
.klib .chev { font-size: 10px; width: 12px; }
.klib .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.klib .ct { font-size: 11px; color: var(--ink-3); background: var(--g100); border-radius: 8px; padding: 0 6px; line-height: 16px; }
.kb-rm {
  width: 18px; height: 18px; border: none; background: none; border-radius: 4px;
  color: var(--ink-3); cursor: pointer; font-size: 14px; line-height: 1; padding: 0;
  opacity: 0; transition: opacity var(--t), background var(--t), color var(--t);
}
.klib:hover .kb-rm { opacity: 1; }
.kb-rm:hover { background: var(--er-s); color: var(--er-t); }
.khint { padding: 8px 10px; font-size: 11.5px; color: var(--ink-3); }

.pv { flex: 1; min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); display: flex; flex-direction: column; overflow: hidden; }
.pv-h { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line-soft); flex-wrap: wrap; }
.crumb { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }

.hitbox {
  padding: 14px 16px; border-bottom: 1px solid var(--line-soft); background: var(--g25);
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
}
.hitbox .field { flex: 1; min-width: 240px; margin: 0; }
.hitbox .field input { width: 100%; height: 34px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 10px; font-size: 13px; font-family: inherit; outline: none; background: var(--surface); }
.frag { padding: 9px 12px; background: var(--surface); border: 1px solid var(--line-soft); border-radius: var(--r-sm); font-size: 12.5px; margin-bottom: 8px; }
.frag-body { color: var(--ink-2); margin-top: 4px; line-height: 1.6; }

/* 知识库就地展开的文件树 */
.kfiles { padding: 2px 0 6px; }

.pv-body { flex: 1; overflow-y: auto; padding: 24px 28px; }
.pv-title { font-size: 26px; font-weight: 500; letter-spacing: -.4px; margin: 0 0 8px; }
.pv-hint { margin-bottom: 16px; }

.doc-quote {
  border-left: 3px solid var(--brand);
  padding: 2px 0 2px 12px;
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink-2);
}
.doc-txt h3 { font-size: 15px; font-weight: 500; margin: 18px 0 8px; color: var(--ink); }
.doc-txt h3:first-child { margin-top: 0; }
.doc-txt p { font-size: 13.5px; line-height: 1.9; margin: 0 0 10px; color: var(--ink); }
.doc-txt ul { margin: 0 0 12px; padding-left: 22px; }
.doc-txt li { font-size: 13.5px; line-height: 1.9; margin: 3px 0; color: var(--ink); }

/* 底部元信息网格 */
.pv-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px 20px;
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--line-soft);
}
.pv-meta .mi { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pv-meta label { font-size: 11.5px; color: var(--ink-3); }
.pv-meta span { font-size: 12.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; }

/* 文件行「···」菜单 */
.menu-mask { position: fixed; inset: 0; z-index: 300; }
.kmenu {
  position: fixed;
  z-index: 301;
  min-width: 150px;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .12);
}
.kmenu .mi {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 12.5px;
  color: var(--ink);
  cursor: pointer;
}
.kmenu .mi:hover { background: var(--g100); }
.kmenu .mi.danger { color: var(--er); }
.kmenu .msep { height: 1px; margin: 4px 6px; background: var(--line-soft); }

/* 「＋ 新建」下拉 */
.new-wrap { position: relative; }
.new-mask { position: fixed; inset: 0; z-index: 300; }
.new-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 301;
  min-width: 180px;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .12);
}
.new-menu button {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 12.5px;
  color: var(--ink);
  cursor: pointer;
}
.new-menu button:hover { background: var(--g100); }
.new-menu button:disabled { color: var(--ink-3); cursor: default; }
.new-menu .msep { height: 1px; margin: 4px 6px; background: var(--line-soft); }

/* 移动文件时的目录选项 */
.move-opt {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 13px;
  font-family: inherit;
  color: var(--ink);
  cursor: pointer;
}
.move-opt:hover { background: var(--g100); }

.mask { position: fixed; inset: 0; z-index: 300; background: rgba(16, 24, 40, .45); display: flex; align-items: center; justify-content: center; padding: 24px; }
.modal { width: 100%; max-width: 560px; background: var(--surface); border-radius: var(--r-l); box-shadow: var(--sh-pop); display: flex; flex-direction: column; max-height: 90vh; overflow: hidden; }
.modal-h { display: flex; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--line-soft); }
.modal-h h3 { font-size: 14px; margin: 0; font-weight: 500; }
.x { margin-left: auto; border: none; background: none; font-size: 18px; cursor: pointer; color: var(--ink-3); padding: 4px 8px; }
.modal-b { padding: 20px; overflow-y: auto; }
.modal-b .field { margin-bottom: 14px; }
.modal-b .field label { display: block; font-size: 12px; color: var(--ink-3); margin-bottom: 6px; }
.modal-b .field input { width: 100%; height: 36px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 12px; font-size: 13px; font-family: inherit; outline: none; background: var(--surface); }
.modal-b .field input:focus { border-color: var(--b400); box-shadow: 0 0 0 3px rgba(59,130,246,.14); }
.ck-row { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.modal-f { display: flex; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--line-soft); }

.toasts { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 400; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { padding: 10px 18px; border-radius: var(--r-sm); background: var(--g900); color: #fff; font-size: 13px; }
.toast.err { background: var(--er-t); }
</style>
