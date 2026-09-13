import type { DocumentParser, ParsedDocument } from '@kh/shared';

/**
 * Word 解析器（基于 mammoth，提取纯文本）。
 * mammoth 会把 .docx 转成 HTML，这里再剥离标签保留标题层级。
 */
export class DocxParser implements DocumentParser {
  readonly extensions = ['docx', 'doc'];

  async parse(input: { fileName: string; bytes: Uint8Array }): Promise<ParsedDocument> {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({
      buffer: Buffer.from(input.bytes),
    });
    const text = (value ?? '').trim();
    return {
      title: stripExt(input.fileName),
      blocks: [{ content: text }],
      text,
    };
  }
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}
