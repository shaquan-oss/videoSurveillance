import { QUEUE_NAMES } from '@kh/shared';

/**
 * 队列与任务的契约定义。
 * api 侧只负责投递，worker 侧负责消费，两边引用同一份 payload 类型。
 */
export { QUEUE_NAMES };

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface ParseDocumentJob {
  fileId: string;
  kbId: string;
  /** 重新解析时用，便于追踪来源 */
  reason?: 'ingest' | 'reparse' | 'reembed';
}

export interface EmbedChunksJob {
  fileId: string;
  kbId: string;
  /** 解析后待向量化的切片；分批投递避免单任务过大 */
  chunkIds?: string[];
}

export interface SendMailJob {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** 关联的定时任务或草稿 */
  sourceId?: string;
  attachments?: { fileId: string; name: string }[];
}

export interface ScheduledTaskJob {
  taskId: string;
  /** 计划触发时间，用于审计与幂等判断 */
  scheduledAt: string;
  runId: string;
}

export interface CleanupJob {
  kind: 'upload-sessions' | 'trash' | 'exports';
  olderThanDays?: number;
}

/** 队列默认重试策略：指数退避，最多 3 次，之后进失败队列等人处理 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1_000 },
};

export const JOB_NAMES = {
  PARSE_DOCUMENT: 'parse-document',
  EMBED_CHUNKS: 'embed-chunks',
  SEND_MAIL: 'send-mail',
  SCHEDULED_TASK: 'scheduled-task',
  CLEANUP: 'cleanup',
} as const;
