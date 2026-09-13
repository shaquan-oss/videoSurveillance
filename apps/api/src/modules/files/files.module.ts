import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.ts';
import { FilesController } from './files.controller.ts';
import { FilesService } from './files.service.ts';
import { FoldersService } from './folders.service.ts';

@Module({
  imports: [AuditModule],
  controllers: [FilesController],
  providers: [FilesService, FoldersService],
  exports: [FilesService, FoldersService],
})
export class FilesModule {}
