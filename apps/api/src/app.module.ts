import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionGuard } from './common/guards/permission.guard.ts';
import { SessionGuard } from './common/guards/session.guard.ts';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.ts';
import { DatabaseModule } from './database/database.module.ts';
import { HealthModule } from './health/health.module.ts';
import { TrashCleanupService } from './maintenance/trash-cleanup.service.ts';
import { AdminModule } from './modules/admin/admin.module.ts';
import { AgentsModule } from './modules/agents/agents.module.ts';
import { AuditModule } from './modules/audit/audit.module.ts';
import { AuthModule } from './modules/auth/auth.module.ts';
import { ConversationsModule } from './modules/conversations/conversations.module.ts';
import { FilesModule } from './modules/files/files.module.ts';
import { KnowledgeBasesModule } from './modules/knowledge-bases/knowledge-bases.module.ts';
import { MailModule } from './modules/mail/mail.module.ts';
import { ModelsModule } from './modules/models/models.module.ts';
import { PlatformModule } from './modules/platform/platform.module.ts';
import { ScheduledTasksModule } from './modules/scheduled-tasks/scheduled-tasks.module.ts';
import { SkillsModule } from './modules/skills/skills.module.ts';
import { RedisModule } from './redis/redis.module.ts';
import { StorageModule } from './storage/storage.module.ts';

/**
 * 根模块：只做装配，不写业务。
 *
 * 两个全局守卫的执行顺序很重要：
 * 先 SessionGuard（确认是谁），再 PermissionGuard（确认能不能做）。
 */
@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    StorageModule,
    AuditModule,
    AuthModule,
    FilesModule,
    KnowledgeBasesModule,
    ConversationsModule,
    AgentsModule,
    SkillsModule,
    ScheduledTasksModule,
    MailModule,
    AdminModule,
    ModelsModule,
    PlatformModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: SessionGuard }, { provide: APP_GUARD, useClass: PermissionGuard }, TrashCleanupService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // NestJS 12 使用的 path-to-regexp v8 不再支持裸 '*'，需要具名通配符
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
