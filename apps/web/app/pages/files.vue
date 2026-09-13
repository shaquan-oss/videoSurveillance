<script setup lang="ts">
import type { FileItem, Folder, SecurityLevel } from '@kh/shared';
import { buildKbTree, formatBytes, formatRelativeTime, PARSEABLE_EXTENSIONS, SECURITY_LEVELS } from '@kh/shared';

/**
 * 文件管理 —— 阶段一的核心页面。
 *
 * 三条界面纪律（沿用原型里定下的规则，保持一致）：
 *   1. 轻操作行内做（查看 / 下载），其余动作统一收进 ··· 菜单，避免一行堆五个按钮；
 *   2. 每个列表都有空状态、加载态、错误态 —— 演示时最容易穿帮的就是只做了顺利路径；
 *   3. 权限相关的信息写在明面上（密级 + 可见范围），因为这是这个系统最容易出事故的地方。
 */

const api = useApi();
const { user, can } = useAuth();
const { levelLabel, levelColor, indexLabel, indexBadgeClass, extColor, scopeLabel } = useFileMeta();

/* ───────────── 列表状态 ───────────── */

const query = reactive({
  keyword: '',
  folderId: '' as string,
  securityLevel: '' as string,
  trash: false,
  page: 1,
  pageSize: 20,
  sortBy: 'updatedAt' as 'name' | 'size' | 'createdAt' | 'updatedAt',
  sortOrder: 'desc' as 'asc' | 'desc',
});

const loadError = ref('');

/**
 * 用 useAsyncData 而不是 onMounted 拉数据。
 *
 * 区别很实际：onMounted 只在浏览器执行，所以服务端渲染出来的首屏是骨架屏，
 * 用户会看到「先空一下再填内容」的闪烁。useAsyncData 在服务端也会执行，
 * 首屏 HTML 里直接带真实数据 —— 这也是保留 Nuxt SSR 的意义所在。
 */
const {
  data: listData,
  pending: loading,
  refresh: refreshList,
} = await useAsyncData(
  'files-list',
  async () => {
    try {
      loadError.value = '';
      return await api.listFiles({
        page: query.page,
        pageSize: query.pageSize,
        ...(query.keyword ? { keyword: query.keyword } : {}),
        ...(query.folderId ? { folderId: query.folderId } : {}),
        ...(query.securityLevel ? { securityLevel: query.securityLevel } : {}),
        ...(query.trash ? { trash: true } : {}),
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      });
    } catch (err) {
      // 自己接住错误并给一个空结果：否则整页会变成 500，
      // 用户看到的是"系统崩了"，而不是"加载失败，可以重试"。
      loadError.value = err instanceof Error ? err.message : '加载失败';
      return { items: [] as FileItem[], total: 0, page: 1, pageSize: 20 };
    }
  },
  {
    default: () => ({
      items: [] as FileItem[],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
    // 筛选条件变化时自动重新拉取
    watch: [
      () => query.page,
      () => query.folderId,
      () => query.securityLevel,
      () => query.trash,
      () => query.sortBy,
      () => query.sortOrder,
    ],
  },
);

const files = computed(() => listData.value?.items ?? []);
const total = computed(() => listData.value?.total ?? 0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / query.pageSize)));

function load() {
  return refreshList();
}

/* ───────────── 文件夹与部门 ═══════════════ */

const { data: foldersData } = await useAsyncData(
  'folders',
  async () => {
    try {
      return await api.listFolders();
    } catch {
      return [] as Folder[];
    }
  },
  { default: () => [] as Folder[] },
);

const folders = computed(() => foldersData.value ?? []);

/* ───────────── 文件夹树（无限层级） ═══════════════ */

/** 树节点：在原 Folder 上挂 children，递归组装 */
interface FolderNode extends Folder {
  children: FolderNode[];
}

/** 把后端返回的平铺列表组装成树；根是 parentId 为空的那些 */
const folderTree = computed<FolderNode[]>(() => {
  const list = folders.value;
  const map = new Map<string, FolderNode>();
  for (const f of list) map.set(f.id, { ...f, children: [] });
  const roots: FolderNode[] = [];
  for (const f of list) {
    const node = map.get(f.id)!;
    const parent = f.parentId ? map.get(f.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // 每层按名称排序，保持稳定
  const sortRec = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
});

/** 展开状态：默认把根层和所有有子目录的节点展开，方便一眼看到结构 */
const expandedIds = ref<Set<string>>(new Set());
function ensureExpanded() {
  const s = expandedIds.value;
  const walk = (nodes: FolderNode[]) => {
    for (const n of nodes) {
      if (n.children.length > 0) s.add(n.id);
      walk(n.children);
    }
  };
  walk(folderTree.value);
}
// 文件夹数据首次到齐后，把整棵树展开
watch(folderTree, () => ensureExpanded(), { immediate: true });

function toggleFolder(id: string) {
  const s = new Set(expandedIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  expandedIds.value = s;
}

function isExpanded(id: string) {
  return expandedIds.value.has(id);
}

/** 当前选中文件夹的祖先链（面包屑用） */
const breadcrumb = computed<Folder[]>(() => {
  const chain: Folder[] = [];
  let id = query.folderId;
  const map = new Map(folders.value.map((f) => [f.id, f]));
  let guard = 0;
  while (id && guard++ < 50) {
    const f = map.get(id);
    if (!f) break;
    chain.unshift(f);
    id = f.parentId ?? '';
  }
  return chain;
});

function enterFolder(id: string) {
  query.folderId = id;
  query.page = 1;
  clearSelection();
  load();
}

function goRoot() {
  query.folderId = '';
  query.page = 1;
  clearSelection();
  load();
}

/* ───────────── 新建文件夹 ═══════════════ */

const folderDialog = ref(false);
const newFolderName = ref('');
const newFolderParentId = ref<string | null>(null);
const folderSaving = ref(false);
const folderError = ref('');

function openNewFolder(parentId: string | null = null) {
  newFolderName.value = '';
  newFolderParentId.value = parentId ?? (query.folderId || null);
  folderError.value = '';
  folderDialog.value = true;
}

async function doCreateFolder() {
  const name = newFolderName.value.trim();
  if (!name || folderSaving.value) return;
  folderSaving.value = true;
  folderError.value = '';
  try {
    await api.createFolder(name, newFolderParentId.value);
    folderDialog.value = false;
    toast(`已新建文件夹「${name}」`);
    await refreshNuxtData('folders');
  } catch (err) {
    folderError.value = err instanceof Error ? err.message : '新建失败';
  } finally {
    folderSaving.value = false;
  }
}

/* ───────────── 批量选择与批量删除 ═══════════════ */

const selectedIds = ref<Set<string>>(new Set());

function toggleSelect(id: string) {
  const s = new Set(selectedIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selectedIds.value = s;
}

function isSelected(id: string) {
  return selectedIds.value.has(id);
}

/** 当前页里所有文件的 id（用于全选） */
const pageIds = computed(() => files.value.map((f) => f.id));
const allSelected = computed(() => pageIds.value.length > 0 && pageIds.value.every((id) => selectedIds.value.has(id)));

function toggleSelectAll() {
  const s = new Set(selectedIds.value);
  if (allSelected.value) {
    for (const id of pageIds.value) s.delete(id);
  } else {
    for (const id of pageIds.value) s.add(id);
  }
  selectedIds.value = s;
}

function clearSelection() {
  selectedIds.value = new Set();
}

const batchDeleting = ref(false);

async function batchDeleteSelected() {
  const ids = [...selectedIds.value];
  if (ids.length === 0 || batchDeleting.value) return;
  batchDeleting.value = true;
  try {
    const res = await api.batchDelete(ids);
    toast(`已移入回收站 ${res.okCount} 个文件`);
    clearSelection();
    await Promise.all([refreshList(), refreshNuxtData('usage')]);
  } catch (err) {
    toast(err instanceof Error ? err.message : '批量删除失败', 'err');
  } finally {
    batchDeleting.value = false;
  }
}

/* ───────────── 内嵌预览（当场查看） ═══════════════ */

const preview = ref<{
  url: string;
  name: string;
  kind: 'pdf' | 'image' | 'video' | 'audio' | 'text' | 'unsupported';
  mimeType?: string;
} | null>(null);
const previewLoading = ref(false);

/** 根据扩展名判断预览方式；无法内嵌的一律归 unsupported，只给下载 */
function previewKind(ext: string): NonNullable<typeof preview.value>['kind'] {
  const e = ext.toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(e)) return 'image';
  if (['mp4', 'webm', 'mov'].includes(e)) return 'video';
  if (['mp3', 'wav', 'ogg'].includes(e)) return 'audio';
  if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'log'].includes(e)) return 'text';
  return 'unsupported';
}

/** 在页面内当场打开预览（不下载、不新开标签页） */
async function openInlinePreview(item: FileItem) {
  const kind = previewKind(item.extension);
  if (kind === 'unsupported') {
    toast('该格式（如 Office / 压缩包）浏览器无法在线渲染，需下载后用本地软件打开', 'err');
    return;
  }
  previewLoading.value = true;
  preview.value = { url: '', name: item.name, kind };
  try {
    const { url } = await api.previewUrl(item.id);
    preview.value = { url, name: item.name, kind };
  } catch (err) {
    toast(err instanceof Error ? err.message : '加载预览失败', 'err');
    preview.value = null;
  } finally {
    previewLoading.value = false;
  }
}

function closePreview() {
  preview.value = null;
}

/** 部门 id → 名称，用于把「可见范围」翻译成人能看懂的话 */
const { data: usageData } = await useAsyncData(
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

const deptNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const d of usageData.value?.byDepartment ?? []) {
    if (d.departmentId) map[d.departmentId] = d.departmentName;
  }
  return map;
});

