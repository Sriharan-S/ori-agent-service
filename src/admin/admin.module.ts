import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ManagementModule } from '../management/management.module';
import { AdminAuthService } from './admin-auth.service';
import { AdminSessionGuard } from './admin-session.guard';
import { AdminController } from './admin.controller';
import { DashboardController } from './dashboard.controller';
import { DatabaseInfoService } from './database-info.service';
import { ObservabilityService } from './observability.service';

@Module({
  imports: [AuthModule, ManagementModule],
  controllers: [AdminController, DashboardController],
  providers: [
    AdminAuthService,
    AdminSessionGuard,
    ObservabilityService,
    DatabaseInfoService,
  ],
  exports: [AdminAuthService, ObservabilityService, DatabaseInfoService],
})
export class AdminModule {}
