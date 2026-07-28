import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatController } from '../api/chat.controller';
import { ExecutorService } from './executor.service';
import { OrchestratorService } from './orchestrator.service';
import { PlannerService } from './planner.service';
import { ReflectorService } from './reflector.service';
import { RouterService } from './router.service';
import { SynthesizerService } from './synthesizer.service';

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [
    RouterService,
    PlannerService,
    ExecutorService,
    ReflectorService,
    SynthesizerService,
    OrchestratorService,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