function deptName(id: string) {
  return deptNames.value[id] ?? id.slice(0, 8);
}

/* ───────────── 筛选 ───────────── */

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  // 输入防抖，避免每敲一个字就发一次请求
  searchTimer = setTimeout(() => {
    query.page = 1;
    load();
  }, 320);
}

function resetFilters() {
  query.keyword = '';
  query.folderId = '';
  query.securityLevel = '';
  query.page = 1;
  load();
}

function toggleTrash() {
  query.trash = !query.trash;
  query.page = 1;
  clearSelection();
  load();
}

function changePage(delta: number) {
  const next = query.page + delta;
  if (next < 1 || next > totalPages.value) return;
  query.page = next;
  load();
}

function sortBy(col: typeof query.sortBy) {
  if (query.sortBy === col) {
    query.sortOrder = query.sortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    query.sortBy = col;
    query.sortOrder = col === 'name' ? 'asc' : 'desc';
  }
  load();
}

/* ───────────── 上传（多文件 / 文件夹 / 拖拽目录）───────────── */

const uploadDialog = ref(false);
const uploadLevel = ref<SecurityLevel>('internal');
const uploadDepts = ref<string[]>([]);
const uploading = ref(false);
const uploadError = ref('');

/** 待上传文件：多选、选文件夹、拖目录进来的都汇总到这里 */
interface PendingFile {
  key: string;
  file: File;
  /** 来自文件夹时的相对路径（仅展示，暂不落库建子目录） */
  relPath?: string;
  status: 'pending' | 'ok' | 'fail';
  error?: string;
}

const pendingFiles = ref<PendingFile[]>([]);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);

const parseableExtensions = PARSEABLE_EXTENSIONS as readonly string[];
const MAX_SIZE = 200 * 1024 * 1024;

/**
 * 本次上传落到哪个目录。
 * 在目录树某一行点「↥」时传入该目录，省掉「先进去再传」这一步；
 * 从页头按钮进来时为空，此时沿用当前所在目录。
 */
const uploadTarget = ref<{ id: string | null; name: string | null }>({
  id: null,
  name: null,
});

function openUpload(folderId: string | null = null, folderName: string | null = null) {
  uploadTarget.value = { id: folderId, name: folderName };
  pendingFiles.value = [];
  uploadLevel.value = 'internal';
  uploadDepts.value = [];
  uploadError.value = '';
  uploadDialog.value = true;
}

/** 目录树上点「上传」：打开对话框并直接弹出选择器 */
function onFolderUpload(payload: { id: string; name: string }, kind: 'files' | 'folder') {
  openUpload(payload.id, payload.name);
  void nextTick(() => (kind === 'folder' ? pickFolder() : pickFiles()));
}

function addFiles(items: { file: File; relPath?: string }[]) {
  let skipped = 0;
  let hidden = 0;
  for (const { file: f, relPath } of items) {
    const key = `${f.name}:${f.size}:${f.lastModified}`;
    if (pendingFiles.value.some((p) => p.key === key)) continue; // 按 名称+大小+时间 去重
    // 系统隐藏文件 / 临时文件直接跳过：.DS_Store、Thumbs.db、macOS 元数据、Office 临时文件等
    // 这些文件没业务价值，传上来只会污染文件库（曾经误传到采购项目文件夹里，过几行才看到）
    if (isJunkFileName(f.name)) {
      hidden++;
      continue;
    }
    if (f.size > MAX_SIZE) {
      skipped++;
      continue;
    }
    pendingFiles.value.push({ key, file: f, relPath, status: 'pending' });
  }
  if (hidden > 0) {
    uploadError.value =
      hidden === 1 ? `已跳过 1 个系统隐藏文件（如 .DS_Store / Thumbs.db）` : `已跳过 ${hidden} 个系统隐藏文件（如 .DS_Store / Thumbs.db）`;
  } else if (skipped > 0) {
    uploadError.value = `有 ${skipped} 个文件超过 200MB 上限，已跳过`;
  } else {
    uploadError.value = '';
  }
}

/**
 * 判断文件名是不是系统隐藏/临时文件 —— 用户上传时直接跳过。
 * 覆盖：macOS（.DS_Store、._*、__MACOSX）、Windows（Thumbs.db、desktop.ini）、
 * Office 临时文件（~$xxx.docx）、常见的归档临时文件（.crdownload、.part）。
 */
function isJunkFileName(name: string): boolean {
  if (!name) return true;
  const base = name.split('/').pop() ?? name;
  if (base.startsWith('~$') || base.startsWith('.') || base.startsWith('__')) return true;
  const lower = base.toLowerCase();
  if (
    lower === 'thumbs.db' ||
    lower === 'desktop.ini' ||
    lower.endsWith('.crdownload') ||
    lower.endsWith('.part') ||
    lower.endsWith('.tmp') ||
    lower.includes('~lock.')
  ) {
    return true;
  }
  return false;
}

function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement;
  addFiles(Array.from(input.files ?? []).map((f) => ({ file: f })));
  input.value = ''; // 清空，允许再次选择同一批
}

function pickFolder() {
  // 先把 value 清空：
  // macOS / Chrome 的 webkitdirectory 在「选了和上次相同的文件夹」时
  // 会因为新旧值相同而不发 change 事件，导致 pendingFiles 看起来没动静。
  if (folderInput.value) folderInput.value.value = '';
  folderInput.value?.click();
}

function pickFiles() {
  if (fileInput.value) fileInput.value.value = '';
  fileInput.value?.click();
}

function onFolderInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []) as (File & {
    webkitRelativePath?: string;
  })[];
  // webkitRelativePath 形如「项目资料/合同/扫描件.pdf」，完整保留用于重建目录层级。
  // macOS Chrome 偶发会把 webkitRelativePath 留空字符串（只剩文件名），此时按扁平上传，保留文件不断层可补回。
  if (files.length === 0) {
    // 极少见：选完对话框点了取消、或者浏览器版本异常 —— 提示一下
    toast('没有识别到任何文件，请换一个文件夹再试，或改用拖拽方式', 'err');
  }
  const items = files.map((f) => ({
    file: f,
    relPath: f.webkitRelativePath || undefined,
  }));
  addFiles(items);
  input.value = '';
  if (files.length > 0) {
    const withPath = items.filter((x) => x.relPath).length;
    if (withPath === 0) {
      toast(`已选 ${files.length} 个文件，但未能识别层级，将按平铺上传。可改用拖拽保留目录。`, 'err');
    }
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  const items = e.dataTransfer?.items;
  if (items && items.length > 0) {
    collectDropped(items).then(addFiles);
    return;
  }
  addFiles(Array.from(e.dataTransfer?.files ?? []).map((f) => ({ file: f })));
}

/** 递归读取拖入的目录与文件（webkitGetAsEntry），支持拖整个文件夹，并带上相对路径 */
async function collectDropped(items: DataTransferItemList): Promise<{ file: File; relPath?: string }[]> {
  const entries: (FileSystemEntry | null)[] = Array.from(items).map(
    (it) =>
      (
        it as DataTransferItem & {
          webkitGetAsEntry?: () => FileSystemEntry | null;
        }
      ).webkitGetAsEntry?.() ?? null,
  );
  const out: { file: File; relPath?: string }[] = [];

  /**
   * readEntries 每次最多返回 100 条，读一次会漏掉大目录后面的文件。
   * 必须循环调用，直到返回空数组，才算把整个目录读全。
   */
  function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => {
      const all: FileSystemEntry[] = [];
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          readBatch();
        }, reject);
      };
      readBatch();
    });
  }

  async function walk(entry: FileSystemEntry | null, prefix: string) {
    if (!entry) return;
    if (entry.isFile) {
      const f = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file: f, relPath: prefix ? `${prefix}/${f.name}` : f.name });
    } else if (entry.isDirectory) {
      const name = entry.name;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const sub = await readAllEntries(reader);
      for (const s of sub) await walk(s, prefix ? `${prefix}/${name}` : name);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}

function removePending(key: string) {
  pendingFiles.value = pendingFiles.value.filter((p) => p.key !== key);
}

