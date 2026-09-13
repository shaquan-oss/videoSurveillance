#!/usr/bin/env node
/**
 * API dev 启动预检，与 dev-web.mjs 对称。
 *
 * 主要处理托管环境注入的 fs 删除拦截层：它会让 `tsx watch` 清理临时产物时抛错，
 * 进程启动成功后在几秒内静默消失（现象：日志显示启动完成，但端口上没有进程）。
 *
 * 就绪超时给到 180 秒：tsx watch 冷启动要现场编译 100+ 个文件，实测约 60 秒。
 *
 * 用法：pnpm dev:api
 */
import { runDevService } from './lib/dev-runner.mjs';

const PORT = Number(process.env.API_PORT ?? 3101);

await runDevService({
  label: 'API',
  port: PORT,
  command: ['pnpm', '--filter', '@kh/api', 'dev'],
  readyTimeoutMs: 180_000,
});
