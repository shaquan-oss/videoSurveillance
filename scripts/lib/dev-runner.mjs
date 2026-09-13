/**
 * 开发服务的启动流程（dev-web / dev-api 共用）。
 *
 * 统一处理两件在托管/沙箱环境里反复踩到的事：
 *   1. 启动前确认端口空闲，避免撞上残留进程或别的项目；
 *   2. 启动后确认服务真的在提供服务，否则明确报错并终止，
 *      而不是让用户对着一个「启动了但连不上」的服务干着急。
 * 环境的处理见 dev-env.mjs（摘掉 fs 删除拦截层）。
 */
import { spawn } from 'node:child_process';
import { stripFsDeleteGuard } from './dev-env.mjs';
import { waitForPortFree, waitForServing } from './net.mjs';

/**
 * @param {object} opts
 * @param {string} opts.label        显示名，如「Nuxt」「API」
 * @param {number} opts.port         监听端口
 * @param {string[]} opts.command    启动命令，如 ['pnpm','--filter','@kh/web','dev']
 * @param {Record<string,string>} [opts.env] 额外环境变量
 * @param {number} [opts.readyTimeoutMs] 就绪等待上限
 */
export async function runDevService({ label, port, command, env = {}, readyTimeoutMs = 180_000 }) {
  console.log(`▸ 等待端口 ${port} 可用...`);
  if (!(await waitForPortFree(port))) {
    console.error(`✗ 端口 ${port} 在 40 秒内未释放，被别的进程长期占着。`);
    console.error(`  查谁在占：lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    console.error('  清残留：pnpm dev:stop');
    process.exit(1);
  }
  console.log(`✓ 端口 ${port} 可用，启动 ${label}`);

  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...stripFsDeleteGuard(process.env), ...env },
  });

  // 服务可能因端口判断失误、编译失败、崩溃循环等原因始终起不来，这里给出
  // 明确结论。超时要给够：冷启动现场编译上百个文件是要分钟的。
  const ready = await waitForServing(port, readyTimeoutMs);
  if (!ready) {
    console.error(`✗ ${port} 在 ${Math.round(readyTimeoutMs / 1000)} 秒内未就绪，正在终止进程。`);
    console.error(`  查占用：lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    child.kill('SIGTERM');
    process.exit(1);
  }
  console.log(`✓ ${label} 已在 ${port} 就绪`);

  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
