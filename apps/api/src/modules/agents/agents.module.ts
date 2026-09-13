import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller.ts';
import { AgentsService } from './agents.service.ts';

@Module({
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
