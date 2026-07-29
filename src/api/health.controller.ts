import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import { ReadDb } from '../db/read.db';
import { ModelRegistryService } from '../llm/model-registry.service';

interface ReadyReport {
  status: 'ok' | 'degraded' | 'setup-required';
  /** What an operator has to do, when the answer is not "nothing". */
  setup: { primary: string; read: string } | null;
  checks: {
    primaryDb: boolean;
    readDb: boolean;
    applications: number;
    liveFunctions: number;
    enabledModels: number;
  };
}

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly primary: PrimaryDb,
    private readonly read: ReadDb,
    private readonly models: ModelRegistryService,
  ) {}

  /** Liveness: is the process up. Never touches a dependency. */
  @Get('health')
  @ApiOperation({ summary: 'Liveness — never touches a dependency' })
  @HttpCode(HttpStatus.OK)
  health(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Readiness: can this instance serve a request.
   *
   * Deliberately does not call a model. A reachability probe on every readiness
   * check would add a paid round-trip per poll and make an LLM hiccup look like
   * an instance failure; model health belongs on the dashboard, where it is
   * checked on demand.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness — database connections and registry counts' })
  async ready(): Promise<ReadyReport> {
    const primaryStage = this.primary.getStatus().stage;
    const readStage = this.read.getStatus().stage;

    // A deployment that has not been set up is not the same as one that is
    // broken, and an orchestrator restarting it will not help. Say which.
    if (primaryStage !== 'ready') {
      return {
        status: 'setup-required',
        setup: { primary: primaryStage, read: readStage },
        checks: {
          primaryDb: false,
          readDb: this.read.isReady(),
          applications: 0,
          liveFunctions: 0,
          enabledModels: 0,
        },
      };
    }

    const schema = quoteIdent(this.primary.schema);

    const [applications, functions, models] = await Promise.all([
      this.primary
        .one<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${schema}.agent_applications WHERE is_active`,
        )
        .catch(() => null),
      this.primary
        .one<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${schema}.agent_functions WHERE status = 'live'`,
        )
        .catch(() => null),
      this.models.list().catch(() => []),
    ]);

    const primaryDb = this.primary.isReady() && applications !== null;
    const readDb = this.read.isReady();

    return {
      status: primaryDb && readDb ? 'ok' : 'degraded',
      // Only when there is genuinely something to set up. Both stages being
      // `ready` while a live query fails is a runtime failure, not an
      // outstanding setup step, and echoing the stale stage here read as a
      // contradiction of `checks`.
      setup:
        readStage === 'ready' ? null : { primary: primaryStage, read: readStage },
      checks: {
        primaryDb,
        readDb,
        applications: Number(applications?.count ?? 0),
        liveFunctions: Number(functions?.count ?? 0),
        enabledModels: models.filter((model) => model.isEnabled).length,
      },
    };
  }
}