/** 取相对路径里的目录部分（去掉末尾文件名） */
function dirOf(relPath?: string): string {
  if (!relPath) return '';
  const parts = relPath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/** 有多少文件带 relPath（用于在顶部提示「层级是否保留」） */
const relPathCovered = computed(() => {
  const arr = pendingFiles.value;
  if (arr.length === 0) return 0;
  return arr.filter((p) => p.relPath).length;
});
const relPathMissing = computed(() => pendingFiles.value.length - relPathCovered.value);
/** 是否提示用户：用文件夹上传时未识别到层级 */
const showLayerWarning = computed(() => pendingFiles.value.length > 0 && relPathCovered.value === 0);

/** 有没有可解析成文本的文件（纳入知识库时会被解析），顺手标一下 */
const willBeParseable = computed(() =>
  pendingFiles.value.some((p) => {
    const ext = p.file.name.split('.').pop()?.toLowerCase() ?? '';
    return parseableExtensions.includes(ext);
  }),
);

async function doUpload() {
  if (pendingFiles.value.length === 0 || uploading.value) return;
  if (uploadLevel.value === 'department' && uploadDepts.value.length === 0) {
    uploadError.value = '选择「部门」密级时必须指定可见部门';
    return;
  }

  uploading.value = true;
  uploadError.value = '';
  try {
    const form = new FormData();
    for (const p of pendingFiles.value) {
      form.append('files', p.file, p.file.name);
      // 相对路径与文件一一对应；无层级时传空串占位，保证数组对齐
      form.append('relPaths', p.relPath ?? '');
    }
    form.append('securityLevel', uploadLevel.value);
    if (uploadDepts.value.length) form.append('visibleDeptIds', uploadDepts.value.join(','));
    // 树行上传时用指定的目录，否则沿用当前所在目录
    const targetFolder = uploadTarget.value.id ?? query.folderId;
    if (targetFolder) form.append('folderId', targetFolder);

    const res = await api.upload(form);

    // 用后端返回的逐项结果回填状态
    for (const p of pendingFiles.value) {
      const r = res.results.find((x) => x.name === p.file.name);
      if (r?.ok) p.status = 'ok';
      else {
        p.status = 'fail';
        p.error = r?.error ?? '未返回结果';
      }
    }

    if (res.failCount === 0) {
      toast(`已上传 ${res.okCount} 个文件`);
      uploadDialog.value = false;
    } else {
      toast(`成功 ${res.okCount} 个，失败 ${res.failCount} 个（见列表）`, 'err');
    }
    // 刷新列表与用量
    await Promise.all([refreshList(), refreshNuxtData('usage')]);
  } catch (err) {
    uploadError.value = err instanceof Error ? err.message : '上传失败';
  } finally {
    uploading.value = false;
  }
}

/* ───────────── 下载 ───────────── */

/** 下载走预签名链接：后端先校验权限再签发短时效地址，文件流不经过后端 */
async function download(item: FileItem) {
  try {
    const { url } = await api.downloadUrl(item.id);
    window.open(url, '_blank', 'noopener');
    toast('已开始下载');
  } catch (err) {
    toast(err instanceof Error ? err.message : '下载失败', 'err');
  }
}

/** 「打开」= 在页面内当场预览；不能内嵌的类型提示下载 */
function openPreview(item: FileItem) {
  openInlinePreview(item);
}

/* ───────────── 行菜单 ───────────── */

const openMenuId = ref<string | null>(null);

function toggleMenu(id: string, e: MouseEvent) {
  e.stopPropagation();
  openMenuId.value = openMenuId.value === id ? null : id;
}

function closeMenu() {
  openMenuId.value = null;
}

onMounted(() => document.addEventListener('click', closeMenu));
onBeforeUnmount(() => document.removeEventListener('click', closeMenu));

/* ───────────── 详情抽屉 ───────────── */

const detail = ref<FileItem | null>(null);

function openDetail(item: FileItem) {
  detail.value = item;
}

/* ───────────── 密级设置 ───────────── */

const secDialog = ref(false);
const secTarget = ref<FileItem | null>(null);
const secLevel = ref<SecurityLevel>('internal');
const secDepts = ref<string[]>([]);
const secSaving = ref(false);
const secError = ref('');

function openSecurity(item: FileItem) {
  secTarget.value = item;
  secLevel.value = item.securityLevel;
  secDepts.value = [...(item.visibleDeptIds ?? [])];
  secError.value = '';
  secDialog.value = true;
  closeMenu();
}

async function saveSecurity() {
  if (!secTarget.value || secSaving.value) return;
  if (secLevel.value === 'department' && secDepts.value.length === 0) {
    secError.value = '选择「部门」密级时必须指定可见部门';
    return;
  }
  secSaving.value = true;
  secError.value = '';
  try {
    const updated = await api.setSecurity(secTarget.value.id, {
      securityLevel: secLevel.value,
      visibleDeptIds: secDepts.value,
    });
    secDialog.value = false;
    toast(`密级已改为「${levelLabel(updated.securityLevel)}」`);
    if (detail.value?.id === updated.id) detail.value = updated;
    await load();
  } catch (err) {
    secError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    secSaving.value = false;
  }
}

/* ───────────── 其他行内动作 ───────────── */

const renameTarget = ref<FileItem | null>(null);
const renameValue = ref('');

function openRename(item: FileItem) {
  renameTarget.value = item;
  renameValue.value = item.name;
  closeMenu();
}

async function doRename() {
  if (!renameTarget.value) return;
  try {
    await api.renameFile(renameTarget.value.id, renameValue.value);
    renameTarget.value = null;
    toast('已重命名');
    await load();
  } catch (err) {
    toast(err instanceof Error ? err.message : '重命名失败', 'err');
  }
}

async function toggleFavorite(item: FileItem) {
  closeMenu();
  try {
    await api.favorite(item.id, !item.isFavorite);
    toast(item.isFavorite ? '已取消收藏' : '已收藏');
    await load();
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败', 'err');
  }
}

async function removeFile(item: FileItem) {
  closeMenu();
  try {
    await api.removeFile(item.id);
    toast('已移入回收站');
    await Promise.all([refreshList(), refreshNuxtData('usage')]);
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'err');
  }
}

async function restoreFile(item: FileItem) {
  try {
    await api.restoreFile(item.id);
    toast('已恢复到原位置');
    await load();
  } catch (err) {
    toast(err instanceof Error ? err.message : '恢复失败', 'err');
  }
}

/* ───────────── 移动到文件夹 ═══════════════ */

const moveDialog = ref(false);
const moveTarget = ref<FileItem | null>(null);
const moveBatchMode = ref(false);
const moveTargetFolderId = ref<string | null>(null);
const moveSaving = ref(false);
const moveError = ref('');

/**
 * 「移动到」对话框。
 * - item 传单个文件，单移动
 * - 不传 item → 批量移动（用 selectedIds）
 */
function openMove(item?: FileItem) {
  if (item) {
    moveBatchMode.value = false;
    moveTarget.value = item;
  } else {
    moveBatchMode.value = true;
    moveTarget.value = null;
  }
  // 目标默认是「当前所在文件夹」，但当前正在被过滤的文件夹显然不是目标，要清掉
  moveTargetFolderId.value = query.folderId && query.folderId !== item?.folderId ? query.folderId : null;
  moveError.value = '';
  moveDialog.value = true;
  closeMenu();
}

async function doMove() {
  if (moveSaving.value) return;
  moveSaving.value = true;
  moveError.value = '';
  try {
    if (moveBatchMode.value) {
      const ids = [...selectedIds.value];
      if (ids.length === 0) {
        moveSaving.value = false;
        return;
      }
      const res = await api.batchMove(ids, moveTargetFolderId.value);
      if (res.okCount === ids.length) {
        toast(`已移动 ${ids.length} 个文件`);
      } else {
        toast(`成功 ${res.okCount}，失败 ${ids.length - res.okCount}`, 'err');
      }
      clearSelection();
    } else if (moveTarget.value) {
      await api.moveFile(moveTarget.value.id, moveTargetFolderId.value);
      toast('已移动');
    }
    moveDialog.value = false;
    await load();
  } catch (err) {
    moveError.value = err instanceof Error ? err.message : '移动失败';
  } finally {
    moveSaving.value = false;
  }
}

/* ───────────── 纳入知识库 ═══════════════ */

/**
 * 纳入知识库统一放在文件管理侧（原型如此）：
 * 勾文件就是文件，勾文件夹就是文件夹 —— 后者会在知识库里镜像出同名目录层级。
 */
const kbDialog = ref(false);
const kbList = ref<{ id: string; name: string; isTeamSpace: boolean }[]>([]);
const kbListLoading = ref(false);
const kbTargetId = ref('');
const kbTargetFolderId = ref<string | null>(null);
const kbTargetFolders = ref<{ id: string; label: string }[]>([]);
const kbBusy = ref(false);

/** 本次要纳入的内容：选中的文件，或某一个文件夹（二选一） */
const kbSource = ref<{ kind: 'files'; items: FileItem[] } | { kind: 'folder'; id: string; name: string } | null>(null);

