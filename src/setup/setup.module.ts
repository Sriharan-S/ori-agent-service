import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

/**
 * Onboarding. Depends on AdminModule for operator accounts; the database and
 * LLM modules are global.
 */
@Module({
  imports: [AdminModule],
  controllers: [SetupController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
