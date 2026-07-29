import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CONFIG, type AppConfig } from '../config/configuration';
import { ApiKeyService } from '../auth/api-key.service';
import type { ApiKeyScope } from '../auth/identity';
import { RoleService } from '../auth/role.service';
import { LlmService } from '../llm/llm.service';
import {
  ModelRegistryService,
  type ModelInput,
} from '../llm/model-registry.service';
import { ConversationService } from '../memory/conversation.service';
import { RegistryService } from '../registry/registry.service';
import type { FunctionStatus } from '../registry/function.contract';
import { ApplicationService, type ApplicationInput } from '../management/application.service';
import {
  FunctionManagementService,
  type FunctionInput,
} from '../management/function-management.service';
import {
  FunctionTrialService,
  type TrialInput,
} from '../management/function-trial.service';
import { AdminAuthService, type AdminRole } from './admin-auth.service';
import {
  ADMIN_SESSION_COOKIE,
  AdminSessionGuard,
  CurrentAdmin,
  RequireAdminRole,
  readCookie,
} from './admin-session.guard';
import { ObservabilityService } from './observability.service';
import { DatabaseInfoService } from './database-info.service';
import { DEMO_FUNCTION_NAME } from '../management/demo-function';

/**
 * The dashboard's own API.
 *
 * Session-authenticated and cross-tenant: an operator picks which application
 * they are looking at, unlike the management API where the API key fixes it.
 * Read routes need only a session; anything that changes state needs `admin`,
 * and anything that changes who can administer needs `owner`.
 */
