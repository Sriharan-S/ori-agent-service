import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Candidate } from '../../registry/function.contract';

export class ClientContextDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  surface?: string;
}

export class ChatRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;

  /** Absent or null starts a new conversation. */
  @IsOptional()
  @IsUUID()
  conversationId?: string | null;

  /**
   * Replace an earlier turn: this message and everything after it are discarded
   * and the run continues from that point.
   *
   * The id comes from a `turn.recorded` event or from `userMessageId` on an
   * earlier response. Only meaningful alongside `conversationId`, and only for a
   * message in a conversation this caller owns — anything else is ignored
   * rather than refused, because a stale id from a reloaded client is not an
   * error worth failing a question over.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  replaceFromMessageId?: number | null;

  /**
   * Include internal steps in the stream. Requires the API key to carry the
   * `trace` scope; requesting it without one simply yields the user channel.
   */
  @IsOptional()
  @IsBoolean()
  trace?: boolean;

  /** Non-authoritative. Never used for an authorisation decision. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ClientContextDto)
  clientContext?: ClientContextDto;
}

/**
 * A rating for one answer.
 *
 * Carries identifiers only. The question, the answer and the functions that ran
 * are read from the agent's own records, so a client cannot describe a run
 * differently from how it happened.
 */
export class FeedbackRequestDto {
  @ApiProperty({ enum: ['up', 'down'], description: 'The verdict.' })
  @IsString()
  rating!: 'up' | 'down';

  @ApiPropertyOptional({ description: 'From the response being rated.' })
  @IsOptional()
  @IsString()
  runId?: string | null;

  @ApiPropertyOptional({ description: 'The turn being rated.' })
  @IsOptional()
  @IsInt()
  assistantMessageId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string | null;

  @ApiPropertyOptional({
    description: 'What was wrong, in the user\'s words. Optional but the most useful part.',
  })
  @IsOptional()
  @IsString()
  comment?: string | null;
}

export interface ChatResponseDto {
  conversationId: string;
  runId: string;
  type: 'answer' | 'clarification' | 'confirmation' | 'refused' | 'error';
  message: string;
  candidates?: Candidate[];
  functionsUsed: string[];
  requestId: string;
  /** Handles for a later `replaceFromMessageId`. */
  userMessageId?: number | null;
  assistantMessageId?: number | null;
}
