import type { DocumentParser, ParsedBlock, ParsedDocument } from '@kh/shared';
import { decodeTextBytes } from './text-encoding.ts';

/**
 * 纯文本类解析器：md / txt。
 * md 会按 # 标题切块，保留标题层级；txt 作为单一块返回。
 * （csv 走表格解析器，见 xlsx-parser.ts）
 */
export class TextParser implements DocumentParser {
  readonly extensions = ['md', 'txt'];

  async parse(input: { fileName: string; bytes: Uint8Array }): Promise<ParsedDocument> {
    const text = decodeTextBytes(input.bytes);
    const title = stripExt(input.fileName);
    const blocks = input.fileName.toLowerCase().endsWith('.md') ? markdownBlocks(text) : [singleBlock(text)];
    return { title, blocks, text };
  }
}

function singleBlock(text: string): ParsedBlock {
  return { content: text };
}

/** 把 markdown 按标题切块，标题作为 heading，正文作为 content */
function markdownBlocks(md: string): ParsedBlock[] {
  const lines = md.split(/\r?\n/);
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      if (current) blocks.push(current);
      current = { heading: match[2]!.trim(), content: '' };
    } else if (current) {
      current.content += `${line}\n`;
    } else {
      current = { content: `${line}\n` };
    }
  }
  if (current) blocks.push(current);
  // 丢弃只有标题没有正文的块（如文档首行的 # 大标题），它们对检索和预览都没有信息量
  const withContent = blocks.filter((b) => b.content.trim());
  return withContent.length ? withContent : [singleBlock(md)];
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}
