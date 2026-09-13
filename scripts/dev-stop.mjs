#!/usr/bin/env node
/**
 * 停掉本项目的开发进程（api / web / worker）。
 *
 * 为什么需要它：`pnpm dev:all` 实际是 `pnpm dev:api & pnpm dev:web`，
 * 按 Ctrl+C 只结束最外层 pnpm，`tsx watch` 和 Nuxt fork 出来的子进程会变成孤儿继续留着。
 * 攒几轮之后这些进程会占满文件监听句柄，新启动的 Nuxt 就会报
 * `EMFILE: too many open files, watch` 并无限重启 —— 现象就是「项目跑不起来」。
 * （实测踩过一次：24 个残留进程占着 19000+ 句柄，清理后立刻恢复正常。）
 *
 * 这里按**进程的工作目录**识别，只结束本项目的进程，不会误伤别的 node 服务；
 * 同时跳过自己所在的进程链（否则第一刀就砍到自己）。
 *
 * 用法：pnpm dev:stop
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 自己与直接父进程（pnpm）不能杀，否则脚本会中途被自己终止 */
const SELF = new Set([String(process.pid), String(process.ppid)]);

/** 找出工作目录在本项目内的 node 进程（lsof -d cwd 每个进程一行） */
function projectPids() {
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', '-d', 'cwd'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // lsof 在没有任何可用信息时会以非 0 退出，这里不是错误
    return [];
  }

  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!line.startsWith('node')) continue;
    const m = line.match(/\s(\/.*)$/);
    if (!m) continue;
    const cwd = m[1];
    if (cwd !== ROOT && !cwd.startsWith(`${ROOT}/`)) continue;
    const pid = line.split(/\s+/)[1];
    if (!SELF.has(pid)) pids.add(pid);
  }
  return [...pids];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pids = projectPids();
if (pids.length === 0) {
  console.log('✓ 没有本项目的残留进程');
  process.exit(0);
}

console.log(`▸ 发现 ${pids.length} 个本项目进程：${pids.join(' ')}`);
for (const pid of pids) {
  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch {
    // 进程可能刚好自己退出了
  }
}

await sleep(2000);

const stubborn = projectPids();
if (stubborn.length > 0) {
  console.log(`▸ ${stubborn.length} 个未退出，强制结束：${stubborn.join(' ')}`);
  for (const pid of stubborn) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // 同上
    }
  }
}

console.log('✓ 本项目开发进程已全部停止');
