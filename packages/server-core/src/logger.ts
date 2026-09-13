import pino from 'pino';

/**
 * 结构化日志。
 * api 与 worker 共用同一套格式，方便按 requestId 串起一次请求的完整链路。
 */
export function createLogger(options?: { name?: string; level?: string }) {
  const isDev = (process.env.NODE_ENV ?? 'development') !== 'production';
  return pino({
    name: options?.name ?? 'khub',
    level: options?.level ?? process.env.LOG_LEVEL ?? 'info',
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