@Controller('admin/api')
export class AdminController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly auth: AdminAuthService,
    private readonly observability: ObservabilityService,
    private readonly database: DatabaseInfoService,
    private readonly applications: ApplicationService,
    private readonly registry: RegistryService,
    private readonly functions: FunctionManagementService,
    private readonly trials: FunctionTrialService,
    private readonly roles: RoleService,
    private readonly models: ModelRegistryService,
    private readonly llm: LlmService,
    private readonly apiKeys: ApiKeyService,
    private readonly conversations: ConversationService,
  ) {}

  // ── Session ────────────────────────────────────────────────────────────────

  @Post('login')
  async login(
    @Body() body: { email: string; password: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { token, user, expiresAt } = await this.auth.login(
      body.email ?? '',
      body.password ?? '',
      {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      },
    );

    response.cookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      // Set over plain HTTP in development so the dashboard is usable locally;
      // a session cookie must never leave the browser unencrypted in production.
      secure: this.config.service.isProduction,
      expires: expiresAt,
      path: '/',
    });

    return { user };
  }

  @Post('logout')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(readCookie(request, ADMIN_SESSION_COOKIE));
    response.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminSessionGuard)
  me(@CurrentAdmin() admin: { email: string; role: AdminRole }) {
    return { user: admin };
  }

  // ── Overview ───────────────────────────────────────────────────────────────

  @Get('overview')
  @UseGuards(AdminSessionGuard)
  async overview() {
    const [overview, active, recent] = await Promise.all([
      this.observability.overview(),
      this.observability.activeRuns(),
      this.observability.recentRuns(25),
    ]);

    return { overview, active, recent, llm: this.llm.getMetrics(50) };
  }

  @Get('runs/:runKey')
  @UseGuards(AdminSessionGuard)
  runDetail(@Param('runKey') runKey: string) {
    return this.observability.runDetail(runKey);
  }

  @Get('audit')
  @UseGuards(AdminSessionGuard)
  async audit(
    @Query('limit') limit?: string,
    @Query('function') functionName?: string,
  ) {
    return {
      entries: await this.observability.auditLog(
        limit ? Number(limit) : 100,
        functionName,
      ),
    };
  }

  // ── Database ───────────────────────────────────────────────────────────────

  /** Connection details, the write-assertion result, and what the agent can see. */
  @Get('database')
  @UseGuards(AdminSessionGuard)
  async databaseReport() {
    return this.database.report();
  }

  @Get('database/tables')
  @UseGuards(AdminSessionGuard)
  async agentTables() {
    return { tables: await this.database.agentTableNames() };
  }

  // ── Applications ───────────────────────────────────────────────────────────

  @Get('applications')
  @UseGuards(AdminSessionGuard)
  async listApplications() {
    return { applications: await this.applications.list() };
  }

  /**
   * Creating an application also installs the demo function, so a new tenant is
   * immediately testable rather than starting with an empty registry and no way
   * to tell whether any of it works.
   */
  @Post('applications')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async createApplication(@Body() body: ApplicationInput) {
    const application = await this.applications.upsert(body);

    const demo = await this.functions
      .ensureDemoFunction(application.id, this.config.db.schema)
      .catch(() => null);

    return { application, demoInstalled: demo !== null };
  }

  /** Reinstalls the demo function if it was deleted. */
  @Post('applications/:id/functions/demo')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async installDemo(@Param('id', ParseIntPipe) id: number) {
    const result = await this.functions.ensureDemoFunction(
      id,
      this.config.db.schema,
    );
    return {
      installed: result !== null,
      name: DEMO_FUNCTION_NAME,
      validation: result?.validation ?? null,
    };
  }

  @Put('applications/:id')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async updateApplication(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ApplicationInput,
  ) {
    return { application: await this.applications.upsert(body, id) };
  }

  @Get('applications/:id/services')
  @UseGuards(AdminSessionGuard)
  async listServices(@Param('id', ParseIntPipe) id: number) {
    return { services: await this.applications.listServices(id) };
  }

  @Put('applications/:id/services/:name')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async upsertService(
    @Param('id', ParseIntPipe) id: number,
    @Param('name') name: string,
    @Body() body: { baseUrl: string },
  ) {
    return {
      service: await this.applications.upsertService(id, name, body.baseUrl),
    };
  }

  // ── API keys ───────────────────────────────────────────────────────────────

  @Get('applications/:id/keys')
  @UseGuards(AdminSessionGuard)
  async listKeys(@Param('id', ParseIntPipe) id: number) {
    return { keys: await this.apiKeys.list(id) };
  }

  /** The secret is returned once, here, and never again. */
  @Post('applications/:id/keys')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async createKey(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name: string; scopes: ApiKeyScope[] },
  ) {
    const issued = await this.apiKeys.issue(
      id,
      body.name,
      body.scopes?.length ? body.scopes : ['chat'],
    );
    return { key: issued.record, secret: issued.secret };
  }

  @Delete('keys/:id')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async revokeKey(@Param('id', ParseIntPipe) id: number) {
    await this.apiKeys.revoke(id);
    return { revoked: true };
  }

  // ── Functions ──────────────────────────────────────────────────────────────

  @Get('applications/:id/functions')
  @UseGuards(AdminSessionGuard)
  async listFunctions(
    @Param('id', ParseIntPipe) id: number,
    @Query('status') status?: FunctionStatus,
  ) {
    return { functions: await this.registry.listAll(id, status) };
  }

  @Get('applications/:id/functions/:name')
  @UseGuards(AdminSessionGuard)
  async getFunction(
    @Param('id', ParseIntPipe) id: number,
    @Param('name') name: string,
  ) {
    const definition = await this.registry.getByName(id, name);
    const versions = definition
      ? await this.functions.versions(definition.id)
      : [];
    return { function: definition, versions };
  }

  /** Validates without saving. Powers the live feedback in the editor. */
  @Post('applications/:id/functions/check')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async checkFunction(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: FunctionInput,
  ) {
    return this.functions.check(id, body);
  }

  /**
   * Run a function as a chosen role, without promoting it.
   *
   * Works on drafts — checking what a function returns before it goes live is
   * the point — and applies scoping exactly as production does, so refusals can
   * be tested too.
   */
  @Post('applications/:id/functions/:name/try')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async tryFunction(
    @Param('id', ParseIntPipe) id: number,
    @Param('name') name: string,
    @Body() body: TrialInput,
  ) {
    return this.trials.run(id, name, body);
  }

  @Post('applications/:id/functions')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async createFunction(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: FunctionInput,
    @CurrentAdmin() admin: { id: number },
  ) {
    return this.functions.create(id, body, admin.id);
  }

  @Put('applications/:id/functions/:name')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async updateFunction(
    @Param('id', ParseIntPipe) id: number,
    @Param('name') name: string,
    @Body() body: FunctionInput,
    @CurrentAdmin() admin: { id: number },
  ) {
    return this.functions.update(id, name, body, admin.id);
  }

  @Post('applications/:id/functions/:name/status')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async setFunctionStatus(
    @Param('id', ParseIntPipe) id: number,
    @Param('name') name: string,
    @Body() body: { status: FunctionStatus },
    @CurrentAdmin() admin: { id: number },
  ) {
    return {
      function: await this.functions.setStatus(id, name, body.status, admin.id),
    };
  }

  @Delete('applications/:id/functions/:name')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async deleteFunction(
    @Param('id', ParseIntPipe) id: number,
    @Param('name') name: string,
    @CurrentAdmin() admin: { id: number },
  ) {
    await this.functions.remove(id, name, admin.id);
    return { deleted: true };
  }

  // ── Roles ──────────────────────────────────────────────────────────────────

  @Get('applications/:id/roles')
  @UseGuards(AdminSessionGuard)
  async listRoles(@Param('id', ParseIntPipe) id: number) {
    return { roles: await this.roles.list(id) };
  }

  @Put('applications/:id/roles/:name')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async upsertRole(
    @Param('id', ParseIntPipe) id: number,
    @Param('name') name: string,
    @Body()
    body: {
      description?: string | null;
      allowedFunctions?: string[];
      writeScopes?: string[];
      unscopedKeys?: string[];
    },
  ) {
    return {
      role: await this.roles.upsert(id, {
        name,
        description: body.description ?? null,
        allowedFunctions: body.allowedFunctions ?? [],
        writeScopes: body.writeScopes ?? [],
        unscopedKeys: body.unscopedKeys ?? [],
      }),
    };
  }

  @Delete('applications/:id/roles/:name')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async deleteRole(
    @Param('id', ParseIntPipe) id: number,
    @Param('name') name: string,
  ) {
    await this.roles.remove(id, name);
    return { deleted: true };
  }

  // ── Models ─────────────────────────────────────────────────────────────────

  @Get('models')
  @UseGuards(AdminSessionGuard)
  async listModels() {
    return { models: await this.models.list() };
  }

  @Post('models')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async createModel(@Body() body: ModelInput) {
    return { model: await this.models.upsert(body) };
  }

  @Put('models/:id')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async updateModel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ModelInput,
  ) {
    return { model: await this.models.upsert(body, id) };
  }

  @Delete('models/:id')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async deleteModel(@Param('id', ParseIntPipe) id: number) {
    await this.models.remove(id);
    return { deleted: true };
  }

  /**
   * Probe an endpoint before committing it. Accepts unsaved values so a bad
   * base URL or model id is caught in the editor rather than by the first real
   * chat request.
   */
  @Post('models/test')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('admin')
  async testModel(
    @Body()
    body: {
      baseUrl: string;
      modelId: string;
      apiKey?: string | null;
      existingId?: number | null;
    },
  ) {
    return this.models.testConnection(body);
  }

  /** On-demand reachability probe. Not run on the readiness path. */
  @Post('models/health')
  @UseGuards(AdminSessionGuard)
  async modelHealth(@Body() body: { applicationId: number }) {
    return { results: await this.llm.healthCheck(body.applicationId) };
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  @Get('applications/:id/conversations')
  @UseGuards(AdminSessionGuard)
  async listConversations(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limit?: string,
  ) {
    return {
      conversations: await this.conversations.list(
        id,
        limit ? Number(limit) : 50,
      ),
    };
  }

  @Get('conversations/:key')
  @UseGuards(AdminSessionGuard)
  async transcript(@Param('key') key: string) {
    return { messages: await this.conversations.getTranscript(key) };
  }

  // ── Operators ──────────────────────────────────────────────────────────────

  @Get('admins')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('owner')
  async listAdmins() {
    return { admins: await this.auth.listUsers() };
  }

  @Post('admins')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('owner')
  async createAdmin(
    @Body()
    body: { email: string; password: string; name?: string; role?: AdminRole },
  ) {
    return {
      admin: await this.auth.createUser(
        body.email,
        body.password,
        body.name ?? null,
        body.role ?? 'admin',
      ),
    };
  }

  @Post('admins/:id/password')
  @UseGuards(AdminSessionGuard)
  @RequireAdminRole('owner')
  async setPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { password: string },
  ) {
    await this.auth.setPassword(id, body.password);
    return { ok: true };
  }
}
