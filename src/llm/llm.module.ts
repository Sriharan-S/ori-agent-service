import { Global, Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { ModelRegistryService } from './model-registry.service';

@Global()
@Module({
  providers: [ModelRegistryService, LlmService],
  exports: [ModelRegistryService, LlmService],
})
export class LlmModule {}
