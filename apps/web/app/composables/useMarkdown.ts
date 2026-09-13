import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import MarkdownIt from 'markdown-it';

/**
 * 回答内容的 Markdown 渲染。
 *
 * 三个要点：
 * 1. `html: false` —— 模型输出属于不可信内容，直接 v-html 有 XSS 风险。
 *    关掉原始 HTML 后，模型写的任何标签都会被转义成文本显示。
 * 2. 代码高亮按需注册语言（highlight.js 全量包很大，只引常用的十来个）。
 * 3. 流式输出时 Markdown 往往是「写到一半」的（``` 只有开头没有结尾），
 *    这里做容错补齐，避免代码块在生成过程中来回跳变。
 */

for (const [name, lang] of Object.entries({
  bash,
  css,
  go,
  java,
  javascript,
  json,
  python,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, lang);
}
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], {
  languageName: 'javascript',
});
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], {
  languageName: 'bash',
});
hljs.registerAliases(['html', 'vue', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

const md = new MarkdownIt({
  html: false,
  linkify: true,
  // 模型经常用单个换行分行，按 Markdown 标准那会被合并成一行
  breaks: true,
  highlight,
});

/**
 * 引用标记在渲染前先换成占位符，渲染后再变回标签，避免与 Markdown 语法打架。
 * 占位符用 Unicode 私有区字符：Markdown 的 HTML 转义只处理 & < > "，
 * 私有区字符会原样穿过渲染管线（一开始用 \u0000 就被转义成了替换字符）。
 */
const CITE_OPEN = '\uE000';
const CITE_CLOSE = '\uE001';
const CITE_PLACEHOLDER = /\uE000CITE(\d+)\uE001/g;
const CITE_PATTERN = /\[(\d+)\]/g;

function balanceFences(text: string): string {
  const fences = text.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

function highlight(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // 高亮失败就退回纯文本，不影响阅读
    }
  }
  return md.utils.escapeHtml(code);
}

export function renderMarkdown(text: string): string {
  if (!text) return '';

  const html = md.render(balanceFences(text).replace(CITE_PATTERN, `${CITE_OPEN}CITE$1${CITE_CLOSE}`));
  return html.replace(CITE_PLACEHOLDER, '<span class="cite-mark">[$1]</span>');
}

export function useMarkdown() {
  return { renderMarkdown };
}
