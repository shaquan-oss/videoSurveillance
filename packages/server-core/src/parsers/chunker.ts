import type { ParsedDocument } from '@kh/shared';

/**
 * 文本切片器 —— 把解析后的文档切成可供向量化与检索的片段。
 *
 * 策略（简单、可控、可单测）：
 * 1. 优先按解析器给的结构化块切（保留标题与页码，检索时能回链到原文位置）；
 * 2. 单个块超长时，按「固定窗口 + 重叠」二次切分，避免一条切片塞进半篇文档；
 * 3. 空白块直接丢弃，避免浪费向量配额。
 */

export interface Chunk {
  content: string;
  /** 该切片所属的段落标题（可为空） */
  heading?: string;
  page?: number | null;
}

export interface ChunkOptions {
  /** 单条切片的最大字符数（超出则二次切分） */
  maxChars?: number;
  /** 二次切分时相邻窗口的重叠字符数 */
  overlap?: number;
}

const DEFAULT_MAX_CHARS = 800;
const DEFAULT_OVERLAP = 120;

export function chunkDocument(doc: ParsedDocument, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = Math.min(options.overlap ?? DEFAULT_OVERLAP, maxChars - 1);

  const chunks: Chunk[] = [];
  for (const block of doc.blocks) {
    const text = block.content.trim();
    if (!text) continue;
    // 标题作为整段的前缀拼进切片，保证检索时「问 XX 标题下的内容」能命中
    const full = block.heading ? `${block.heading}\n${text}` : text;

    if (full.length <= maxChars) {
      chunks.push({
        content: full,
        heading: block.heading,
        page: block.page ?? null,
      });
      continue;
    }
    chunks.push(...splitLong(full, block.heading, block.page ?? null, maxChars, overlap));
  }

  // 解析器没产出块（例如纯 txt）时，退化为按全文窗口切
  if (chunks.length === 0 && doc.text.trim()) {
    chunks.push(...splitLong(doc.text.trim(), undefined, null, maxChars, overlap));
  }
  return chunks;
}

/** 把一段超长文本按「窗口 + 重叠」切成多条，尽量在句号/换行处断开 */
function splitLong(text: string, heading: string | undefined, page: number | null, maxChars: number, overlap: number): Chunk[] {
  const out: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    // 还有剩余时，回退到最近的句子边界，避免把一句话从中间劈开
    if (end < text.length) {
      const cut = lastBreak(text, start, end);
      if (cut > start) end = cut;
    }
    out.push({ content: text.slice(start, end).trim(), heading, page });
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

/** 在 [from, to] 区间内找最后一个句号/换行/分号，找不到返回 0 */
function lastBreak(text: string, from: number, to: number): number {
  for (let i = to; i > from; i--) {
    const c = text[i];
    if (c === '\n' || c === '。' || c === '！' || c === '？' || c === '；' || c === '.') return i + 1;
  }
  return 0;
}
