import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.ts';
import { MailModule } from '../mail/mail.module.ts';
import { PlatformModule } from '../platform/platform.module.ts';
import { ConversationsController } from './conversations.controller.ts';
import { ConversationsService } from './conversations.service.ts';

@Module({
  imports: [MailModule, AuditModule, PlatformModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
