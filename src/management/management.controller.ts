import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Ctx, ManagementKeyGuard } from '../auth/api-key.guard';
import type { RequestContext } from '../auth/identity';
import { RoleService } from '../auth/role.service';
import { ConversationService } from '../memory/conversation.service';
import { RegistryService } from '../registry/registry.service';
import type { FunctionStatus } from '../registry/function.contract';
import { ApplicationService } from './application.service';
import {
  FunctionManagementService,
  type FunctionInput,
} from './function-management.service';

/**
 * The management API a host application uses to administer its own registry.
 *
 * Authenticated by an API key carrying the `manage` scope, and scoped to that
 * key's application throughout — an application cannot read or change another's
 * functions even if it guesses a name, because the application id comes from
 * the key rather than from the request.
 */
@ApiTags('management')
@ApiSecurity('api-key')
@Controller('v1/manage')
@UseGuards(ManagementKeyGuard)
export class ManagementController {
  constructor(
    private readonly registry: RegistryService,
    private readonly functions: FunctionManagementService,
    private readonly roles: RoleService,
    private readonly applications: ApplicationService,
    private readonly conversations: ConversationService,
  ) {}

  // ── Functions ──────────────────────────────────────────────────────────────

  @Get('functions')
  @ApiOperation({ summary: 'List functions, optionally filtered by status' })
  async listFunctions(
    @Ctx() context: RequestContext,
    @Query('status') status?: FunctionStatus,
  ) {
    const functions = await this.registry.listAll(
      context.application.id,
      status,
    );
    return { functions };
  }

  @Get('functions/:name')
  @ApiOperation({ summary: 'Fetch one function, including drafts' })
  async getFunction(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
  ) {
    const definition = await this.registry.getByName(
      context.application.id,
      name,
    );
    return { function: definition };
  }

  /** Validate without saving — what a function editor calls as you type. */
  @Post('functions/check')
  @ApiOperation({ summary: 'Validate a function without saving it' })
  async checkFunction(
    @Ctx() context: RequestContext,
    @Body() body: FunctionInput,
  ) {
    return this.functions.check(context.application.id, body);
  }

  @Post('functions')
  @ApiOperation({ summary: 'Create a function (always starts as a draft)' })
  async createFunction(
    @Ctx() context: RequestContext,
    @Body() body: FunctionInput,
  ) {
    return this.functions.create(context.application.id, body, null);
  }

  @Put('functions/:name')
  @ApiOperation({ summary: 'Update a function (returns it to draft)' })
  async updateFunction(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
    @Body() body: FunctionInput,
  ) {
    return this.functions.update(context.application.id, name, body, null);
  }

  /**
   * Promote or retire a function. `draft → approved → live` is the release
   * path; `disabled` is the kill switch and can be set from anywhere.
   */
  @Post('functions/:name/status')
  @ApiOperation({ summary: 'Promote or retire a function' })
  async setStatus(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
    @Body() body: { status: FunctionStatus },
  ) {
    const definition = await this.functions.setStatus(
      context.application.id,
      name,
      body.status,
      null,
    );
    return { function: definition };
  }

  @Get('functions/:name/versions')
  @ApiOperation({ summary: 'Version history' })
  async versions(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
  ) {
    const definition = await this.registry.getByName(
      context.application.id,
      name,
    );
    if (!definition) return { versions: [] };
    return { versions: await this.functions.versions(definition.id) };
  }

  @Delete('functions/:name')
  @ApiOperation({ summary: 'Delete a function' })
  async deleteFunction(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
  ) {
    await this.functions.remove(context.application.id, name, null);
    return { deleted: true };
  }

  // ── Roles ──────────────────────────────────────────────────────────────────

  @Get('roles')
  @ApiOperation({ summary: 'List roles' })
  async listRoles(@Ctx() context: RequestContext) {
    return { roles: await this.roles.list(context.application.id) };
  }

  @Put('roles/:name')
  @ApiOperation({ summary: 'Create or update a role' })
  async upsertRole(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
    @Body()
    body: {
      description?: string | null;
      allowedFunctions?: string[];
      writeScopes?: string[];
      unscopedKeys?: string[];
    },
  ) {
    const role = await this.roles.upsert(context.application.id, {
      name,
      description: body.description ?? null,
      allowedFunctions: body.allowedFunctions ?? [],
      writeScopes: body.writeScopes ?? [],
      unscopedKeys: body.unscopedKeys ?? [],
    });
    return { role };
  }

  @Delete('roles/:name')
  @ApiOperation({ summary: 'Delete a role' })
  async deleteRole(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
  ) {
    await this.roles.remove(context.application.id, name);
    return { deleted: true };
  }

  // ── Services (HTTP action targets) ─────────────────────────────────────────

  @Get('services')
  @ApiOperation({ summary: 'List registered HTTP action targets' })
  async listServices(@Ctx() context: RequestContext) {
    return { services: await this.applications.listServices(context.application.id) };
  }

  @Put('services/:name')
  @ApiOperation({ summary: 'Register an HTTP action target' })
  async upsertService(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
    @Body() body: { baseUrl: string; publicBaseUrl?: string | null },
  ) {
    const service = await this.applications.upsertService(
      context.application.id,
      name,
      body.baseUrl,
      body.publicBaseUrl ?? null,
    );
    return { service };
  }

  @Delete('services/:name')
  @ApiOperation({ summary: 'Remove an HTTP action target' })
  async deleteService(
    @Ctx() context: RequestContext,
    @Param('name') name: string,
  ) {
    await this.applications.removeService(context.application.id, name);
    return { deleted: true };
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  @Get('conversations')
  @ApiOperation({ summary: 'List conversations' })
  async listConversations(
    @Ctx() context: RequestContext,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return {
      conversations: await this.conversations.list(
        context.application.id,
        limit ? Number(limit) : 50,
        offset ? Number(offset) : 0,
      ),
    };
  }

  @Get('conversations/:key')
  @ApiOperation({ summary: 'Fetch a conversation transcript' })
  async transcript(@Param('key') key: string) {
    return { messages: await this.conversations.getTranscript(key) };
  }
}
