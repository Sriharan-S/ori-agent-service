import {
  Body,
  Controller,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiExtraModels,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
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
@ApiTags('chat')
@ApiSecurity('api-key')
@ApiHeader({
  name: 'X-End-User',
  required: false,
  description:
    'JSON identity, for applications in `asserted` mode. ' +
    'e.g. {"id":"4821","role":"support","scopes":{"org_id":42}}',
})
@ApiHeader({
  name: 'X-End-User-Token',
  required: false,
  description: "The end user's JWT, for applications in `jwt` mode.",
})
@ApiExtraModels(ChatRequestDto)
@Controller('v1/chat')
@UseGuards(ApiKeyGuard, RateLimitGuard)
@RequireScope('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly orchestrator: OrchestratorService) {}

  @Post()
  @ApiOperation({
    summary: 'Ask a question',
    description:
      'Runs the full pipeline and returns the finished response. Use the ' +
      'streaming variant when you want the answer to appear as it is written.',
  })
  @ApiResponse({ status: 201, description: 'The agent answered, asked for clarification, or confirmed an action.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key, or unresolvable end user.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded for this end user.' })
  async chat(
    @Body() body: ChatRequestDto,
    @Ctx() context: RequestContext,
  ): Promise<ChatResponseDto> {
    const response = await this.orchestrator.handle(
      body.message,
      body.conversationId ?? null,
      context,
      undefined,
      { replaceFromMessageId: body.replaceFromMessageId ?? null },
    );

    return {
      conversationId: response.conversationId,
      runId: response.runId,
      type: response.type,
      message: response.message,
      ...(response.candidates ? { candidates: response.candidates } : {}),
      functionsUsed: response.functionsUsed,
      requestId: response.requestId,
      userMessageId: response.userMessageId ?? null,
      assistantMessageId: response.assistantMessageId ?? null,
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
  @ApiOperation({
    summary: 'Ask a question, streamed',
    description: [
      'Server-Sent Events, one JSON event per frame with `event:` naming the type.',
      '',
      '**User channel** (always sent): `run.started`, `turn.recorded`,',
      '`message.delta`, `clarification`, `run.completed`, `error`.',
      '',
      '`turn.recorded` carries the id each turn was stored under. Keep the id of',
      'a user turn to let someone edit it later: resend with',
      '`replaceFromMessageId` set to it and that turn, along with everything',
      'after it, is discarded before the run reads the history.',
      '',
      '**Trace channel** (only when the key holds the `trace` scope *and* the',
      'request sets `trace: true`): `router.decision`, `catalogue.selected`,',
      '`plan.created`, `function.started`, `function.completed`, `reflection`.',
      'These name functions and echo extracted parameters, so an end-user',
      'surface should use a key without that scope.',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: 'text/event-stream' })
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
        { replaceFromMessageId: body.replaceFromMessageId ?? null },
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
