#!/usr/bin/env node
/**
 * 端到端冒烟自检：登录 → 知识库 → 智能体 → 建会话 → 流式问答。
 *
 * 用途：改完检索/问答/权限后，一条命令确认主链路没坏，不必手点页面。
 * 用法：pnpm smoke                     # 用内置默认问题
 *       pnpm smoke "差旅费报销要哪些材料"  # 指定问题
 * 前置：docker 数据服务已起、API 已运行（pnpm dev:api）。
 *
 * 环境变量（都有默认值，默认值仅适用于本地开发）：
 *   KH_API_BASE     默认 http://127.0.0.1:3101/api
 *   KH_SMOKE_ACCOUNT / KH_SMOKE_PASSWORD  默认取 seed 的 admin 账号
 */

const BASE = process.env.KH_API_BASE ?? 'http://127.0.0.1:3101/api';
const ACCOUNT = process.env.KH_SMOKE_ACCOUNT ?? 'admin';
const PASSWORD = process.env.KH_SMOKE_PASSWORD ?? 'Admin@2026';

// 库里确实有内容的默认问题；换成库中没有的问题时，回答应落到「资料中没有找到」
const DEFAULT_QUESTION = '差旅费报销要准备哪些材料？住宿标准是多少？';

let cookie = '';

/** 发请求并自动续上会话 cookie；统一返回解析后的 JSON。 */
async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  // Node 的 fetch 不会自动带 cookie，手动接力
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length > 0) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');

  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** 累加 SSE 事件直到流结束，返回正文与事件计数。 */
async function readStream(res) {
  const events = {
    start: 0,
    citations: 0,
    meta: 0,
    delta: 0,
    followUps: 0,
    done: 0,
  };
  let citations = [];
  let answer = '';
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6));
      events[event.type] = (events[event.type] ?? 0) + 1;
      if (event.type === 'delta') answer += event.text ?? '';
      if (event.type === 'citations') citations = event.citations ?? [];
      if (event.type === 'error') throw new Error(event.message);
    }
  }
  return { events, citations, answer };
}

const started = Date.now();

const login = await api('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ account: ACCOUNT, password: PASSWORD }),
});
if (login.status >= 400) {
  console.error(`登录失败（${login.status}）：${JSON.stringify(login.body)}`);
  process.exit(1);
}
console.log(`[1] 登录 ${login.status}  ${login.body.data.user.name}@${login.body.data.user.departmentName}`);

const { body: kbBody } = await api('/kb');
const visible = kbBody.data.visible ?? [];
const locked = kbBody.data.locked ?? [];
console.log(`[2] 知识库  可见 ${visible.length} / 无权 ${locked.length}`);
for (const kb of visible) console.log(`    - ${kb.name}  文件 ${kb.fileCount}  切片 ${kb.chunkCount}`);

const { body: agentBody } = await api('/agents');
const agents = agentBody.data ?? [];
console.log(`[3] 智能体  共 ${agents.length}`);
for (const agent of agents) console.log(`    - ${agent.name}  ${agent.testedAt ? '已试跑' : '未试跑'}`);

const question = process.argv[2] ?? DEFAULT_QUESTION;
const conversation = await api('/conversations', {
  method: 'POST',
  body: JSON.stringify({}),
});

const stream = await fetch(`${BASE}/conversations/ask/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ conversationId: conversation.body.data.id, question }),
});
if (stream.status >= 400) {
  console.error(`提问失败（${stream.status}）`);
  process.exit(1);
}

const { events, citations, answer } = await readStream(stream);
console.log(`[4] 提问  ${question}`);
for (const cite of citations) {
  console.log(`    [${cite.index}] ${cite.fileName}  score=${cite.score?.toFixed(3) ?? '-'}`);
}
if (citations.length === 0) console.log('    （无引用，回答应落在「资料中没有找到」）');
console.log(`[5] 回答  ${answer.length} 字 / ${events.delta} 个增量事件 / 共 ${Date.now() - started}ms`);
console.log(`\n${answer.slice(0, 800)}`);
