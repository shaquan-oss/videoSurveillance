/**
 * 端口探测工具，供 dev-web / dev-api 共用。
 *
 * 这里区分两种语义，不能混用：
 *
 * 1. **能否绑定** —— 启动前判断端口空不空闲。用真实的 bind 探针而不是 lsof：
 *    沙箱里处于 TIME_WAIT 的端口也会被 lsof 认为「有人监听」，只有 bind 才知道
 *    能不能真正占用。
 * 2. **能否连上** —— 启动后判断服务是否已就绪。必须用 TCP connect：服务可能绑在
 *    通配地址（如 `*:3101`）上，而 BSD/macOS 的 SO_REUSEADDR 允许在通配绑定存在时
 *    再绑 `127.0.0.1:同一端口`，此时 bind 探针会误判「空闲」。
 *    （实测踩过：API 明明已在 3101 提供服务，bind 探针却说端口空闲，于是启动脚本把
 *    刚起来的进程当成「起不来」杀掉了。）
 */
import { createConnection, createServer } from 'node:net';

const HOST = '127.0.0.1';

/** 端口当前是否可被绑定 */
export function canBind(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, HOST);
  });
}

/** 端口上是否已有服务在监听（TCP 能连上） */
export function isServing(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: HOST });
    const done = (serving) => {
      sock.destroy();
      resolve(serving);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1500, () => done(false));
  });
}

/** 等端口真正释放（可绑定）；返回是否在超时前释放 */
export async function waitForPortFree(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBind(port)) return true;
    process.stdout.write(`  端口 ${port} 暂不可用，等 1s...\n`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** 等端口上的服务就绪；返回是否在超时前就绪 */
export async function waitForServing(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServing(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
