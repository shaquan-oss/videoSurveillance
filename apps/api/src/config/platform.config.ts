/**
 * 平台凭证配置。
 * 在 apps/api 启动时 loadConfig() 顺便调用 loadPlatformConfig()，缺少凭证不报错 —— 但任何远程调用会失败。
 */
export interface PlatformConfig {
  enabled: boolean;
  host: string;
  appId: string;
  appSecret: string;
}

export function loadPlatformConfig(): PlatformConfig {
  const host = process.env.PLATFORM_HOST ?? '';
  const appId = process.env.PLATFORM_APP_ID ?? '';
  const appSecret = process.env.PLATFORM_APP_SECRET ?? '';
  return {
    enabled: Boolean(host && appId && appSecret),
    host,
    appId,
    appSecret,
  };
}

export const PLATFORM_CONFIG_TOKEN = 'PLATFORM_CONFIG';
