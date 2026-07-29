import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApplicationService } from './application.service';
import { FunctionManagementService } from './function-management.service';
import { FunctionTrialService } from './function-trial.service';
import { ManagementController } from './management.controller';

@Module({
  imports: [AuthModule],
  controllers: [ManagementController],
  providers: [ApplicationService, FunctionManagementService, FunctionTrialService],
  exports: [ApplicationService, FunctionManagementService, FunctionTrialService],
})
export class ManagementModule {}
