/**
 * 统一错误码与异常类型。
 * 前端据此显示提示，后端保证不把内部细节（如 SQL 报错）泄露给客户端。
 */

export const ErrorCode = {
  // 通用
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',

  // 账号
  LOGIN_FAILED: 'LOGIN_FAILED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PASSWORD_TOO_WEAK: 'PASSWORD_TOO_WEAK',

  // 文件
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_UPLOAD_INCOMPLETE: 'FILE_UPLOAD_INCOMPLETE',
  FOLDER_NOT_EMPTY: 'FOLDER_NOT_EMPTY',

  // 权限与密级
  SECURITY_DENIED: 'SECURITY_DENIED',
  CROSS_DEPT_DENIED: 'CROSS_DEPT_DENIED',
  PRIVATE_FILE_CANNOT_INGEST: 'PRIVATE_FILE_CANNOT_INGEST',

  // 知识库
  KB_NOT_FOUND: 'KB_NOT_FOUND',
  KB_INGEST_FAILED: 'KB_INGEST_FAILED',
  KB_PARSE_FAILED: 'KB_PARSE_FAILED',
  KB_UNSUPPORTED_FORMAT: 'KB_UNSUPPORTED_FORMAT',

  // 模型
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_RATE_LIMITED: 'MODEL_RATE_LIMITED',
  ALL_MODELS_DOWN: 'ALL_MODELS_DOWN',

  // 存储
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 面向用户的中文提示（不含任何内部细节） */
export const ERROR_MESSAGE: Record<string, string> = {
  BAD_REQUEST: '请求参数有误',
  UNAUTHORIZED: '请先登录',
  FORBIDDEN: '你没有执行该操作的权限',
  NOT_FOUND: '没有找到对应的内容',
  CONFLICT: '该内容已存在',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  INTERNAL: '服务出现异常，请稍后重试',

  LOGIN_FAILED: '账号或密码不正确',
  SESSION_EXPIRED: '登录已过期，请重新登录',
  ACCOUNT_DISABLED: '该账号已被停用',
  PASSWORD_TOO_WEAK: '密码强度不足',

  FILE_TOO_LARGE: '文件超出大小上限',
  FILE_TYPE_NOT_ALLOWED: '不支持该文件类型',
  FILE_NOT_FOUND: '文件不存在或已被删除',
  FILE_UPLOAD_INCOMPLETE: '文件上传未完成，请重试',
  FOLDER_NOT_EMPTY: '文件夹不为空，请先清空内容',

  SECURITY_DENIED: '你没有查看该文件的权限',
  CROSS_DEPT_DENIED: '跨部门访问受限',
  PRIVATE_FILE_CANNOT_INGEST: '私密文件不能纳入知识库',

  KB_NOT_FOUND: '知识库不存在',
  KB_INGEST_FAILED: '纳入知识库失败，请重试',
  KB_PARSE_FAILED: '文档解析失败',
  KB_UNSUPPORTED_FORMAT: '该格式暂不支持解析',

  MODEL_UNAVAILABLE: '模型暂时不可用',
  MODEL_TIMEOUT: '模型响应超时',
  MODEL_RATE_LIMITED: '模型调用过于频繁',
  ALL_MODELS_DOWN: '所有模型均不可用，请稍后重试',

  STORAGE_UNAVAILABLE: '文件存储暂时不可用',
  STORAGE_WRITE_FAILED: '文件保存失败',
};

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly detail?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCodeValue,
    options?: {
      message?: string;
      status?: number;
      detail?: unknown;
      expose?: boolean;
    },
  ) {
    super(options?.message ?? ERROR_MESSAGE[code] ?? '未知错误');
    this.name = 'AppError';
    this.code = code;
    this.status = options?.status ?? statusOf(code);
    this.detail = options?.detail;
    this.expose = options?.expose ?? true;
  }

  static isAppError(e: unknown): e is AppError {
    return e instanceof AppError;
  }
}

function statusOf(code: ErrorCodeValue): number {
  switch (code) {
    case ErrorCode.BAD_REQUEST:
    case ErrorCode.PASSWORD_TOO_WEAK:
      return 400;
    case ErrorCode.UNAUTHORIZED:
    case ErrorCode.LOGIN_FAILED:
    case ErrorCode.SESSION_EXPIRED:
      return 401;
    case ErrorCode.FORBIDDEN:
    case ErrorCode.SECURITY_DENIED:
    case ErrorCode.CROSS_DEPT_DENIED:
    case ErrorCode.ACCOUNT_DISABLED:
      return 403;
    case ErrorCode.NOT_FOUND:
    case ErrorCode.FILE_NOT_FOUND:
    case ErrorCode.KB_NOT_FOUND:
      return 404;
    case ErrorCode.CONFLICT:
    case ErrorCode.FOLDER_NOT_EMPTY:
      return 409;
    case ErrorCode.FILE_TOO_LARGE:
      return 413;
    case ErrorCode.FILE_TYPE_NOT_ALLOWED:
      return 415;
    case ErrorCode.RATE_LIMITED:
    case ErrorCode.MODEL_RATE_LIMITED:
      return 429;
    case ErrorCode.MODEL_TIMEOUT:
      return 504;
    default:
      return 500;
  }
}
