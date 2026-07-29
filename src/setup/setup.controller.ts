import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SetupService } from './setup.service';

/**
 * The onboarding endpoints.
 *
 * Unauthenticated by necessity — before the first operator account exists there
 * is nobody to authenticate — and safe to be, because of what each route can
 * actually do:
 *
 *   GET  /setup        reports stage names, the agent's own table names and the
 *                      DDL that creates them. Driver messages, which can name a
 *                      host or a user, are attached by the service only while no
 *                      account exists.
 *   POST /setup/check  reconnects and reports again. Rate-floored in the service.
 *   POST /setup/admin  creates the first account, and is refused by a single
 *                      conditional INSERT the moment one exists.
 *
 * Excluded from the OpenAPI document with the rest of `/admin`: these describe
 * one deployment's state, not an API anyone integrates against.
 */
@ApiExcludeController()
@Controller('admin/api/setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get()
  status() {
    return this.setup.status();
  }

  @Post('check')
  recheck() {
    return this.setup.recheck();
  }

  @Get('sql')
  sql() {
    return { sql: this.setup.setupSql() };
  }

  @Post('admin')
  async createAdmin(
    @Body()
    body: {
      email: string;
      password: string;
      confirmPassword: string;
      name?: string;
    },
  ) {
    const user = await this.setup.createFirstAdmin(body);
    return { user, status: await this.setup.status() };
  }
}
