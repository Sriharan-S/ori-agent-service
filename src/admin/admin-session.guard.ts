import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AdminAuthService, type AdminRole } from './admin-auth.service';

export const ADMIN_SESSION_COOKIE = 'ori_admin_session';
export const REQUIRED_ADMIN_ROLE = 'ori:required_admin_role';

export interface AdminRequest extends Request {
  admin?: Awaited<ReturnType<AdminAuthService['resolveSession']>>;
}

/** Restricts a route to operators at or above a role. */
export const RequireAdminRole = (role: AdminRole): MethodDecorator =>
  SetMetadata(REQUIRED_ADMIN_ROLE, role);

const RANK: Record<AdminRole, number> = { viewer: 1, admin: 2, owner: 3 };

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AdminAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = readCookie(request, ADMIN_SESSION_COOKIE);

    const admin = await this.auth.resolveSession(token);
    request.admin = admin;

    const required = this.reflector.getAllAndOverride<AdminRole | undefined>(
      REQUIRED_ADMIN_ROLE,
      [context.getHandler(), context.getClass()],
    );

    if (required && RANK[admin.role] < RANK[required]) {
      throw new ForbiddenException(
        `This action needs the "${required}" role or higher.`,
      );
    }

    return true;
  }
}

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (!request.admin) {
      throw new Error('CurrentAdmin used on a route without AdminSessionGuard');
    }
    return request.admin;
  },
);

/**
 * Minimal cookie reader.
 *
 * One cookie is read in the whole service, so `cookie-parser` would be a
 * dependency and a piece of global middleware for a single header split.
 */
export function readCookie(
  request: Request,
  name: string,
): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }

  return undefined;
}
