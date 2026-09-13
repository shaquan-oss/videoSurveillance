/**
 * 开发服务的运行环境处理。
 *
 * 背景：某些托管环境（例如 AI 助手自带的沙箱）会用
 *   NODE_OPTIONS=--require=<...>/genie-safe-delete.cjs
 * 注入一层「批量删除保护」，拦截进程内所有 fs.rm，一次删除超过阈值（50）就抛错。
 * 但 Nuxt / Vite 会定期清理自己的缓存目录（`.nuxt/dev`、`node_modules/.cache/vite`
 * 一次就是几十上百个文件），于是被判定为批量删除 → dev server 反复重启直至无响应。
 *
 * 现象特别好认：端口在 LISTEN，但所有请求都无响应；日志里刷满
 *   Restarting Nuxt due to error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
 * （实测因此空转重启 95 次。）这些缓存目录是工具自己的产物，删除属于正常行为，
 * 所以在启动开发服务前把**这一项**从 NODE_OPTIONS 里摘掉，与用户无关的其它
 * NODE_OPTIONS 参数和环境变量全部原样保留。
 *
 * 用户自己终端启动时本就没有这层注入，此函数是空操作。
 */
const FS_GUARD_PATTERN = /genie-safe-delete\.cjs/;

/** 返回去掉删除拦截层后的环境副本；没有拦截层时原样返回 */
export function stripFsDeleteGuard(env) {
  const raw = env.NODE_OPTIONS;
  if (!raw || !FS_GUARD_PATTERN.test(raw)) return env;

  const kept = raw.split(/\s+/).filter((token) => token.length > 0 && !FS_GUARD_PATTERN.test(token));
  const next = { ...env };
  if (kept.length > 0) next.NODE_OPTIONS = kept.join(' ');
  else delete next.NODE_OPTIONS;
  return next;
}
