/**
 * 上传相关的共享配置：文件管理、知识库上传都从这里取，避免各处重复读环境变量。
 */
export const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES ?? '100');

export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? '200');

/** multer 的 FilesInterceptor 配置：临时落盘 + 大小与数量上限 */
export const uploadInterceptorOptions = {
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_UPLOAD_FILES },
};
