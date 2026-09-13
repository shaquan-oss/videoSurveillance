#!/usr/bin/env node
/**
 * Nuxt dev 启动预检。
 *
 * 问题一：在沙箱/HMR/代理环境里，Nuxt 的 get-port 检测偶尔把刚释放的
 * TIME_WAIT 端口判定为"已被占用"，于是静默 fallback 到 3000 —— 撞了铁路项目。
 * 这里先等端口真正可绑，再用 WEB_PORT 指定端口，并在 nuxt.config 里开了
 * devServer.strictPort 把它自己的 fallback 关掉。
 *
 * 问题二：托管环境注入的 fs 删除拦截层会让 Nuxt 清理 .nuxt/dev 缓存时崩溃并
 * 无限重启（端口在监听但请求全部无响应）。启动流程统一处理，见 lib/dev-runner.mjs。
 *
 * 用法：pnpm dev:web
 */
import { runDevService } from './lib/dev-runner.mjs';

const PORT = Number(process.env.WEB_PORT ?? 3100);
const PROXY = process.env.NUXT_API_PROXY ?? 'http://127.0.0.1:3101';

await runDevService({
  label: 'Nuxt',
  port: PORT,
  command: ['pnpm', '--filter', '@kh/web', 'dev'],
  env: { WEB_PORT: String(PORT), NUXT_API_PROXY: PROXY },
  readyTimeoutMs: 120_000,
});
