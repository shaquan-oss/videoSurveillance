import type { DocumentParser, ParsedBlock, ParsedDocument } from '@kh/shared';
import { decodeTextBytes } from './text-encoding.ts';

/**
 * 表格解析器（基于 xlsx / SheetJS）。
 * 把每个 sheet 转成「表头 + 制表符分隔的行」，便于检索与切片。
 */
export class XlsxParser implements DocumentParser {
  readonly extensions = ['xlsx', 'xls', 'csv'];

  async parse(input: { fileName: string; bytes: Uint8Array }): Promise<ParsedDocument> {
    const XLSX = await import('xlsx');
    // CSV 是纯文本，不能把字节直接丢给 SheetJS —— 它按 cp1252 解释字节，
    // 中文会整篇变成乱码（实测「维尔人体」→ ç»´å°\u0094äººä½\u0093），而且是静默坏掉。
    // 所以先自己解码成字符串，再以 type:'string' 传入。
    const workbook = isCsv(input.fileName)
      ? XLSX.read(decodeTextBytes(input.bytes), { type: 'string' })
      : XLSX.read(input.bytes, { type: 'array' });
    const blocks: ParsedBlock[] = [];
    let fullText = '';

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]!;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: '',
      });
      const text = rows
        .map((row) => row.map((cell) => String(cell ?? '').trim()).join('\t'))
        .filter((line) => line.trim())
        .join('\n');
      if (!text) continue;
      blocks.push({ heading: sheetName, content: text });
      fullText += `【${sheetName}】\n${text}\n\n`;
    }

    return { title: stripExt(input.fileName), blocks, text: fullText.trim() };
  }
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

function isCsv(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.csv');
}
