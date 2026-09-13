import type { DocumentParser, ParsedBlock, ParsedDocument } from '@kh/shared';
import { PDFParse } from 'pdf-parse';

/**
 * 一页里至少要有这么多个实义字符（去掉标点与空白后）才算「有文字层」。
 * 取 8：一页公文、表格里任何一句有效内容都远超它，而扫描件解析出来只剩
 * 页码、表格线这类噪声，凑不满。
 */
const MIN_MEANINGFUL_CHARS = 8;

/**
 * PDF 解析器（基于 pdf-parse 2.x 的 PDFParse 类）。
 *
 * 这里刻意不用 result.text：它会把「-- 1 of 9 --」这类分页标记也拼进来，
 * 于是**扫描件也会「解析出内容」**——4.7MB 的营业执照只得到一串页码，
 * 却被标记成「已索引」，检索永远搜不到，问题还被状态掩盖了。
 *
 * 改为只保留真正解析出文字的页；无文字层的文件返回空内容，
 * 由上层标成 no_text 并提示需要 OCR。
 */
export class PdfParser implements DocumentParser {
  readonly extensions = ['pdf'];

  async parse(input: { fileName: string; bytes: Uint8Array }): Promise<ParsedDocument> {
    const pdf = new PDFParse({ data: input.bytes });
    try {
      const result = await pdf.getText();
      const pages = result.pages.map((p) => ({ page: p.num, text: p.text.trim() })).filter((p) => isMeaningful(p.text));

      const blocks: ParsedBlock[] = pages.map((p) => ({
        content: p.text,
        page: p.page,
      }));
      return {
        title: stripExt(input.fileName),
        blocks,
        text: pages.map((p) => p.text).join('\n\n'),
      };
    } finally {
      await pdf.destroy().catch(() => undefined);
    }
  }
}

/**
 * 是否真的解析出了文字。
 * 不能只判长度：扫描件的输出不是空串，而是分页标记与空白。
 */
function isMeaningful(text: string): boolean {
  const stripped = text.replace(/^--\s*\d+\s*of\s*\d+\s*--$/gm, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length >= MIN_MEANINGFUL_CHARS;
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}
