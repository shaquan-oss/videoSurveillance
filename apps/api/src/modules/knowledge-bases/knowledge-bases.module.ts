import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.ts';
import { KnowledgeBasesController } from './knowledge-bases.controller.ts';
import { KnowledgeBasesService } from './knowledge-bases.service.ts';

@Module({
  imports: [FilesModule],
  controllers: [KnowledgeBasesController],
  providers: [KnowledgeBasesService],
  exports: [KnowledgeBasesService],
})
export class KnowledgeBasesModule {}
