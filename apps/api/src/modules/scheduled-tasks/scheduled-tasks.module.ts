import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.ts';
import { ScheduledTasksController } from './scheduled-tasks.controller.ts';
import { ScheduledTasksExecutor } from './scheduled-tasks.executor.ts';
import { ScheduledTasksService } from './scheduled-tasks.service.ts';

@Module({
  imports: [ConversationsModule],
  controllers: [ScheduledTasksController],
  providers: [ScheduledTasksService, ScheduledTasksExecutor],
  exports: [ScheduledTasksService],
})
export class ScheduledTasksModule {}
