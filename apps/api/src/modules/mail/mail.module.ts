import { Module } from '@nestjs/common';
import { MailController } from './mail.controller.ts';
import { MailProvider } from './mail.provider.ts';
import { MailService } from './mail.service.ts';

@Module({
  controllers: [MailController],
  providers: [MailService, MailProvider],
  exports: [MailService],
})
export class MailModule {}
