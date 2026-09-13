/**
 * 纯函数工具：无副作用、无 Node 专属依赖，前后端都能用。
 */

import type { KbFolder, KbTreeFile } from '../types/index.ts';

/**
 * 生成对象存储的 key —— 全系统唯一出口。
 * 铁律：数据库只存这个 key，代码里绝不出现本地绝对路径，也绝不存完整 URL。
 * 形如：finance/2026/09/8f3a2b1c-....pdf
 */
export function buildStorageKey(params: {
  departmentId?: string | null;
  date?: Date;
  fileId: string;
  extension: string;
  prefix?: string;
}): string {
  const { departmentId, fileId, extension, prefix } = params;
  const d = params.date ?? new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const dept = sanitizeSegment(departmentId || 'shared');
  const ext = extension.replace(/^\./, '').toLowerCase();
  const segments = [prefix, dept, String(year), month, `${fileId}.${ext}`].filter(Boolean);
  return segments.join('/');
}

/** 清理路径片段，防止出现 ../ 之类的越权 key */
export function sanitizeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'shared';
}

/** 从文件名取扩展名（小写、不含点） */
export function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0 || idx === fileName.length - 1) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

/** 去掉扩展名 */
export function getBaseName(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

/** 人类可读的字节数 */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : fractionDigits)} ${units[i]}`;
}

/** 相对时间（3 小时前 / 昨天 / 2026-08-01） */
export function formatRelativeTime(input: string | Date, now: Date = new Date()): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '-';
  const diff = now.getTime() - d.getTime();
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(d);
}

export function formatDate(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '-';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatDateTime(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '-';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)} ${hh}:${mm}`;
}

/** 取姓名首字做头像文字 */
export function avatarText(name: string): string {
  if (!name) return '?';
  return name.trim().slice(0, 1);
}

/** 截断长文本用于列表展示 */
export function truncate(text: string, max = 60): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/* ───────── 知识库目录树 ───────── */

/** 目录树节点：文件夹或文件，children 由 buildKbTree 组装 */
export interface KbTreeNode {
  kind: 'folder' | 'file';
  id: string;
  name: string;
  /** 文件夹：含全部后代的文件数 */
  fileCount?: number;
  /** 文件：原始数据，供右侧预览与操作使用 */
  file?: KbTreeFile;
  children: KbTreeNode[];
}

/**
 * 把扁平的知识库 folders + files 组装成嵌套目录树。
 * 排序规则：同级内文件夹在前、文件在后，各自保持传入顺序。
 */
export function buildKbTree(folders: KbFolder[], files: KbTreeFile[]): KbTreeNode[] {
  const folderNodes = new Map<string, KbTreeNode>();
  for (const f of folders) {
    folderNodes.set(f.id, {
      kind: 'folder',
      id: f.id,
      name: f.name,
      fileCount: f.fileCount,
      children: [],
    });
  }

  const roots: KbTreeNode[] = [];
  for (const f of folders) {
    const node = folderNodes.get(f.id)!;
    const parent = f.parentId ? folderNodes.get(f.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  for (const file of files) {
    const parent = file.kbFolderId ? folderNodes.get(file.kbFolderId) : undefined;
    (parent ? parent.children : roots).push({
      kind: 'file',
      id: file.id,
      name: file.name,
      file,
      children: [],
    });
  }

  const foldersFirst = (nodes: KbTreeNode[]) => [...nodes].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1));
  const sortDeep = (nodes: KbTreeNode[]): KbTreeNode[] => foldersFirst(nodes).map((n) => ({ ...n, children: sortDeep(n.children) }));
  return sortDeep(roots);
}

/** 从根到指定节点的祖先路径（不含自身）；找不到返回 null */
export function kbTreePath(nodes: KbTreeNode[], targetId: string): KbTreeNode[] | null {
  for (const node of nodes) {
    if (node.id === targetId) return [];
    const sub = kbTreePath(node.children, targetId);
    if (sub) return [node, ...sub];
  }
  return null;
}

/* ───────── 回答与追问建议的拆分 ───────── */

/**
 * 追问建议的标记。
 * 要求模型在正文之后用它分隔出 2-3 条后续问题，服务端据此把两部分拆开：
 * 正文进消息体，追问进 followUps（前端渲染成可点击的 chips）。
 */
export const FOLLOW_UP_MARK = '---追问---';

/** 从模型的完整输出里拆出正文与追问建议（非流式与落库场景复用） */
export function splitFollowUps(full: string): {
  content: string;
  followUps: string[];
} {
  const idx = full.indexOf(FOLLOW_UP_MARK);
  if (idx < 0) return { content: full.trim(), followUps: [] };

  const followUps = full
    .slice(idx + FOLLOW_UP_MARK.length)
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);

  return { content: full.slice(0, idx).trim(), followUps };
}

/* ───────── 查询关键词提取 ───────── */

