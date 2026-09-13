import type { DocumentParser, ParsedDocument, ParseInput } from '@kh/shared';
import { DocxParser } from './docx-parser.ts';
import { PdfParser } from './pdf-parser.ts';
import { TextParser } from './text-parser.ts';
import { XlsxParser } from './xlsx-parser.ts';

/**
 * 组合解析器：按扩展名把文件分发到对应实现。
 * 上层只用这一个入口，加新格式 = 加一个实现 + 注册进来，别无改动。
 */
export class CompositeDocumentParser implements DocumentParser {
  private readonly map = new Map<string, DocumentParser>();

  constructor(parsers: DocumentParser[]) {
    for (const parser of parsers) {
      for (const ext of parser.extensions) this.map.set(ext.toLowerCase(), parser);
    }
  }

  get extensions(): string[] {
    return [...this.map.keys()];
  }

  supports(extension: string): boolean {
    return this.map.has(extension.toLowerCase());
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const ext = extensionOf(input.fileName);
    const parser = this.map.get(ext);
    if (!parser) throw new Error(`不支持的文档格式：${ext || '未知'}`);
    return parser.parse(input);
  }
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
