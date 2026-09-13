import { PlatformAgentClient, PlatformKbClient } from '@kh/server-core';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.ts';
import { DatabaseModule } from '../../database/database.module.ts';
import { PLATFORM_CONFIG_TOKEN, loadPlatformConfig, type PlatformConfig } from '../../config/platform.config.ts';
import { KbSyncService } from './kb-sync.service.ts';
import { PlatformController } from './platform.controller.ts';
import {
  PLATFORM_AGENT_CLIENT_TOKEN,
  PLATFORM_KB_CLIENT_TOKEN,
} from './platform.tokens.ts';

/**
 * token 在 platform.tokens.ts 集中导出，本文件既消费也 re-export 一份，
 * 保留外部 `import { ... } from '../platform/platform.module'` 的旧用法。
 */
export { PLATFORM_AGENT_CLIENT_TOKEN, PLATFORM_KB_CLIENT_TOKEN };

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [PlatformController],
  providers: [
    KbSyncService,
    { provide: PLATFORM_CONFIG_TOKEN, useFactory: () => loadPlatformConfig() },
    {
      provide: PLATFORM_AGENT_CLIENT_TOKEN,
      inject: [PLATFORM_CONFIG_TOKEN],
      useFactory: (cfg: PlatformConfig): PlatformAgentClient | null =>
        cfg.enabled
          ? new PlatformAgentClient({ host: cfg.host, appId: cfg.appId, appSecret: cfg.appSecret })
          : null,
    },
    {
      provide: PLATFORM_KB_CLIENT_TOKEN,
      inject: [PLATFORM_CONFIG_TOKEN],
      useFactory: (cfg: PlatformConfig): PlatformKbClient | null =>
        cfg.enabled
          ? new PlatformKbClient({ host: cfg.host, appId: cfg.appId, appSecret: cfg.appSecret })
          : null,
    },
  ],
  exports: [KbSyncService, PLATFORM_CONFIG_TOKEN, PLATFORM_AGENT_CLIENT_TOKEN, PLATFORM_KB_CLIENT_TOKEN],
})
export class PlatformModule {}