/** 常见虚词：包含它们的片段不作为关键词（避免「了怎」「怎么」这类噪声） */
const STOP_CHARS = new Set(
  '的了是在和与及或有都不也很太会能可对于我你他它这那些个之其而但就请问吗呢吧啊呀哦把被让从到向跟同以为所使需要想应该怎么什哪些如何',
);

/**
 * 从自然语言查询里提取检索关键词。
 *
 * 为什么要做这一步：中文查询没有空格分隔，如果直接拿整句去做子串匹配，
 * 「住宿超标了怎么办」在文档里永远匹配不到；拆成「住宿」「超标」后就能命中。
 * 长词会额外切出 2~4 字的片段，短词保留自身并补 2-gram。
 */
export function extractKeywords(text: string, max = 16): string[] {
  const cleaned = text.replace(/[，。！？、；：“”‘’（）《》【】,.!?;:()[\]{}<>/\\|~`@#$%^&*+=_"'-]+/g, ' ');
  const out = new Set<string>();

  for (const raw of cleaned.split(/\s+/)) {
    const token = raw.trim();
    if (token.length < 2) continue;

    if (token.length <= 6 && !containsStopChar(token)) out.add(token);

    const maxGram = Math.min(4, token.length);
    for (let n = 2; n <= maxGram; n++) {
      for (let i = 0; i + n <= token.length; i++) {
        const gram = token.slice(i, i + n);
        if (!containsStopChar(gram)) out.add(gram);
        if (out.size >= max) return [...out];
      }
    }
    if (out.size >= max) break;
  }

  return [...out].slice(0, max);
}

function containsStopChar(s: string): boolean {
  for (const ch of s) if (STOP_CHARS.has(ch)) return true;
  return false;
}

/* ───────── 邮件草稿解析 ───────── */

/** 邮件草稿的代码块标记：智能体被要求用它输出结构化邮件内容 */
const MAIL_FENCE_LANGS = ['email', 'mail'];

export interface ParsedMailDraft {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

/**
 * 从回答里取出邮件草稿并剥离该代码块。
 *
 * 模型被要求用 ```email {...json...}``` 输出待发邮件。
 * 流式场景下调用方会先把这一块拦在外面，这里是给非流式与落库复用的兜底解析。
 * 解析失败返回 draft=null 且原文不动 —— 宁可让用户看到 JSON，也不要吞掉回答。
 */
export function extractMailDraft(text: string): {
  clean: string;
  draft: ParsedMailDraft | null;
} {
  for (const lang of MAIL_FENCE_LANGS) {
    const fence = '```' + lang;
    const start = text.indexOf(fence);
    if (start < 0) continue;

    const bodyStart = start + fence.length;
    const end = text.indexOf('```', bodyStart);
    if (end < 0) continue;

    const raw = text.slice(bodyStart, end).trim();
    const parsed = parseMailBody(raw);
    if (!parsed) continue;

    const clean = (text.slice(0, start) + text.slice(end + 3)).trim();
    return { clean, draft: parsed };
  }
  return { clean: text.trim(), draft: null };
}

/**
 * 解析 email 代码块的内容。支持两种写法：
 *
 * 1. 字段行格式（推荐）：收件人 / 抄送 / 主题 各一行，`---` 之后是正文。
 *    实测模型对这种格式的遵守度明显更高 —— 让它往 JSON 字符串里写正文时，
 *    它会把 markdown 标记一起写进字段值（subject 变成「```email」这种）。
 * 2. JSON 格式：保留兼容，早期提示词用过。
 */
function parseMailBody(raw: string): ParsedMailDraft | null {
  return parseMailJson(raw) ?? parseMailFields(raw);
}

function parseMailFields(raw: string): ParsedMailDraft | null {
  const pick = (re: RegExp) => (raw.match(re)?.[1] ?? '').trim();
  const subject = pick(/主题[：:]\s*(.+)/);

  // 正文取分隔线之后的部分；没有分隔线时，取「主题」行之后的全部内容
  const sepMatch = raw.match(/^\s*-{3,}\s*$/m);
  const body = (
    sepMatch && sepMatch.index !== undefined
      ? raw.slice(sepMatch.index + sepMatch[0].length)
      : raw.replace(/^[\s\S]*?主题[：:].*$/m, '')
  ).trim();

  if (!subject || !body) return null;

  return {
    to: normalizeAddresses(pick(/收件人[：:]\s*(.*)/)),
    cc: normalizeAddresses(pick(/抄送[：:]\s*(.*)/)),
    subject,
    body,
  };
}

/** 字段值里混进 markdown 标记或说明文字时，这封草稿不可用（宁可让兜底接手） */
function looksLikeNoise(value: string): boolean {
  return /```|^\s*(说明|注意|要求)[：:]/.test(value);
}

function parseMailJson(raw: string): ParsedMailDraft | null {
  // 容错：模型偶尔会带注释或尾逗号
  const cleaned = raw
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // 模型经常把真实换行直接写进 JSON 字符串（JSON 规范要求写成 \n），
    // 这是最常见的解析失败原因，先做一次转义修复再试
    try {
      obj = JSON.parse(repairRawNewlines(cleaned)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const to = normalizeAddresses(obj.to);
  const subject = typeof obj.subject === 'string' ? obj.subject : '';
  const body = typeof obj.body === 'string' ? obj.body : '';
  // 主题和正文是必须的；收件人允许为空 —— 用户常说「发给财务张敏」而不给邮箱，
  // 这时照样落草稿，让他到界面上补收件人，比整封邮件丢掉有用。
  if (!subject && !body) return null;
  // 模型有时把代码块标记或说明文字写进字段值，这种草稿不能直接用
  if (looksLikeNoise(subject) || looksLikeNoise(body)) return null;

  return { to, cc: normalizeAddresses(obj.cc), subject, body };
}

/**
 * 修复 JSON 字符串里的裸换行/回车：把它们转义成 \n。
 * 逐字符扫描并跟踪「是否在字符串内」，避免误改结构性的换行。
 */
function repairRawNewlines(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && (ch === '\n' || ch === '\r')) {
      out += '\\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function normalizeAddresses(value: unknown): string[] {
  if (typeof value === 'string')
    return value
      .split(/[,;，；]/)
      .map((s) => s.trim())
      .filter(Boolean);
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return [];
}

/**
 * 兜底解析：智能体没按格式输出 ```email 块时，从正文里尽力拼一封草稿。
 *
 * 实测九天 75B 对「必须输出 JSON 块」这类格式要求服从度一般，
 * 会老老实实写一封漂亮的邮件正文却不给结构。与其让用户拿不到草稿卡片，
 * 不如把正文当邮件内容、主题从正文里找，收件人识别不到就留空让用户补。
 */
export function fallbackMailDraft(text: string): ParsedMailDraft | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const strip = (s: string | undefined) =>
    (s ?? '')
      .replace(/^[*#\-\s]+/, '')
      .replace(/[*#`]+$/, '')
      .trim();

  // 主题行常带 markdown 修饰（**主题：** xxx），匹配前先容忍前导符号
  const SUBJ = /^[*#\s]*?(主题|标题|邮件主题|subject)[：:]\s*/i;
  const subjLine = lines.find((l) => SUBJ.test(l));

  // 没有主题行时不要拿「张敏，您好。」当主题：优先挑一句短的、非称呼的行作为事由
  const greeting = /[，,]?\s*(您好|你好|见信好)/;
  const shortLine = lines.find((l) => !greeting.test(l) && !/^---+$/.test(l) && strip(l).length >= 4 && strip(l).length <= 24);
  const subject = strip(subjLine ? subjLine.replace(SUBJ, '') : (shortLine ?? lines.find((l) => !greeting.test(l)) ?? lines[0]));
  if (!subject) return null;

  // 收件人：优先邮箱；其次「张敏」这类人名只能留空由用户补
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  const to = email ? [email[0]] : [];

  // 正文去掉标题行与分隔线，保留可读内容
  const body = lines
    .filter((l) => l !== subjLine)
    .map((l) => l.replace(/^---+$/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!body) return null;

  return { to, cc: [], subject, body };
}

/* ───────── cron 表达式（5 段）───────── */

/**
 * 判断某个时间点是否匹配 cron 字段。
 * 支持通配、单值、列表（1,3,5）、范围（1-5）、步长（斜杠写法，如每 15 分钟）。
 */
function matchCronField(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step <= 0) continue;

    let from = min;
    let to = max;
    if (range && range !== '*') {
      const [a, b] = range.split('-');
      from = Number(a);
      to = b === undefined ? Number(a) : Number(b);
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

    if (value >= from && value <= to && (value - from) % step === 0) return true;
  }
  return false;
}

/** 格式校验：5 段、字符集合法，且每段至少能匹配到一个值 */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  return parts.every((p, i) => {
    if (!/^[\d*,\-/]+$/.test(p)) return false;
    const [min, max] = ranges[i]!;
    for (let v = min; v <= max; v++) if (matchCronField(p, v, min, max)) return true;
    return false;
  });
}

/**
 * 计算下一次执行时间。
 *
 * 逐分钟向后找，但做了两级跳跃（小时不匹配就跳下一小时、当天不匹配就跳次日），
 * 所以不会真的扫几十万次。跳过周末在这里一起做掉 —— 节假日日历属于部署侧数据，
 * 放在这里会让共用工具带上环境依赖。
 */
export function nextCronRun(expr: string, from: Date = new Date(), skipWeekend = true): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];

  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (cursor < limit) {
    const dow = cursor.getDay();
    if (skipWeekend && (dow === 0 || dow === 6)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchCronField(monF, cursor.getMonth() + 1, 1, 12)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchCronField(domF, cursor.getDate(), 1, 31) || !matchCronField(dowF, dow, 0, 6)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchCronField(hourF, cursor.getHours(), 0, 23)) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!matchCronField(minF, cursor.getMinutes(), 0, 59)) {
      cursor.setMinutes(cursor.getMinutes() + 1);
      continue;
    }
    return new Date(cursor);
  }
  return null;
}
