import { Global, Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';

@Global()
@Module({
  providers: [ConversationService],
  exports: [ConversationService],
})
export class MemoryModule {}
