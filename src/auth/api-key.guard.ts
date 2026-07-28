import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { ApiKeyService } from './api-key.service';
import { EndUserResolverService } from './end-user-resolver.service';
import { RoleService } from './role.service';
import type { ApiKeyScope, RequestContext } from './identity';

export interface AgentRequest extends Request {
  context?: RequestContext;
  requestId?: string;
}

export const REQUIRED_KEY_SCOPE = 'ori:required_key_scope';

/**
 * Declares the API key scope a route needs, e.g. `@RequireScope('manage')`.
 * Applies to a whole controller or to one handler.
 */
export const RequireScope = (
  scope: ApiKeyScope,
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_KEY_SCOPE, scope);

/**
 * The only way into the chat and management APIs.
 *
 * Two things happen here, in order: the API key authenticates the calling
 * application, then the end user is resolved in whichever mode that application
 * is configured for. Both must succeed. There is no anonymous path and no
 * service identity to fall back to.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
    private readonly endUsers: EndUserResolverService,
    private readonly roles: RoleService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const request = executionContext.switchToHttp().getRequest<AgentRequest>();
    const requestId = request.requestId ?? randomUUID();

    const presented = extractKey(request);
    const { key, application } = await this.apiKeys.verify(presented);

    const required = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(
      REQUIRED_KEY_SCOPE,
      [executionContext.getHandler(), executionContext.getClass()],
    );

    if (required && !key.scopes.includes(required)) {
      throw new ForbiddenException(
        `This API key does not carry the "${required}" scope.`,
      );
    }

    const endUser = await this.endUsers.resolve(application, {
      endUserToken: header(request, 'x-end-user-token'),
      assertedEndUser: header(request, 'x-end-user'),
    });

    const role = await this.roles.require(application.id, endUser.role);

    request.context = {
      application,
      apiKey: key,
      endUser,
      role,
      runId: randomUUID(),
      requestId,
      // Internal steps name functions and echo extracted parameters. That is
      // what an operator dashboard needs and what an end-user surface should
      // never receive, so it is opt-in per key.
      traceEnabled: key.scopes.includes('trace'),
    };

    return true;
  }
}

/** Authenticates the application only — no end user. For management routes. */
@Injectable()
export class ManagementKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeyService) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const request = executionContext.switchToHttp().getRequest<AgentRequest>();
    const { key, application } = await this.apiKeys.verify(extractKey(request));

    if (!key.scopes.includes('manage')) {
      throw new ForbiddenException(
        'This API key does not carry the "manage" scope.',
      );
    }

    request.context = {
      application,
      apiKey: key,
      // Management routes act as the application, not as a person. The end user
      // is a placeholder here and no registry function is reachable from these
      // routes, so it can never be used for scoping.
      endUser: { id: `apikey:${key.prefix}`, role: '__management__', scopes: {} },
      role: {
        id: 0,
        applicationId: application.id,
        name: '__management__',
        description: null,
        allowedFunctions: [],
        writeScopes: [],
        unscopedKeys: [],
      },
      runId: randomUUID(),
      requestId: request.requestId ?? randomUUID(),
      traceEnabled: key.scopes.includes('trace'),
    };

    return true;
  }
}

export const Ctx = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): RequestContext => {
    const request = executionContext.switchToHttp().getRequest<AgentRequest>();
    if (!request.context) {
      throw new Error('Ctx used on a route without ApiKeyGuard');
    }
    return request.context;
  },
);

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function extractKey(request: Request): string | undefined {
  const explicit = header(request, 'x-api-key');
  if (explicit) return explicit;

  const authorization = header(request, 'authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }

  return undefined;
}