async function openIngestDialog(source: NonNullable<typeof kbSource.value>) {
  kbSource.value = source;
  kbTargetId.value = '';
  kbTargetFolderId.value = null;
  kbTargetFolders.value = [];
  kbDialog.value = true;
  closeMenu();

  kbListLoading.value = true;
  try {
    const { visible } = await api.listKbs();
    kbList.value = visible;
    if (visible.length === 1) await loadKbTargetFolders();
  } catch {
    kbList.value = [];
  } finally {
    kbListLoading.value = false;
  }
}

/** 切换目标知识库后，拉它的目录树，供选择「放进哪个目录」 */
async function loadKbTargetFolders() {
  kbTargetFolderId.value = null;
  kbTargetFolders.value = [];
  if (!kbTargetId.value) return;
  try {
    const tree = await api.kbTree(kbTargetId.value);
    const out: { id: string; label: string }[] = [];
    const walk = (nodes: ReturnType<typeof buildKbTree>, depth: number) => {
      for (const n of nodes) {
        if (n.kind !== 'folder') continue;
        out.push({ id: n.id, label: `${'　'.repeat(depth)}${n.name}` });
        walk(n.children, depth + 1);
      }
    };
    walk(buildKbTree(tree.folders, tree.files), 0);
    kbTargetFolders.value = out;
  } catch {
    kbTargetFolders.value = [];
  }
}

async function doIngest() {
  const source = kbSource.value;
  if (!source || !kbTargetId.value || kbBusy.value) return;
  kbBusy.value = true;
  try {
    if (source.kind === 'files') {
      const res = await api.ingestFilesToKb(
        kbTargetId.value,
        source.items.map((f) => f.id),
        kbTargetFolderId.value,
      );
      toast(
        res.failCount ? `已纳入 ${res.okCount} 个，${res.failCount} 个失败` : `已纳入 ${res.okCount} 个文件`,
        res.okCount ? 'ok' : 'err',
      );
      clearSelection();
    } else {
      const res = await api.ingestFolderToKb(kbTargetId.value, source.id, kbTargetFolderId.value);
      toast(
        res.failCount
          ? `文件夹已纳入（${res.folderCount} 个目录 / ${res.okCount} 个文件，${res.failCount} 个未解析）`
          : `文件夹已纳入（${res.folderCount} 个目录 / ${res.okCount} 个文件）`,
      );
    }
    kbDialog.value = false;
    await load();
  } catch (err) {
    toast(err instanceof Error ? err.message : '纳入失败', 'err');
  } finally {
    kbBusy.value = false;
  }
}

/* ───────────── 永久删除 / 清空回收站 ═══════════════ */

const purging = ref(false);

async function purgeFile(item: FileItem) {
  closeMenu();
  if (!confirm(`彻底删除「${item.name}」？\n此操作不可撤销，对象存储里的字节也会清空。`)) return;
  purging.value = true;
  try {
    await api.purgeFile(item.id);
    toast('已彻底删除');
    await Promise.all([refreshList(), refreshNuxtData('usage')]);
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'err');
  } finally {
    purging.value = false;
  }
}

async function purgeAll() {
  if (total.value === 0) return;
  if (!confirm(`清空回收站（${total.value} 个文件）？\n\n所有文件将永久删除，对象存储里的字节也会清空。\n此操作不可撤销。`)) return;
  purging.value = true;
  try {
    const res = await api.purgeAllTrash();
    toast(`回收站已清空（${res.removed} 个文件）`);
    await Promise.all([refreshList(), refreshNuxtData('usage')]);
  } catch (err) {
    toast(err instanceof Error ? err.message : '清空失败', 'err');
  } finally {
    purging.value = false;
  }
}

/* ───────────── 文件夹删除（含级联）═══════════════ */

/** 单个文件夹删除：先尝试非强删；非空时弹出确认改成强制级联 */
async function removeFolderAsk(id: string, name: string) {
  if (!confirm(`删除文件夹「${name}」？\n\n· 文件夹为空 → 直接删\n· 文件夹非空 → 弹二次确认是否级联删除（连文件一起删）`)) return;
  // 试一次非强删；如果失败（文件夹非空），再弹二次确认
  try {
    await api.removeFolder(id, false);
    toast('文件夹已删除');
    await refreshNuxtData('folders');
    if (query.folderId === id) {
      query.folderId = '';
      query.page = 1;
      clearSelection();
      await load();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '删除失败';
    if (msg.includes('文件夹内还有文件') || /not empty/i.test(msg)) {
      if (!confirm(`文件夹「${name}」内还有文件，连同子文件夹一起全部永久删除？\n\n此操作不可撤销，对象存储里的字节也会清空。`)) return;
      try {
        const res = await api.removeFolder(id, true);
        toast(`已级联删除 ${res.removed.folders} 个文件夹、${res.removed.files} 个文件`);
        await refreshNuxtData('folders');
        if (query.folderId === id || query.folderId?.startsWith(id)) {
          query.folderId = '';
          query.page = 1;
          clearSelection();
          await load();
        }
      } catch (err2) {
        toast(err2 instanceof Error ? err2.message : '级联删除失败', 'err');
      }
      return;
    }
    toast(msg, 'err');
  }
}

/* ───────────── 轻提示 ───────────── */

const toasts = ref<{ id: number; text: string; kind: 'ok' | 'err' }[]>([]);
let toastSeq = 0;

function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  const id = ++toastSeq;
  toasts.value.push({ id, text, kind });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3000);
}
</script>

