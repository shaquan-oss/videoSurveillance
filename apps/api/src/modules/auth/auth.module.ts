import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.ts';
import { AuthController } from './auth.controller.ts';
import { AuthService } from './auth.service.ts';
import { SessionService } from './session.service.ts';

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [AuthService, SessionService],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
