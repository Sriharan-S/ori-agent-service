import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
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

export interface ChatResponseDto {
  conversationId: string;
  runId: string;
  type: 'answer' | 'clarification' | 'confirmation' | 'error';
  message: string;
  candidates?: Candidate[];
  functionsUsed: string[];
  requestId: string;
}