<template>
  <div>
    <div class="ph">
      <div>
        <h1>文件管理</h1>
        <div class="desc">
          你只能看到有权限查看的文件。当前身份：{{ user?.name }}（{{ user?.departmentName ?? '未归属部门' }}）
        </div>
      </div>
      <div class="spacer" />
      <button v-if="can('file:upload')" class="btn" @click="openNewFolder()">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
          <path d="M2 5.5V4a1 1 0 0 1 1-1h2l1.5 2H13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
        </svg>
        新建文件夹
      </button>
      <button v-if="can('file:upload')" class="btn primary" @click="openUpload()">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        上传文件
      </button>
    </div>

    <!-- 两栏：左目录树 + 右文件列表 -->
    <div class="files-layout">
      <aside class="tree-panel">
        <div class="tree-head">
          <span class="tree-title">文件夹</span>
          <button v-if="can('file:upload')" class="tree-add" title="新建文件夹" @click="openNewFolder()">＋</button>
        </div>
        <div class="tree-body">
          <div class="tree-root" :class="{ on: !query.folderId }" @click="goRoot">
            <span class="tree-ico">📁</span>
            <span class="tree-name">全部文件</span>
          </div>
          <FolderTreeItem
            v-for="node in folderTree"
            :key="node.id"
            :node="node"
            :depth="0"
            :current="query.folderId"
            :expanded="expandedIds"
            @enter="enterFolder"
            @toggle="toggleFolder"
            @new-sub="openNewFolder"
            @ingest="(p) => openIngestDialog({ kind: 'folder', id: p.id, name: p.name })"
            @remove="(p) => removeFolderAsk(p.id, p.name)"
            @upload="onFolderUpload"
          />
          <div v-if="folderTree.length === 0" class="tree-empty">还没有文件夹，点右上「＋」新建</div>
        </div>
      </aside>

      <div class="files-main">
        <!-- 面包屑：显示当前位置 -->
        <div v-if="!query.trash" class="crumb">
          <button class="crumb-item" @click="goRoot">全部文件</button>
          <template v-for="(f, i) in breadcrumb" :key="f.id">
            <span class="crumb-sep">/</span>
            <button class="crumb-item" :class="{ cur: i === breadcrumb.length - 1 }" @click="enterFolder(f.id)">{{ f.name }}</button>
          </template>
        </div>

    <!-- 工具栏：筛选与视图切换 -->
    <div class="toolbar">
      <input
        v-model="query.keyword"
        class="search"
        placeholder="按文件名搜索"
        @input="onSearchInput"
      />

      <select v-model="query.securityLevel" class="sel" @change="query.page = 1; load()">
        <option value="">全部密级</option>
        <option v-for="lv in SECURITY_LEVELS" :key="lv" :value="lv">{{ levelLabel(lv) }}</option>
      </select>

      <button class="btn sm" :class="{ primary: query.trash }" @click="toggleTrash">
        {{ query.trash ? '回收站（在看）' : '回收站' }}
      </button>

      <button
        v-if="query.trash && total > 0"
        class="btn sm danger"
        :disabled="purging"
        @click="purgeAll"
      >
        {{ purging ? '清空中…' : '清空回收站' }}
      </button>

      <button v-if="query.keyword || query.folderId || query.securityLevel" class="btn sm" @click="resetFilters">
        清空筛选
      </button>

      <div class="spacer" />
      <span class="tiny num">共 {{ total }} 个文件</span>
    </div>

    <div v-if="loadError" class="alert err" style="margin-bottom: 16px">
      <div>
        <b>加载失败</b>
        <div style="margin-top: 4px">{{ loadError }}</div>
      </div>
    </div>

    <div class="card">
      <!-- 批量操作栏：选中文件后浮现 -->
      <div v-if="!query.trash && selectedIds.size > 0" class="batchbar">
        <span class="tiny">已选 {{ selectedIds.size }} 个文件</span>
        <div class="spacer" />
        <button class="btn sm" @click="openMove()">批量移动</button>
        <button
          v-if="can('file:upload')"
          class="btn sm"
          @click="openIngestDialog({ kind: 'files', items: files.filter((x) => selectedIds.has(x.id)) })"
        >
          批量纳入知识库
        </button>
        <button class="btn sm" @click="clearSelection">取消选择</button>
        <button
          v-if="can('file:delete')"
          class="btn sm danger"
          :disabled="batchDeleting"
          @click="batchDeleteSelected"
        >
          {{ batchDeleting ? '删除中…' : '批量移入回收站' }}
        </button>
      </div>

      <!-- 加载态：骨架屏而不是空白，避免"界面像坏了" -->
      <div v-if="loading" style="padding: 20px; display: flex; flex-direction: column; gap: 14px">
        <div v-for="i in 5" :key="i" class="skel" :style="{ width: `${92 - i * 8}%` }" />
      </div>

      <!-- 空状态：给出方向，而不是只说"暂无数据" -->
      <div v-else-if="files.length === 0" class="empty">
        <template v-if="query.trash">
          <div class="t">回收站是空的</div>
          <div class="d">被删除的文件会先放到这里，确认不需要后再彻底清除。</div>
        </template>
        <template v-else-if="query.keyword || query.folderId || query.securityLevel">
          <div class="t">没有符合条件的文件</div>
          <div class="d">试试换个关键词，或者清空筛选条件看看全部文件。</div>
          <button class="btn sm" style="margin-top: 8px" @click="resetFilters">清空筛选</button>
        </template>
        <template v-else>
          <div class="t">还没有文件</div>
          <div class="d">
            上传公司的制度、材料或模板，之后统一在这里管理。<br>
            上传后可以设置密级，决定哪些同事能看到。
          </div>
          <button v-if="can('file:upload')" class="btn primary sm" style="margin-top: 8px" @click="openUpload()">
            上传第一份文件
          </button>
        </template>
      </div>

      <table v-else class="file-table">
        <thead>
          <tr>
            <th v-if="!query.trash" style="width: 36px; text-align: center">
              <input
                type="checkbox"
                class="ck"
                :checked="allSelected"
                :indeterminate="selectedIds.size > 0 && !allSelected"
                @change="toggleSelectAll"
              />
            </th>
            <th style="width: 32%; cursor: pointer" @click="sortBy('name')">
              名称<span v-if="query.sortBy === 'name'" class="sortm">{{ query.sortOrder === 'asc' ? '↑' : '↓' }}</span>
            </th>
            <th style="width: 120px">知识库状态</th>
            <th style="width: 150px">密级 · 可见范围</th>
            <th style="width: 90px; cursor: pointer" @click="sortBy('size')">
              大小<span v-if="query.sortBy === 'size'" class="sortm">{{ query.sortOrder === 'asc' ? '↑' : '↓' }}</span>
            </th>
            <th style="width: 100px">修改人</th>
            <th style="width: 120px">更新时间</th>
            <th style="width: 150px; text-align: right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in files" :key="f.id">
            <td v-if="!query.trash" style="text-align: center">
              <input
                type="checkbox"
                class="ck"
                :checked="isSelected(f.id)"
                @change="toggleSelect(f.id)"
              />
            </td>
            <td class="fname-cell">
              <div class="fname" @click="openPreview(f)">
                <span class="ext" :style="{ background: extColor(f.extension).bg, color: extColor(f.extension).fg }">
                  {{ f.extension.toUpperCase().slice(0, 4) }}
                </span>
                <span class="tname" :title="f.name">{{ f.name }}</span>
                <span v-if="f.isFavorite" class="star" title="已收藏">★</span>
              </div>
            </td>

            <td class="col-hide-md">
              <span class="badge" :class="indexBadgeClass(f.indexStatus)">
                {{ indexLabel(f.indexStatus) }}
                <template v-if="f.chunkCount">· {{ f.chunkCount }} 片段</template>
              </span>
            </td>

            <td>
              <span class="secret" :style="f.securityLevel === 'private' ? 'color:var(--seal)' : ''">
                <i :style="{ background: levelColor(f.securityLevel) }" />
                {{ levelLabel(f.securityLevel) }} · {{ scopeLabel(f.securityLevel, f.visibleDeptIds, deptName) }}
              </span>
            </td>

            <td class="col-hide-md num">{{ formatBytes(f.size) }}</td>
            <td class="col-hide-md">{{ f.ownerName ?? '—' }}</td>
            <td class="col-hide-sm tiny">{{ formatRelativeTime(f.updatedAt) }}</td>

            <td style="text-align: right; white-space: nowrap" @click.stop>
              <template v-if="query.trash">
                <button class="act" @click="restoreFile(f)">恢复</button>
                <button v-if="can('file:delete')" class="act danger" @click="purgeFile(f)">彻底删除</button>
              </template>
              <template v-else>
                <button class="act" @click="openPreview(f)">打开</button>
                <button v-if="can('file:download')" class="act" @click="download(f)">下载</button>
                <!--
                  「纳入」是「还没真正可用」的文件的关键操作：
                  · not_ingested：从未纳入知识库（用户最常见的情况，文件管理页上传的就这样）
                  · failed：纳入时解析失败（用户的「印章.jpg」现在就是这个状态）
                  这两种都点一下 → 重新跑 ingest 流程。
                -->
                <button
                  v-if="['not_ingested', 'failed'].includes(f.indexStatus) && can('file:upload')"
                  class="act primary"
                  @click="openIngestDialog({ kind: 'files', items: [f] })"
                >
                  纳入
                </button>
                <button class="act icon" title="更多操作" @click="toggleMenu(f.id, $event)">···</button>

                <div v-if="openMenuId === f.id" class="menu" @click.stop>
                  <button class="mi" @click="openDetail(f); closeMenu()">查看详情</button>
                  <button class="mi" @click="openMove(f); closeMenu()">移动到…</button>
                  <button v-if="can('file:upload')" class="mi" @click="openIngestDialog({ kind: 'files', items: [f] })">
                    纳入知识库…
                  </button>
                  <button class="mi" @click="download(f); closeMenu()">下载到本地</button>
                  <button class="mi" @click="toggleFavorite(f)">
                    {{ f.isFavorite ? '取消收藏' : '收藏' }}
                  </button>
                  <button class="mi" @click="openRename(f)">重命名</button>
                  <button v-if="can('file:security:set')" class="mi" @click="openSecurity(f)">
                    密级与可见范围
                  </button>
                  <div class="msep" />
                  <button v-if="can('file:delete')" class="mi danger" @click="removeFile(f)">
                    移入回收站
                  </button>
                </div>
              </template>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="!loading && totalPages > 1" class="pager">
        <button class="btn sm" :disabled="query.page <= 1" @click="changePage(-1)">上一页</button>
        <span class="tiny num">第 {{ query.page }} / {{ totalPages }} 页</span>
        <button class="btn sm" :disabled="query.page >= totalPages" @click="changePage(1)">下一页</button>
      </div>
    </div>

      </div><!-- /files-main -->
    </div><!-- /files-layout -->

    <!-- ═══════════ 移动到文件夹对话框 ═══════════ -->
    <div v-if="moveDialog" class="mask" @click.self="moveDialog = false">
      <div class="modal" style="max-width: 480px">
        <div class="modal-h">
          <h3>
            {{ moveBatchMode ? `移动 ${selectedIds.size} 个文件` : '移动到…' }}
          </h3>
          <button class="x" @click="moveDialog = false">×</button>
        </div>
        <div class="modal-b">
          <div v-if="!moveBatchMode && moveTarget" class="tiny" style="margin-bottom: 14px">
            正在移动：<b>{{ moveTarget.name }}</b>
          </div>
          <div class="field">
            <label>目标文件夹</label>
            <div class="move-target" :class="{ on: moveTargetFolderId == null }" @click="moveTargetFolderId = null">
              <span class="move-ico">📁</span><span>顶层（不挂任何文件夹）</span>
            </div>
            <div v-if="folders.length === 0" class="hint">还没有文件夹，先在上面建一个。</div>
            <div v-else class="move-tree">
              <FolderTreeItem
                v-for="node in folderTree"
                :key="node.id"
                :node="node"
                :depth="0"
                :current="moveTargetFolderId ?? ''"
                :expanded="expandedIds"
                @enter="moveTargetFolderId = $event"
                @toggle="toggleFolder"
                @new-sub="openNewFolder"
                @remove="(p) => removeFolderAsk(p.id, p.name)"
              />
            </div>
          </div>
          <div v-if="moveError" class="alert err" style="margin-top: 12px">{{ moveError }}</div>
        </div>
        <div class="modal-f">
          <span class="tiny">移动后刷新列表查看生效</span>
          <div class="spacer" />
          <button class="btn" @click="moveDialog = false">取消</button>
          <button class="btn primary" :disabled="moveSaving" @click="doMove">
            {{ moveSaving ? '移动中…' : '移动' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════ 上传对话框（多文件 / 文件夹）═══════════ -->
    <div v-if="uploadDialog" class="mask" @click.self="uploadDialog = false">
      <div class="modal" style="max-width: 560px">
        <div class="modal-h">
          <h3>上传文件<template v-if="uploadTarget.name">到「{{ uploadTarget.name }}」</template></h3>
          <button class="x" @click="uploadDialog = false">×</button>
        </div>

        <div class="modal-b">
          <!-- 拖放区：点它选文件；下面两个按钮分别对应「选文件」和「选整个文件夹」 -->
          <div
            class="drop"
            :class="{ over: dragOver }"
            @dragover.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop"
            @click="pickFiles"
          >
            <div class="drop-t">把文件或整个文件夹拖到这里</div>
            <div class="drop-actions">
              <button class="btn sm" type="button" @click.stop="pickFiles">选择文件</button>
              <button class="btn sm" type="button" @click.stop="pickFolder">选择文件夹</button>
            </div>
            <div class="tiny">支持所有类型；可一次多选、选整个文件夹、拖拽目录</div>
            <input ref="fileInput" type="file" multiple style="display: none" @change="onFileInput" />
            <!-- `directory` 是标准属性，`webkitdirectory` 是兼容旧 Chrome/Safari 的别名；同时带上更稳 -->
            <input ref="folderInput" type="file" webkitdirectory directory multiple style="display: none" @change="onFolderInput" />
          </div>

          <!-- 待上传列表 -->
          <div v-if="pendingFiles.length > 0" class="pending">
            <div class="pending-head">
              <span class="tiny">已选 {{ pendingFiles.length }} 个文件</span>
              <span class="spacer" />
              <button class="act" @click="pendingFiles = []">清空</button>
            </div>
            <ul class="pending-list">
              <li v-for="p in pendingFiles" :key="p.key" class="pend-item">
                <span class="pend-ico" :style="{ background: extColor(p.file.name.split('.').pop() ?? '').bg, color: extColor(p.file.name.split('.').pop() ?? '').fg }">
                  {{ (p.file.name.split('.').pop() ?? 'bin').toUpperCase().slice(0, 4) }}
                </span>
                <div class="pend-info">
                  <div class="pend-name" :title="p.file.name">{{ p.file.name }}</div>
                  <div class="tiny">
                    {{ formatBytes(p.file.size) }}
                    <span v-if="dirOf(p.relPath)" class="pend-path"> · {{ dirOf(p.relPath) }}/</span>
                    <span v-else class="pend-path" style="color: var(--wn)"> · 顶层（无层级）</span>
                  </div>
                  <div v-if="p.status === 'fail'" class="pend-err">{{ p.error }}</div>
                </div>
                <span class="pend-state" :class="p.status">
                  <template v-if="p.status === 'ok'">✓</template>
                  <template v-else-if="p.status === 'fail'">✕</template>
                  <template v-else>待传</template>
                </span>
                <button v-if="p.status === 'pending'" class="pend-rm" title="移除" @click="removePending(p.key)">×</button>
              </li>
            </ul>
          </div>

          <div v-if="willBeParseable && pendingFiles.length > 0" class="alert info" style="margin-top: 14px">
            其中有可解析格式（如 PDF / Word / 文本），纳入知识库后即可被智能体引用。
          </div>

          <div v-else-if="showLayerWarning" class="alert warn" style="margin-top: 14px">
            <div>
              <b>未识别到文件夹层级</b> —— 浏览器可能是早期版本或被系统拦截。
              当前 {{ relPathMissing }} 个文件将按顶层上传；如需保留目录，请改用<b>拖拽目录</b>到上方虚线框。
            </div>
          </div>

          <div class="field" style="margin-top: 16px">
            <label>密级与可见范围（对本次上传的所有文件生效）</label>
            <select v-model="uploadLevel">
              <option v-for="lv in SECURITY_LEVELS" :key="lv" :value="lv">{{ levelLabel(lv) }}</option>
            </select>
            <div class="hint">
              <template v-if="uploadLevel === 'public'">全体同事都能看到</template>
              <template v-else-if="uploadLevel === 'internal'">全公司同事都能看到（最常用）</template>
              <template v-else-if="uploadLevel === 'department'">只有你指定的部门能看到</template>
              <template v-else>只有你自己能看到，且不能纳入知识库</template>
            </div>
          </div>

          <div v-if="uploadLevel === 'department'" class="field">
            <label>可见部门（可多选）</label>
            <div class="chips">
              <button
                v-for="(name, id) in deptNames"
                :key="id"
                class="chip"
                :class="{ on: uploadDepts.includes(id) }"
                type="button"
                @click="uploadDepts.includes(id) ? uploadDepts = uploadDepts.filter((x) => x !== id) : uploadDepts.push(id)"
              >
                {{ name }}
              </button>
            </div>
            <div v-if="Object.keys(deptNames).length === 0" class="hint">
              尚未加载到部门列表，请先在数据库初始化部门数据。
            </div>
          </div>

          <div v-if="uploadError" class="alert err" style="margin-top: 12px">{{ uploadError }}</div>
        </div>

        <div class="modal-f">
          <span class="tiny">
            {{ pendingFiles.length ? `共 ${pendingFiles.length} 个文件` : '上传后可在列表中调整密级' }}
          </span>
          <div class="spacer" />
          <button class="btn" @click="uploadDialog = false">取消</button>
          <button
            class="btn primary"
            :disabled="pendingFiles.length === 0 || uploading"
            @click="doUpload"
          >
            {{ uploading ? '正在上传…' : `上传（${pendingFiles.length}）` }}
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════ 新建文件夹对话框 ═══════════ -->
    <div v-if="folderDialog" class="mask" @click.self="folderDialog = false">
      <div class="modal" style="max-width: 420px">
        <div class="modal-h">
          <h3>新建文件夹</h3>
          <button class="x" @click="folderDialog = false">×</button>
        </div>
        <div class="modal-b">
          <div class="field">
            <label>文件夹名称</label>
            <input v-model="newFolderName" placeholder="例如：项目资料" @keyup.enter="doCreateFolder" />
          </div>
          <div class="field" style="margin-top: 14px">
            <label>放在哪个文件夹下</label>
            <select v-model="newFolderParentId" class="sel" style="width: 100%">
              <option :value="null">顶层（不挂靠任何文件夹）</option>
              <option v-for="f in folders" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <div class="hint">可在左侧目录树里点某个文件夹上的「＋」快速在其下新建。</div>
          </div>
          <div v-if="folderError" class="alert err" style="margin-top: 12px">{{ folderError }}</div>
        </div>
        <div class="modal-f">
          <div class="spacer" />
          <button class="btn" @click="folderDialog = false">取消</button>
          <button class="btn primary" :disabled="folderSaving || !newFolderName.trim()" @click="doCreateFolder">
            {{ folderSaving ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════ 内嵌预览（当场查看）═══════════ -->
    <div v-if="preview" class="mask preview-mask" @click.self="closePreview">
      <div class="modal preview-modal">
        <div class="modal-h">
          <h3 class="preview-title">{{ preview.name }}</h3>
          <button class="x" @click="closePreview">×</button>
        </div>
        <div class="preview-body">
          <div v-if="previewLoading" class="preview-hint">正在加载预览…</div>
          <template v-else-if="preview.url">
            <iframe
              v-if="preview.kind === 'pdf'"
              :src="preview.url"
              class="preview-frame"
            />
            <div v-else-if="preview.kind === 'image'" class="preview-center">
              <img :src="preview.url" class="preview-img" :alt="preview.name" />
            </div>
            <video v-else-if="preview.kind === 'video'" :src="preview.url" class="preview-frame" controls />
            <audio v-else-if="preview.kind === 'audio'" :src="preview.url" class="preview-audio" controls />
            <iframe v-else-if="preview.kind === 'text'" :src="preview.url" class="preview-frame" />
          </template>
        </div>
        <div class="modal-f">
          <span class="tiny">预览链接有效期 10 分钟，由后端校验权限后签发</span>
          <div class="spacer" />
          <button class="btn" @click="closePreview">关闭</button>
        </div>
      </div>
    </div>

    <!-- ═══════════ 纳入知识库 ═══════════ -->
    <div v-if="kbDialog" class="mask" @click.self="kbDialog = false">
      <div class="modal" style="max-width: 500px">
        <div class="modal-h">
          <h3>纳入知识库</h3>
          <button class="x" @click="kbDialog = false">×</button>
        </div>
        <div class="modal-b">
          <div class="tiny" style="margin-bottom: 14px">
            <template v-if="kbSource?.kind === 'files'">
              把 <b>{{ kbSource.items.length }}</b> 个文件纳入知识库，并选择存放位置。
            </template>
            <template v-else-if="kbSource?.kind === 'folder'">
              把文件夹 <b>{{ kbSource.name }}</b> 纳入知识库：它的目录层级会一并带过去。
            </template>
            文件的密级与可见范围会一并带入。
          </div>

          <div v-if="kbListLoading" class="tiny">加载知识库…</div>
          <div v-else-if="!kbList.length" class="empty">
            <div class="t">还没有知识库</div>
            <div class="d">先去「知识库」页新建一个。</div>
          </div>
          <template v-else>
            <div class="field">
              <label>目标知识库</label>
              <select v-model="kbTargetId" class="sel" style="width: 100%" @change="loadKbTargetFolders">
                <option value="">请选择</option>
                <option v-for="k in kbList" :key="k.id" :value="k.id">
                  {{ k.name }}{{ k.isTeamSpace ? '（团队空间）' : '' }}
                </option>
              </select>
            </div>
            <div v-if="kbTargetId" class="field">
              <label>存放位置</label>
              <select v-model="kbTargetFolderId" class="sel" style="width: 100%">
                <option :value="null">知识库根目录</option>
                <option v-for="o in kbTargetFolders" :key="o.id" :value="o.id">{{ o.label }}</option>
              </select>
            </div>
          </template>

          <div class="note" style="margin-top: 14px">
            纳入后这些内容的片段就能被智能体检索引用；移出知识库不影响文件本身，仍可在「文件管理」里查看与下载。
          </div>
        </div>
        <div class="modal-f">
          <span class="spacer" />
          <button class="btn" @click="kbDialog = false">取消</button>
          <button class="btn primary" :disabled="!kbTargetId || kbBusy" @click="doIngest">
            {{ kbBusy ? '纳入中…' : '确定纳入' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════ 密级设置对话框 ═══════════ -->
    <div v-if="secDialog" class="mask" @click.self="secDialog = false">
      <div class="modal" style="max-width: 460px">
        <div class="modal-h">
          <h3>密级与可见范围</h3>
          <button class="x" @click="secDialog = false">×</button>
        </div>
        <div class="modal-b">
          <div class="tiny" style="margin-bottom: 14px">{{ secTarget?.name }}</div>

          <div class="field">
            <label>密级</label>
            <select v-model="secLevel">
              <option v-for="lv in SECURITY_LEVELS" :key="lv" :value="lv">{{ levelLabel(lv) }}</option>
            </select>
          </div>

          <div v-if="secLevel === 'department'" class="field">
            <label>可见部门（可多选）</label>
            <div class="chips">
              <button
                v-for="(name, id) in deptNames"
                :key="id"
                class="chip"
                :class="{ on: secDepts.includes(id) }"
                type="button"
                @click="secDepts.includes(id) ? secDepts = secDepts.filter((x) => x !== id) : secDepts.push(id)"
              >
                {{ name }}
              </button>
            </div>
          </div>

          <div class="alert warn" style="margin-top: 12px">
            <div>
              收紧密级会立即生效：<b>无权的人下次检索时不会再召回到这份文件的内容</b>。
              已纳入知识库的切片会同步更新权限标签。
            </div>
          </div>

          <div v-if="secError" class="alert err" style="margin-top: 12px">{{ secError }}</div>
        </div>
        <div class="modal-f">
          <div class="spacer" />
          <button class="btn" @click="secDialog = false">取消</button>
          <button class="btn primary" :disabled="secSaving" @click="saveSecurity">
            {{ secSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════ 重命名对话框 ═══════════ -->
    <div v-if="renameTarget" class="mask" @click.self="renameTarget = null">
      <div class="modal" style="max-width: 420px">
        <div class="modal-h">
          <h3>重命名</h3>
          <button class="x" @click="renameTarget = null">×</button>
        </div>
        <div class="modal-b">
          <div class="field">
            <label>文件名</label>
            <input v-model="renameValue" @keyup.enter="doRename" />
            <div class="hint">保留扩展名，系统靠它判断文件类型。</div>
          </div>
        </div>
        <div class="modal-f">
          <div class="spacer" />
          <button class="btn" @click="renameTarget = null">取消</button>
          <button class="btn primary" @click="doRename">保存</button>
        </div>
      </div>
    </div>

    <!-- ═══════════ 详情抽屉 ═══════════ -->
    <div v-if="detail" class="drawer-mask" @click.self="detail = null">
      <aside class="drawer">
        <div class="drawer-h">
          <h3>文件详情</h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="drawer-b">
          <div class="dname">
            <span class="ext" :style="{ background: extColor(detail.extension).bg, color: extColor(detail.extension).fg }">
              {{ detail.extension.toUpperCase().slice(0, 4) }}
            </span>
            <div class="dname-t">{{ detail.name }}</div>
          </div>

          <dl class="meta">
            <dt>密级与可见范围</dt>
            <dd>
              <span class="secret" :style="detail.securityLevel === 'private' ? 'color:var(--seal)' : ''">
                <i :style="{ background: levelColor(detail.securityLevel) }" />
                {{ levelLabel(detail.securityLevel) }} · {{ scopeLabel(detail.securityLevel, detail.visibleDeptIds, deptName) }}
              </span>
            </dd>

            <dt>知识库状态</dt>
            <dd>
              <span class="badge" :class="indexBadgeClass(detail.indexStatus)">
                {{ indexLabel(detail.indexStatus) }}
                <template v-if="detail.chunkCount">· {{ detail.chunkCount }} 片段</template>
              </span>
            </dd>

            <dt>大小</dt>
            <dd class="num">{{ formatBytes(detail.size) }}</dd>

            <dt>修改人</dt>
            <dd>{{ detail.ownerName ?? '—' }}</dd>

            <dt>最近更新</dt>
            <dd>{{ formatRelativeTime(detail.updatedAt) }}</dd>

            <dt>版本</dt>
            <dd class="num">v{{ detail.version }}</dd>

            <dt v-if="detail.checksum">内容指纹</dt>
            <dd v-if="detail.checksum" class="mono tiny" style="word-break: break-all">
              {{ detail.checksum }}
            </dd>
          </dl>

          <div class="alert info" style="margin-top: 18px">
            下载链接有效期为 10 分钟，由后端在<b>校验权限后</b>签发，文件流不经过应用服务器。
          </div>
        </div>
        <div class="drawer-f">
          <button class="btn" @click="download(detail!)">下载</button>
          <button v-if="can('file:security:set')" class="btn" @click="openSecurity(detail!)">
            改密级
          </button>
        </div>
      </aside>
    </div>

    <!-- ═══════════ 轻提示 ═══════════ -->
    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
/* ───────── 工具栏 ───────── */
.toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-bottom: 16px;
}
.search {
  height: 34px; width: 240px; padding: 0 12px;
  border: 1px solid var(--line); border-radius: var(--r-sm);
  font-size: 13px; font-family: inherit; outline: none;
  background: var(--surface); color: var(--ink);
  transition: border-color var(--t), box-shadow var(--t);
}
.search:focus { border-color: var(--b400); box-shadow: 0 0 0 3px rgba(59,130,246,.14); }
.sel {
  height: 34px; padding: 0 10px; border: 1px solid var(--line);
  border-radius: var(--r-sm); font-size: 13px; font-family: inherit;
  background: var(--surface); color: var(--ink); outline: none; cursor: pointer;
}

/* ───────── 文件名 ───────── */
.fname { display: flex; align-items: center; gap: 10px; cursor: pointer; min-width: 0; }
.fname:hover .tname { color: var(--brand); }
.ext {
  width: 26px; height: 28px; border-radius: var(--r-xs); flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 600;
}
.tname {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: color var(--t);
}
.star { color: var(--wn); font-size: 12px; flex-shrink: 0; }
.sortm { margin-left: 4px; color: var(--brand); }

/* ───────── 行内操作 ───────── */
.act {
  font-size: 12.5px; color: var(--ink-2); background: none; border: none;
  cursor: pointer; padding: 3px 7px; border-radius: var(--r-xs);
  font-family: inherit; transition: all var(--t);
}
.act:hover { background: var(--g100); color: var(--brand); }
.act.icon { font-family: var(--mono); letter-spacing: .5px; }

.menu {
  position: absolute; right: 16px; margin-top: 6px; z-index: 40;
  min-width: 168px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  box-shadow: var(--sh-pop); padding: 5px;
  display: flex; flex-direction: column;
}
.mi {
  text-align: left; padding: 8px 10px; border: none; background: none;
  border-radius: var(--r-xs); font-size: 12.5px; font-family: inherit;
  cursor: pointer; color: var(--ink); transition: background var(--t);
}
.mi:hover { background: var(--g100); }
.mi.danger { color: var(--er-t); }
.mi.danger:hover { background: var(--er-s); }
.msep { height: 1px; background: var(--line-soft); margin: 4px 0; }

/* ───────── 分页 ───────── */
.pager {
  display: flex; align-items: center; justify-content: center; gap: 14px;
  padding: 14px; border-top: 1px solid var(--line-soft);
}

/* ───────── 对话框 ───────── */
.mask {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(16, 24, 40, .45);
  display: flex; align-items: center; justify-content: center; padding: 24px;
  backdrop-filter: blur(2px);
}
.modal {
  width: 100%; max-width: 520px; background: var(--surface);
  border-radius: var(--r-l); box-shadow: var(--sh-pop);
  max-height: 88vh; display: flex; flex-direction: column; overflow: hidden;
}
.modal-h {
  padding: 18px 20px; border-bottom: 1px solid var(--line-soft);
  display: flex; align-items: center;
}
.modal-h h3 { font-size: 15px; font-weight: 600; margin: 0; }
.x {
  margin-left: auto; width: 28px; height: 28px; border: none; background: none;
  font-size: 20px; line-height: 1; color: var(--ink-3); cursor: pointer;
  border-radius: var(--r-xs); transition: all var(--t);
}
.x:hover { background: var(--g100); color: var(--ink); }
.modal-b { padding: 20px; overflow-y: auto; }
.modal-f {
  padding: 14px 20px; border-top: 1px solid var(--line-soft);
  display: flex; align-items: center; gap: 10px;
}

/* ───────── 拖放区 ───────── */
.drop {
  border: 1.5px dashed var(--g300); border-radius: var(--r);
  padding: 30px 20px; text-align: center; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  transition: all var(--t); background: var(--g25);
}
.drop:hover, .drop.over { border-color: var(--b400); background: var(--brand-s); }
.drop.has { padding: 16px; border-style: solid; }
.drop-t { font-size: 14px; font-weight: 500; }
.drop-actions { display: flex; gap: 10px; margin-top: 12px; }
.picked { display: flex; align-items: center; gap: 12px; width: 100%; }
.picked-info { flex: 1; min-width: 0; text-align: left; }
.picked-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ───────── 待上传列表 ───────── */
.pending {
  margin-top: 14px; border: 1px solid var(--line); border-radius: var(--r-sm);
  overflow: hidden; background: var(--surface);
}
.pending-head {
  display: flex; align-items: center; padding: 8px 12px;
  background: var(--g50); border-bottom: 1px solid var(--line-soft);
}
.pending-list { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto; }
.pend-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-bottom: 1px solid var(--line-soft);
}
.pend-item:last-child { border-bottom: none; }
.pend-ico {
  width: 26px; height: 28px; border-radius: var(--r-xs); flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 600;
}
.pend-info { flex: 1; min-width: 0; }
.pend-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pend-path { color: var(--ink-3); }
.pend-err { font-size: 11.5px; color: var(--er-t); margin-top: 2px; }
.pend-state {
  font-size: 11.5px; color: var(--ink-3); flex-shrink: 0; white-space: nowrap;
}
.pend-state.ok { color: var(--ok-t); font-weight: 600; }
.pend-state.fail { color: var(--er-t); font-weight: 600; }
.pend-rm {
  width: 22px; height: 22px; border: none; background: none; flex-shrink: 0;
  font-size: 16px; line-height: 1; color: var(--ink-3); cursor: pointer;
  border-radius: var(--r-xs); transition: all var(--t);
}
.pend-rm:hover { background: var(--g100); color: var(--er-t); }

/* ───────── 部门多选 ───────── */
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  height: 30px; padding: 0 12px; border: 1px solid var(--line);
  border-radius: var(--r-full); background: var(--surface);
  font-size: 12.5px; font-family: inherit; color: var(--ink);
  cursor: pointer; transition: all var(--t);
}
.chip:hover { border-color: var(--brand-line); }
.chip.on { border-color: var(--brand); background: var(--brand-s); color: var(--brand); font-weight: 500; }

/* ───────── 抽屉 ───────── */
.drawer-mask {
  position: fixed; inset: 0; z-index: 110;
  background: rgba(16, 24, 40, .28);
  display: flex; justify-content: flex-end;
}
.drawer {
  width: 440px; max-width: 92vw; background: var(--surface);
  display: flex; flex-direction: column; box-shadow: var(--sh-lg);
  animation: slideIn .22s cubic-bezier(.4, 0, .2, 1);
}
@keyframes slideIn { from { transform: translateX(24px); opacity: .5; } to { transform: none; opacity: 1; } }
.drawer-h {
  padding: 18px 20px; border-bottom: 1px solid var(--line-soft);
  display: flex; align-items: center;
}
.drawer-h h3 { font-size: 15px; font-weight: 600; margin: 0; }
.drawer-b { flex: 1; overflow-y: auto; padding: 20px; }
.drawer-f {
  padding: 14px 20px; border-top: 1px solid var(--line-soft);
  display: flex; gap: 10px;
}
.dname { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.dname .ext { width: 34px; height: 38px; font-size: 10px; }
.dname-t { font-size: 15px; font-weight: 500; word-break: break-all; }

.meta { margin: 0; }
.meta dt {
  font-size: 11.5px; color: var(--ink-3); margin-bottom: 6px;
}
.meta dd { margin: 0 0 18px; font-size: 13px; }
.meta dd:last-child { margin-bottom: 0; }

/* ───────── 轻提示 ───────── */
.toasts {
  position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%);
  z-index: 200; display: flex; flex-direction: column; gap: 8px; align-items: center;
}
.toast {
  padding: 10px 18px; border-radius: var(--r-sm);
  background: var(--g900); color: #fff; font-size: 13px;
  box-shadow: var(--sh-pop); animation: toastIn .2s ease;
}
.toast.err { background: var(--er-t); }
@keyframes toastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* ───────── 两栏布局：目录树 + 文件列表 ───────── */
.files-layout {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.tree-panel {
  width: 232px;
  flex-shrink: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r);
  overflow: hidden; /* 防止 badge / 长名字溢出到主区域 */
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 140px);
  display: flex;
  flex-direction: column;
}
.tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
}
.tree-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-3);
  letter-spacing: .3px;
}
.tree-add {
  width: 22px;
  height: 22px;
  border: none;
  background: var(--g100);
  border-radius: 6px;
  color: var(--ink-2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition: all var(--t);
}
.tree-add:hover { background: var(--brand-s); color: var(--brand); }
.tree-body {
  padding: 8px;
  overflow-y: auto;
}
.tree-root {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--ink-2);
  font-size: 13px;
  transition: background var(--t), color var(--t);
  margin-bottom: 2px;
}
.tree-root:hover { background: var(--g100); color: var(--ink); }
.tree-root.on { background: var(--brand-s); color: var(--brand); font-weight: 500; }
.tree-root .tree-ico { font-size: 13px; flex-shrink: 0; }
.tree-root .tree-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-empty {
  padding: 16px 8px;
  font-size: 12px;
  color: var(--ink-3);
  text-align: center;
}
.files-main { flex: 1; min-width: 0; }

/* ───────── 面包屑 ───────── */
.crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  font-size: 13px;
}
.crumb-item {
  border: none;
  background: none;
  color: var(--ink-2);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  padding: 2px 4px;
  border-radius: 4px;
  transition: color var(--t), background var(--t);
}
.crumb-item:hover { color: var(--brand); background: var(--g100); }
.crumb-item.cur { color: var(--ink); font-weight: 600; }
.crumb-sep { color: var(--ink-3); }

