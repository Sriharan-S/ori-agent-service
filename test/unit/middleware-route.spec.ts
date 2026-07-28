import 'reflect-metadata';
import {
  Controller,
  Get,
  Injectable,
  Module,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { MIDDLEWARE_ROUTE_PATTERN } from '../../src/common/request-id.middleware';

@Injectable()
class ProbeMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    next();
  }
}

@Controller()
class ProbeController {
  @Get('health')
  health(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ProbeMiddleware).forRoutes(MIDDLEWARE_ROUTE_PATTERN);
  }
}

/**
 * A bad `forRoutes` pattern throws during `app.init()` — a crash at boot rather
 * than a failing request, which makes it the kind of thing you discover from a
 * deploy instead of a test run. Express 5 moved to path-to-regexp v8 and
 * tightened what it accepts, so this pins the pattern against whatever version
 * is installed.
 */
describe('request-id middleware route pattern', () => {
  it('initialises against the installed Express', async () => {
    const app = await NestFactory.create(ProbeModule, { logger: false });

    await expect(app.init()).resolves.toBeDefined();

    await app.close();
  });
});
