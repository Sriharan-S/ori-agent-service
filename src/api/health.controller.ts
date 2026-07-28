import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import { ReadDb } from '../db/read.db';
import { ModelRegistryService } from '../llm/model-registry.service';

interface ReadyReport {
  status: 'ok' | 'degraded';
  checks: {
    primaryDb: boolean;
    readDb: boolean;
    applications: number;
    liveFunctions: number;
    enabledModels: number;
  };
}

@Controller()
export class HealthController {
  constructor(
    private readonly primary: PrimaryDb,
    private readonly read: ReadDb,
    private readonly models: ModelRegistryService,
  ) {}

  /** Liveness: is the process up. Never touches a dependency. */
  @Get('health')
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
  async ready(): Promise<ReadyReport> {
    const schema = quoteIdent(this.primary.schema);

    const [applications, functions, models] = await Promise.all([
      this.primary
        .one<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${schema}.applications WHERE is_active`,
        )
        .catch(() => null),
      this.primary
        .one<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${schema}.functions WHERE status = 'live'`,
        )
        .catch(() => null),
      this.models.list().catch(() => []),
    ]);

    const primaryDb = this.primary.isReady() && applications !== null;
    const readDb = this.read.isReady();

    return {
      status: primaryDb && readDb ? 'ok' : 'degraded',
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
