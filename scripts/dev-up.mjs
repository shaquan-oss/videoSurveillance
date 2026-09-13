#!/usr/bin/env node
/**
 * 一条命令把 api 与 web 拉成**后台守护进程**，终端立刻返回。
 *
 * 为什么要它：`pnpm dev:api` / `pnpm dev:web` 是前台常驻，会各占一个终端窗口。
 * 只想「起好、能访问」的时候，前台模式很碍事。
 *
 * 做法是标准的 daemonize：
 *   spawn(..., { detached: true }) → 子进程被放进新会话（相当于 setsid），不再是当前进程组的成员
 *   child.unref()                  → 父进程不再持有引用，可以立即退出
 *   日志重定向到 .dev-logs/*.log   → 脱离之后没有终端可继承，必须落到文件
 *
 * 注意：`pnpm dev:api` / `dev:web` 里已经处理了托管环境的 fs 删除拦截层
 * （不处理的话 tsx watch / Nuxt 会在启动后几秒静默退出），本脚本只是再包一层脱离会话，
 * 两件事分开，互不干扰。
 *
 * 用法：
 *   pnpm dev:up        起 api + web
 *   pnpm dev:up api    只起 api
 *   pnpm dev:stop      一起停掉
 *   日志：.dev-logs/api.log、.dev-logs/web.log
 *
 * ⚠️ 提示：这两个服务是 watch 模式，**改了后端/前端源码会自动重启**，
 * 重启期间端口会短暂连不上（curl 得到 000）。判断服务是不是真挂了，请间隔几秒重试两三次，
 * 不要一次连不上就重启服务 —— 那会把正在重启的进程打断，反而更乱。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { isServing, waitForServing } from './lib/net.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const LOG_DIR = resolve(ROOT, '.dev-logs');

/**
 * 每个服务都先经过 scripts/dev-*.mjs 那层预检（端口占用、fs 删除拦截层），
 * 守护化只负责「脱离会话」这一件事，两件事分开，互不干扰。
 */
const SERVICES = [
  {
    key: 'api',
    label: 'API',
    port: Number(process.env.API_PORT ?? 3101),
    command: ['node', 'scripts/dev-api.mjs'],
    env: {},
    readyTimeoutMs: 180_000, // tsx 冷启动要现场编译上百个文件
  },
  {
    key: 'web',
    label: 'Nuxt',
    port: Number(process.env.WEB_PORT ?? 3100),
    command: ['node', 'scripts/dev-web.mjs'],
    env: { WEB_PORT: String(process.env.WEB_PORT ?? 3100) },
    readyTimeoutMs: 120_000,
  },
];

const only = process.argv[2];
const wanted = only ? SERVICES.filter((s) => s.key === only) : SERVICES;
if (wanted.length === 0) {
  console.error(`✗ 不认识的服务「${only}」，可选：${SERVICES.map((s) => s.key).join(' / ')}`);
  process.exit(1);
}

mkdirSync(LOG_DIR, { recursive: true });

for (const svc of wanted) {
  if (await isServing(svc.port)) {
    console.log(`• ${svc.label} 已在 ${svc.port} 提供服务，跳过`);
    continue;
  }
  const logPath = resolve(LOG_DIR, `${svc.key}.log`);
  const fd = openSync(logPath, 'a');

  const child = spawn(svc.command[0], svc.command.slice(1), {
    cwd: ROOT,
    detached: true, // 新会话 → 不再属于当前进程组
    stdio: ['ignore', fd, fd], // 脱离后没有终端可继承，日志落文件
    // 预检脚本自己会处理 fs 删除拦截层，这里只补端口相关的环境变量
    env: { ...process.env, ...svc.env },
  });
  child.unref();
  console.log(`▸ 启动${svc.label}（pid ${child.pid}）→ 日志 ${logPath.slice(ROOT.length + 1)}`);
}

// 就绪检查放在最后统一做：两个服务并行启动，等待时间重叠，不用串行干等
const results = await Promise.all(wanted.map(async (svc) => ({ svc, ok: await waitForServing(svc.port, svc.readyTimeoutMs) })));

let failed = false;
for (const { svc, ok } of results) {
  if (ok) {
    console.log(`✓ ${svc.label} 就绪 → http://127.0.0.1:${svc.port}`);
  } else {
    failed = true;
    console.error(`✗ ${svc.label} 在 ${Math.round(svc.readyTimeoutMs / 1000)} 秒内未就绪`);
    console.error(`  看日志：tail -50 ${resolve(LOG_DIR, `${svc.key}.log`).slice(ROOT.length + 1)}`);
  }
}

if (failed) {
  console.error('\n提示：清掉残留进程后重试 → pnpm dev:stop && pnpm dev:up');
  process.exit(1);
}
console.log('\n服务已在后台运行，可以关掉这个终端。停止：pnpm dev:stop');
