/**
 * 平台模块所有 Nest DI token 集中地。
 *
 * 为什么独立成文件：本目录里 service（kb-sync.service.ts 等）需要用 token 标 @Inject，
 * module.ts 又要把这些 service 列在 providers 里。如果 token 写在 module.ts 里，
 * service 反向 import token 就会形成 module.ts ↔ service 的循环依赖，
 * TS ESM 提升阶段就会报 `Cannot access 'X' before initialization`，进程直接退出。
 *
 * 这里只放字面量 token，没有任何相对引用，是叶子节点，谁都安全依赖。
 */
export const PLATFORM_AGENT_CLIENT_TOKEN = 'PLATFORM_AGENT_CLIENT';
export const PLATFORM_KB_CLIENT_TOKEN = 'PLATFORM_KB_CLIENT';
