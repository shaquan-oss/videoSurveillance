import { Module } from '@nestjs/common';
import { ModelsController } from './models.controller.ts';

@Module({
  controllers: [ModelsController],
})
export class ModelsModule {}
