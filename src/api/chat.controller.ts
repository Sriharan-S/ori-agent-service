import {
  Body,
  Controller,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard, Ctx, RequireScope } from '../auth/api-key.guard';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import type { RequestContext } from '../auth/identity';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import type { AgentEvent } from '../orchestrator/orchestrator.types';
import { ChatRequestDto, type ChatResponseDto } from './dto/chat.dto';

/**
 * The chat API.
 *
 * Two shapes of the same run: `POST /v1/chat` returns the finished response,
 * `POST /v1/chat/stream` emits it as Server-Sent Events. The pipeline is
 * identical — the streaming route passes a sink, the other passes nothing.
 */
@Controller('v1/chat')
@UseGuards(ApiKeyGuard, RateLimitGuard)
@RequireScope('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly orchestrator: OrchestratorService) {}

  @Post()
  async chat(
    @Body() body: ChatRequestDto,
    @Ctx() context: RequestContext,
  ): Promise<ChatResponseDto> {
    const response = await this.orchestrator.handle(
      body.message,
      body.conversationId ?? null,
      context,
    );

    return {
      conversationId: response.conversationId,
      runId: response.runId,
      type: response.type,
      message: response.message,
      ...(response.candidates ? { candidates: response.candidates } : {}),
      functionsUsed: response.functionsUsed,
      requestId: response.requestId,
    };
  }

  /**
   * Server-Sent Events, one JSON event per frame, `event:` naming the type.
   *
   * SSE rather than WebSockets: the traffic is one-directional for the whole
   * run, it survives proxies that mangle upgrades, and browsers reconnect on
   * their own.
   */
  @Post('stream')
  async stream(
    @Body() body: ChatRequestDto,
    @Ctx() context: RequestContext,
    @Res() response: Response,
  ): Promise<void> {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which turns a token stream
      // back into one big block at the end.
      'x-accel-buffering': 'no',
      'x-request-id': context.requestId,
    });
    response.flushHeaders();

    // Trace events name functions and echo extracted parameters, so they are
    // sent only when the key carries the scope *and* the caller asked.
    const includeTrace = context.traceEnabled && body.trace === true;
    let open = true;

    const heartbeat = setInterval(() => {
      if (open) response.write(': keep-alive\n\n');
    }, 15_000);

    const send = (event: AgentEvent): void => {
      if (!open) return;
      if (event.channel === 'trace' && !includeTrace) return;

      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    response.on('close', () => {
      open = false;
      clearInterval(heartbeat);
    });

    try {
      await this.orchestrator.handle(
        body.message,
        body.conversationId ?? null,
        context,
        send,
      );
    } catch (error) {
      // The orchestrator handles its own failures; this is the last resort.
      this.logger.error(
        `[${context.runId}] stream failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      send({
        type: 'error',
        channel: 'user',
        message: 'Something went wrong while answering.',
      });
    } finally {
      clearInterval(heartbeat);
      if (open) {
        response.write('event: done\ndata: {}\n\n');
        response.end();
      }
      open = false;
    }
  }
}
