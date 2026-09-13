#!/usr/bin/env node
/**
 * 聚智平台连通性探测脚本。
 *
 * 为什么独立写：诊断「签名对不对 / assistantCode 是不是有效 / libId 我能不能上传」，
 * 这些事不该等到跑 smoke 才发现。脚本自己用 Node 原生 crypto 重实现签名，
 * 不依赖 server-core 的构建产物，单文件可读。
 *
 * ⚠️ 鉴权关键（实测结论）：聚智平台有**两套**鉴权，用错位置会得到误导性的 401。
 *   本脚本要测的这两个接口都用 **URL 查询参数**方式，**不是** Authorization 头：
 *     - 智能体：POST /openapi/flames/api/v1/chat?host=..&date=..&authorization=..&assistantCode=..
 *     - 知识库：POST /openapi/flames/api/v1/knowledge/document/upload?host=..&date=..&authorization=..
 *   用 Authorization 头 → 401「签名参数为空」（平台根本没读到签名，很容易误判成"没权限"）。
 *
 * 用法：
 *   node scripts/probe-platform.mjs chat        # 只测智能体对话
 *   node scripts/probe-platform.mjs upload      # 只测文档上传
 *   node scripts/probe-platform.mjs             # 两个都跑
 *
 * 环境变量（必须都设，缺一个直接退出）：
 *   PLATFORM_HOST            例：10.0.0.1:30000（带端口）
 *   PLATFORM_APP_ID          应用 id
 *   PLATFORM_APP_SECRET      应用密钥
 *   PLATFORM_ASSISTANT_CODE  智能体 code（chat 模式用）
 *   PLATFORM_LIB_ID          平台知识库 id（upload 模式用）
 *   PLATFORM_CATEGORY_ID     平台知识库分类 id（upload 模式用）
 *
 * 可选：
 *   PLATFORM_PROBE_TEXT      自定义问候语，默认 "你好"
 *   PLATFORM_PROBE_FILE      自定义上传文件名，默认 "probe-<ts>.txt"
 */

import { createHmac } from 'node:crypto';

const HOST = process.env.PLATFORM_HOST;
const APP_ID = process.env.PLATFORM_APP_ID;
const APP_SECRET = process.env.PLATFORM_APP_SECRET;
const ASSISTANT_CODE = process.env.PLATFORM_ASSISTANT_CODE;
const LIB_ID = process.env.PLATFORM_LIB_ID;
const CATEGORY_ID = process.env.PLATFORM_CATEGORY_ID;

const MODE = (process.argv[2] ?? 'both').toLowerCase();

const CHAT_PATH = '/openapi/flames/api/v1/chat';
const UPLOAD_PATH = '/openapi/flames/api/v1/knowledge/document/upload';

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

/**
 * 构造 URL 查询参数形式的鉴权。
 * authorization 里**只能**有这 4 个字段，多塞字段平台会回「认证信息格式不正确」。
 */
function buildQueryAuth({ host, method, path, appId, appSecret, assistantCode }) {
  const hostOnly = host.split(':')[0];
  const date = new Date().toUTCString();
  const requestLine = `${method} ${path} HTTP/1.1`;
  const signature = createHmac('sha256', appSecret)
    .update(`host: ${hostOnly}\ndate: ${date}\n${requestLine}`)
    .digest('base64');
  const authOrigin =
    `hmac api_key="${appId}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signature}"`;

  const params = {
    host: hostOnly,
    date,
    authorization: Buffer.from(authOrigin, 'utf8').toString('base64'),
  };
  if (assistantCode) params.assistantCode = assistantCode;
  return new URLSearchParams(params).toString();
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

  const qs = buildQueryAuth({
    host: HOST,
    method: 'POST',
    path: CHAT_PATH,
    appId: APP_ID,
    appSecret: APP_SECRET,
    assistantCode: ASSISTANT_CODE,
  });
  const url = `http://${HOST}${CHAT_PATH}?${qs}`;
  const text = process.env.PLATFORM_PROBE_TEXT ?? '你好';

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(120_000),
  });

  console.log(`HTTP ${res.status}  ${res.headers.get('content-type') ?? '?'}  ${fmtMs(Date.now() - t0)}`);

  if (res.status >= 400) {
    const body = await res.text();
    console.log(`响应体：\n${body.slice(0, 1000)}`);
    if (res.status === 401 && body.includes('签名参数为空')) {
      console.log(C.red('→ 签名没被平台读到。鉴权参数必须拼在 URL 查询串上，不能用 Authorization 头。'));
    } else if (res.status === 401 && body.includes('请求接口未授权或不存在')) {
      console.log(C.yellow('→ 签名已通过 ✓，卡在这个 assistantCode 上（无效 / 未关联给该应用）。'));
      console.log(C.yellow('  需要在聚智平台建好智能体，并在 API 管理里把它关联给当前应用。'));
    }
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

      const errCode = evt.code ?? evt.error_code ?? evt.error?.code;
      if (errCode !== undefined && errCode !== null && errCode !== 0 && errCode !== '0') {
        counts.error += 1;
        console.log(C.red(`[error code=${errCode}] ${evt.message ?? evt.msg ?? ''}`));
        reader.releaseLock();
        throw new Error(`平台错误码 ${errCode}`);
      }

      const typeField = evt.type ?? evt.event ?? 'delta';

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

  const qs = buildQueryAuth({
    host: HOST,
    method: 'POST',
    path: UPLOAD_PATH,
    appId: APP_ID,
    appSecret: APP_SECRET,
  });
  const url = `http://${HOST}${UPLOAD_PATH}?${qs}`;
  const fileName = process.env.PLATFORM_PROBE_FILE ?? `probe-${Date.now()}.txt`;
  const body = `# probe ${new Date().toISOString()}\n\n你好，这是来自本地服务的连通性探测。\n`;

  const form = new FormData();
  form.append('libId', LIB_ID);
  form.append('categoryId', CATEGORY_ID);
  form.append('fileType', 'text');
  form.append('files', new Blob([body], { type: 'text/plain' }), fileName);

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(90_000),
  });

  const text = await res.text();
  console.log(`HTTP ${res.status}  ${fmtMs(Date.now() - t0)}`);
  dump('响应：', text.slice(0, 1500));

  // 平台业务失败也返回 200，必须看正文里的 code
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('响应不是 JSON：' + text.slice(0, 200));
  }

  const bizCode = parsed.header?.code ?? parsed.code;
  if (bizCode !== undefined && bizCode !== 0 && bizCode !== 200) {
    const msg = parsed.header?.message ?? parsed.message ?? '';
    console.log(C.red(`\n✗ 业务失败：code=${bizCode} ${msg}`));
    if (String(msg).includes('没有操作此知识库的权限')) {
      console.log(C.yellow('→ 签名与参数都正确，缺的是应用对该知识库的授权（在平台 API 管理里关联）。'));
    }
    throw new Error(`平台业务码 ${bizCode}`);
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
