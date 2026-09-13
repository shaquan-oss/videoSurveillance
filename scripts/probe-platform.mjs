#!/usr/bin/env node
/**
 * 聚智平台连通性探测脚本。
 *
 * 为什么独立写：诊断「签名对不对 / assistantCode 是不是有效 / libId 我能不能上传」，
 * 这些事不该等到跑 smoke 才发现。脚本自己用 Node 原生 crypto 重实现签名，
 * 不依赖 server-core 的构建产物，单文件可读。
 *
 * 用法：
 *   node scripts/probe-platform.mjs chat        # 只测智能体对话
 *   node scripts/probe-platform.mjs upload      # 只测文档上传
 *   node scripts/probe-platform.mjs             # 两个都跑
 *
 * 环境变量（必须都设，缺一个直接退出）：
 *   PLATFORM_HOST          例：10.0.0.1:30000（带端口）
 *   PLATFORM_APP_ID        应用 id
 *   PLATFORM_APP_SECRET    应用密钥
 *   PLATFORM_ASSISTANT_CODE 智能体 code（chat 模式用）
 *   PLATFORM_LIB_ID        平台知识库 id（upload 模式用）
 *   PLATFORM_CATEGORY_ID   平台知识库分类 id（upload 模式用）
 *
 * 可选：
 *   PLATFORM_PROBE_TEXT    自定义问候语，默认 "你好"
 *   PLATFORM_PROBE_FILE    自定义上传文件名，默认 "probe-<ts>.txt"
 */

import { createHmac, randomUUID } from 'node:crypto';

const HOST = process.env.PLATFORM_HOST;
const APP_ID = process.env.PLATFORM_APP_ID;
const APP_SECRET = process.env.PLATFORM_APP_SECRET;
const ASSISTANT_CODE = process.env.PLATFORM_ASSISTANT_CODE;
const LIB_ID = process.env.PLATFORM_LIB_ID;
const CATEGORY_ID = process.env.PLATFORM_CATEGORY_ID;

const MODE = (process.argv[2] ?? 'both').toLowerCase();

/* ─────────── 工具 ─────────── */

function need(name, value) {
  if (!value) {
    console.error(`\x1b[31m缺少环境变量 ${name}\x1b[0m`);
    process.exit(2);
  }
  return value;
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function buildBearerAuth({ host, method, path, appId, appSecret, extra }) {
  const hostOnly = host.split(':')[0];
  const date = new Date().toUTCString();
  const requestLine = `${method} ${path} HTTP/1.1`;
  const traceId = randomUUID();

  const signingString = `host: ${hostOnly}\ndate: ${date}\n${requestLine}`;
  const signature = createHmac('sha256', appSecret).update(signingString).digest('base64');

  const pairs = [
    `hmac api_key="${appId}"`,
    `algorithm="hmac-sha256"`,
    `headers="host date request-line"`,
    `signature="${signature}"`,
    ...Object.entries(extra ?? {}).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`),
    `traceId="${traceId}"`,
    `host="${hostOnly}"`,
    `date="${date}"`,
    `request-line="${requestLine}"`,
  ];
  return `Bearer ${Buffer.from(pairs.join(', '), 'utf8').toString('base64')}`;
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function dump(prefix, obj) {
  if (obj === undefined) return;
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  console.log(`${C.dim(prefix)}${C.dim(text.length > 800 ? text.slice(0, 800) + '…[truncated]' : text)}`);
}

/* ─────────── chat 探测 ─────────── */

async function probeChat() {
  console.log(`\n${C.bold(C.cyan('━━━ chat 探测'))}  host=${HOST}  assistantCode=${ASSISTANT_CODE}`);

  const path = `/openapi/flames/api/v1/chat?assistantCode=${encodeURIComponent(ASSISTANT_CODE)}`;
  const url = `http://${HOST}${path}`;
  const text = process.env.PLATFORM_PROBE_TEXT ?? '你好';

  const headers = {
    Authorization: buildBearerAuth({
      host: HOST,
      method: 'POST',
      path,
      appId: APP_ID,
      appSecret: APP_SECRET,
      extra: { assistantCode: ASSISTANT_CODE },
    }),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(120_000),
  });

  console.log(`HTTP ${res.status}  ${res.headers.get('content-type') ?? '?'}  ${fmtMs(Date.now() - t0)}`);

  if (res.status >= 400) {
    const body = await res.text();
    console.log(C.red(`响应体：\n${body.slice(0, 1000)}`));
    throw new Error(`HTTP ${res.status}`);
  }

  if (!res.body) throw new Error('响应没有 body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let total = 0;
  let answer = '';
  const counts = { delta: 0, reference: 0, recommend: 0, progress: 0, session: 0, error: 0, other: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        console.log(C.dim(`[done] (累计 ${total} 帧, ${fmtMs(Date.now() - t0)})`));
        reader.releaseLock();
        console.log(`\n${C.bold('汇总：')}${JSON.stringify(counts)}`);
        console.log(`\n${C.bold('回答前 200 字：')}\n${answer.slice(0, 200) || C.dim('(空)')}`);
        return;
      }

      total += 1;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        console.log(C.yellow(`[非 JSON] ${payload.slice(0, 200)}`));
        continue;
      }

      // 错误码
      const errCode = evt.code ?? evt.error_code ?? evt.error?.code;
      if (errCode !== undefined && errCode !== null && errCode !== 0 && errCode !== '0') {
        counts.error += 1;
        console.log(C.red(`[error code=${errCode}] ${evt.message ?? evt.msg ?? ''}`));
        reader.releaseLock();
        throw new Error(`平台错误码 ${errCode}`);
      }

      const typeField = evt.type ?? evt.event ?? 'delta';

      // 抽出可读内容
      let snippet = '';
      if (typeof evt.content === 'string') snippet = evt.content;
      else if (Array.isArray(evt.choices) && evt.choices[0]) {
        snippet = evt.choices[0].delta?.content ?? evt.choices[0].message?.content ?? '';
      } else if (evt.sessionId || evt.session_id) {
        snippet = `sessionId=${evt.sessionId ?? evt.session_id}`;
      }

      if (typeField in counts) counts[typeField] += 1;
      else counts.other += 1;

      if (typeField === 'delta' || (!typeField && snippet)) answer += snippet;

      // 前 5 帧完整打印，后面的只打摘要
      if (total <= 5) dump(`[${typeField}] `, evt);
    }
  }

  reader.releaseLock();
  console.log(`\n${C.bold('汇总：')}${JSON.stringify(counts)}`);
  console.log(`\n${C.bold('回答前 200 字：')}\n${answer.slice(0, 200) || C.dim('(空)')}`);
}

