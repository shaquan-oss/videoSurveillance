import type { DocumentParser } from '@kh/shared';
import { CompositeDocumentParser } from './document-parser.ts';
import { DocxParser } from './docx-parser.ts';
import { PdfParser } from './pdf-parser.ts';
import { TextParser } from './text-parser.ts';
import { XlsxParser } from './xlsx-parser.ts';

export type { Chunk, ChunkOptions } from './chunker.ts';
export { chunkDocument } from './chunker.ts';
export { CompositeDocumentParser };

let parser: DocumentParser | null = null;

/** 单例解析器（无状态，服务内复用同一个实例） */
export function getDocumentParser(): DocumentParser {
  if (!parser) parser = createDocumentParser();
  return parser;
}

/** 装配默认解析器。换解析库时只改这里。 */
export function createDocumentParser(): DocumentParser {
  return new CompositeDocumentParser([new PdfParser(), new DocxParser(), new XlsxParser(), new TextParser()]);
}
