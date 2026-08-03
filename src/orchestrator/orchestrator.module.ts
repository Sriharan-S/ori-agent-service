import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ChatController } from '../api/chat.controller';
import { AgentLoopService } from './agent-loop.service';
import { ExecutorService } from './executor.service';
import { OrchestratorService } from './orchestrator.service';
import { ReflectorService } from './reflector.service';
import { RouterService } from './router.service';
import { SynthesizerService } from './synthesizer.service';

@Module({
  imports: [AuthModule, KnowledgeModule],
  controllers: [ChatController],
  providers: [
    RouterService,
    AgentLoopService,
    ExecutorService,
    ReflectorService,
    SynthesizerService,
    OrchestratorService,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