/* ─────────── upload 探测 ─────────── */

async function probeUpload() {
  console.log(`\n${C.bold(C.cyan('━━━ upload 探测'))}  host=${HOST}  libId=${LIB_ID}  categoryId=${CATEGORY_ID}`);

  const path = '/openapi/flames/api/v1/knowledge/document/upload';
  const url = `http://${HOST}${path}`;
  const fileName = process.env.PLATFORM_PROBE_FILE ?? `probe-${Date.now()}.txt`;
  const body = `# probe ${new Date().toISOString()}\n\n你好，这是来自本地服务的连通性探测。\n`;

  const form = new FormData();
  form.append('libId', LIB_ID);
  form.append('categoryId', CATEGORY_ID);
  form.append('fileType', 'text');
  form.append('files', new Blob([body], { type: 'text/plain' }), fileName);

  const headers = {
    Authorization: buildBearerAuth({
      host: HOST,
      method: 'POST',
      path,
      appId: APP_ID,
      appSecret: APP_SECRET,
    }),
  };

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(90_000),
  });

  const text = await res.text();
  console.log(`HTTP ${res.status}  ${fmtMs(Date.now() - t0)}`);
  dump('响应：', text.slice(0, 1500));

  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('响应不是 JSON：' + text.slice(0, 200));
  }

  const docId = parsed.docId ?? parsed.doc_id ?? parsed.id ?? parsed.documentId;
  if (!docId) {
    throw new Error('响应里没有 docId / id 字段 —— 手册此处可能不一致，需要校准');
  }
  console.log(C.green(`\n✓ 文档已上传：docId=${docId}  paragraphs=${parsed.paragraphs ?? '?'}`));
}

/* ─────────── 入口 ─────────── */

async function main() {
  need('PLATFORM_HOST', HOST);
  need('PLATFORM_APP_ID', APP_ID);
  need('PLATFORM_APP_SECRET', APP_SECRET);

  const tasks = [];
  if (MODE === 'chat' || MODE === 'both') {
    need('PLATFORM_ASSISTANT_CODE', ASSISTANT_CODE);
    tasks.push(probeChat());
  }
  if (MODE === 'upload' || MODE === 'both') {
    need('PLATFORM_LIB_ID', LIB_ID);
    need('PLATFORM_CATEGORY_ID', CATEGORY_ID);
    tasks.push(probeUpload());
  }

  if (tasks.length === 0) {
    console.error(`\x1b[31m未知模式：${MODE}\x1b[0m（chat | upload | both）`);
    process.exit(2);
  }

  try {
    await Promise.all(tasks);
    console.log(C.green(`\n✓ 探测完成：${MODE}`));
  } catch (err) {
    console.error(C.red(`\n✗ 探测失败：${err.message}`));
    process.exit(1);
  }
}

await main();