/* ───────── 批量操作栏 ───────── */
.batchbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--brand-s);
}
.ck {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--brand);
}

/* ───────── 内嵌预览 ───────── */
.preview-mask { z-index: 120; }
.preview-modal {
  max-width: 900px;
  width: 90vw;
  height: 82vh;
}
.preview-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 12px;
}
.preview-body {
  flex: 1;
  min-height: 0;
  background: #f8fafc;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
}
.preview-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.preview-center {
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: var(--sh-pop);
}
.preview-audio { width: 100%; padding: 20px; }
.preview-hint {
  color: var(--ink-3);
  font-size: 14px;
}

/* ───────── 文件表格列宽修复 ───────── */
.card {
  overflow-x: auto; /* 窄屏时表格横向滚动而不是挤压列 */
}
.file-table {
  width: 100%;
  table-layout: fixed; /* 每列按显式 width 固定，不会被内容挤变形 */
  min-width: 860px;
}
.file-table th,
.file-table td {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-table td.fname-cell {
  white-space: normal;
}
.file-table td.fname-cell .tname {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-all;
}

/* ───────── 行内 act 按钮的「危险」变体 ───────── */
.act.danger { color: var(--er-t); }
.act.danger:hover { background: var(--er-s); }
/* 「纳入」按钮：not_ingested 行的关键操作，要比 ··· 更显眼 */
.act.primary { color: var(--brand); font-weight: 500; }
.act.primary:hover { background: var(--brand-s); color: var(--brand); }

/* ───────── 移动对话框里的「顶层 / 树」区域 ───────── */
.move-target {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  margin-bottom: 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--ink-2);
  font-size: 13px;
  transition: background var(--t), color var(--t);
}
.move-target:hover { background: var(--g100); color: var(--ink); }
.move-target.on { background: var(--brand-s); color: var(--brand); font-weight: 500; }
.move-target .move-ico { font-size: 13px; }
.move-tree {
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
  background: var(--g25);
}
</style>
