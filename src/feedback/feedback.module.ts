import { Global, Module } from '@nestjs/common';
import { FeedbackService } from './feedback.service';

/**
 * Global because both ends need it: the chat API records a rating, the console
 * reads the queue. Neither owns it.
 */
@Global()
@Module({
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
