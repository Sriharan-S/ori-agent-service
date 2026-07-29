import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { AdminAuthService, type AdminUser } from '../admin/admin-auth.service';
import {
  CONFIG,
  inspectConfiguration,
  type AppConfig,
  type ConfigProblem,
} from '../config/configuration';
import { PrimaryDb } from '../db/primary.db';
import { ReadDb } from '../db/read.db';
import { AGENT_TABLES, buildSetupSql } from '../db/migrations';
import { ModelRegistryService } from '../llm/model-registry.service';

export type SetupStepId = 'database' | 'tables' | 'read' | 'account';
export type SetupStepState = 'done' | 'blocked' | 'pending';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  state: SetupStepState;
  /** One sentence: what is true right now. */
  summary: string;
  /** What to do about it, when there is something to do. */
  action: string | null;
  /** Raw driver output. Withheld once an operator account exists. */
  detail: string | null;
  /**
   * Whether the console stays locked until this passes. The read connection is
   * required for the agent to answer anything, but not for looking around.
   */
  blocking: boolean;
}

export interface SetupStatus {
  /** Every blocking step has passed and the console can open. */
  complete: boolean;
  /** The step to show. `ready` when there is nothing left to do. */
  stage: SetupStepId | 'ready';
  steps: SetupStep[];
  problems: ConfigProblem[];
  schema: string;
  tables: Array<{ name: string; exists: boolean }>;
  /** The DDL that creates the agent tables, to run by hand if needed. */
  sql: string;
  /** The grants a read-only role needs. */
  readRoleSql: string;
  checkedAt: string;
}

/**
 * Onboarding.
 *
 * The service has no database of its own: it is pointed at one that already
 * exists and creates its `agent_*` tables inside it. That makes the first run
 * on any new deployment a sequence of things that can each be wrong in a
 * different way, and the previous behaviour — exit with a one-line message —
 * put all of them in a log file nobody has open yet.
 *
 * So nothing here throws to communicate. Each step reports what is true, what
 * to do about it, and whether it blocks. The one step that genuinely cannot be
 * automated — a database role that may not create tables — hands over the exact
 * SQL instead of asking the operator to work it out.
 *
 * ## What this endpoint may reveal
 *
 * It answers without authentication, because before the first account exists
 * there is nobody to authenticate. Everything it returns unconditionally is
 * already public: environment variable names, the agent's own table names, the
 * DDL that creates them. Raw driver messages are the exception — those can name
 * a host, a port or a user — so they are attached only while no operator
 * account exists, which is exactly the window in which there is nothing yet to
 * protect. Afterwards the same detail is one sign-in away on the Database tab.
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);
  private lastCheckStartedAt = 0;
  /**
   * Whether this process has ever seen an operator account.
   *
   * Needed because "no account exists" and "the database is down so I cannot
   * tell" look identical from here, and they call for opposite answers about
   * how much to say. Once an account has been observed, driver detail is
   * withheld for the life of the process even if the database later goes away.
   *
   * A restart while the database is down starts unset, and detail is shown
   * again — which is the one case where the deployment really is
   * indistinguishable from a fresh install, and the case where an operator most
   * needs to be told which host is refusing them.
   */
  private seenAccount = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly primary: PrimaryDb,
    private readonly read: ReadDb,
    private readonly admins: AdminAuthService,
    private readonly models: ModelRegistryService,
  ) {}

  async status(): Promise<SetupStatus> {
    // `null` means "could not tell", which is not the same as zero and must not
    // be treated as it. A database that goes away at runtime would otherwise
    // look like a fresh install: the console would offer to create a first
    // account that already exists, and the driver detail below would be
    // attached again to a deployment that is past setup.
    const adminCount = await this.countAdmins();
    if (adminCount !== null && adminCount > 0) this.seenAccount = true;
    const revealDetail = !this.seenAccount;

    const primaryStatus = this.primary.getStatus();
    const readStatus = this.read.getStatus();
    const problems = inspectConfiguration(this.config);

    // The recorded stage is from the last connect. Counting accounts is also a
    // liveness probe, so a database that was working and has since gone away is
    // reported as it is now rather than as it was at boot.
    const wentAway = primaryStatus.stage === 'ready' && adminCount === null;

    const steps: SetupStep[] = [
      this.databaseStep(primaryStatus, revealDetail, wentAway),
      this.tablesStep(primaryStatus, revealDetail),
      this.readStep(readStatus, revealDetail),
      this.accountStep(adminCount, primaryStatus.stage === 'ready'),
    ];

    // Two different questions. `complete` asks whether the console can open,
    // which only the blocking steps decide. `stage` asks which screen to show,
    // and that includes the read connection: it does not block sign-in, but
    // walking someone past it in silence is how a deployment ends up unable to
    // answer anything with no indication why.
    const blocker = steps.find((step) => step.blocking && step.state !== 'done');
    const next = steps.find((step) => step.state !== 'done');

    return {
      complete: blocker === undefined,
      stage: blocker === undefined ? 'ready' : (next?.id ?? blocker.id),
      steps,
      problems,
      schema: this.config.db.schema,
      tables: AGENT_TABLES.map((name) => ({
        name,
        exists: primaryStatus.existingTables.includes(name),
      })),
      sql: buildSetupSql(this.config.db.schema),
      readRoleSql: buildReadRoleSql(this.databaseName()),
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Reconnect everything and report again.
   *
   * This is the "I have fixed it — check now" button. It reconnects rather than
   * asking for a restart because an onboarding loop that requires a redeploy
   * between each attempt is how people give up.
   */
  async recheck(): Promise<SetupStatus> {
    const now = Date.now();
    if (now - this.lastCheckStartedAt < 2000) {
      // Reconnecting tears down and rebuilds two pools. Unauthenticated
      // endpoints get hammered; this one does real work, so it gets a floor.
      return this.status();
    }
    this.lastCheckStartedAt = now;

    this.logger.log('Re-checking setup: reconnecting both database connections');

    await this.primary.connect();
    await this.read.connect();

    if (this.primary.isReady()) {
      // Anything that normally happens once at boot but was skipped because the
      // database was not up yet.
      await this.admins
        .ensureBootstrapAccount()
        .catch((error: unknown) => this.warn('bootstrap account', error));
      await this.models
        .seedIfEmpty()
        .catch((error: unknown) => this.warn('model seed', error));
    }

    return this.status();
  }

  /** The DDL for an operator whose database role may not create tables. */
  setupSql(): string {
    return buildSetupSql(this.config.db.schema);
  }

  async createFirstAdmin(input: {
    email: string;
    password: string;
    confirmPassword: string;
    name?: string;
  }): Promise<AdminUser> {
    if (!this.primary.isReady()) {
      throw new BadRequestException(
        'The database is not ready yet, so the account cannot be stored. ' +
          'Finish the database step first.',
      );
    }
    if (input.password !== input.confirmPassword) {
      throw new BadRequestException('The two passwords do not match.');
    }

    const user = await this.admins.createFirstAdmin(
      input.email ?? '',
      input.password ?? '',
      input.name?.trim() || null,
    );

    // A fresh install has no models either; seeding here means the console is
    // not empty on first sight if LLM_SEED_* were provided.
    await this.models
      .seedIfEmpty()
      .catch((error: unknown) => this.warn('model seed', error));

    return user;
  }

  /** How many operator accounts exist, or `null` if the question can't be asked. */
  private async countAdmins(): Promise<number | null> {
    if (!this.primary.isReady()) return null;
    return this.admins.countAdmins().catch(() => null);
  }

  /**
   * The database name out of DATABASE_URL, for the generated GRANT statements.
   *
   * A placeholder rather than a throw when the URL is unparseable: the setup
   * screen is where you go *because* the URL is wrong, so it has to survive one.
   */
  private databaseName(): string {
    try {
      return (
        new URL(this.config.db.primaryUrl).pathname.replace(/^\//, '') ||
        'your_database'
      );
    } catch {
      return 'your_database';
    }
  }

  private databaseStep(
    status: ReturnType<PrimaryDb['getStatus']>,
    revealDetail: boolean,
    wentAway: boolean,
  ): SetupStep {
    const base = {
      id: 'database' as const,
      title: 'Connect a database',
      blocking: true,
      detail: revealDetail ? status.detail : null,
    };

    if (wentAway) {
      return {
        ...base,
        state: 'blocked',
        summary:
          'The database connected at start-up and has stopped responding. Nothing ' +
          'is wrong with the configuration — the server or the network is.',
        action: 'Once it is back, check again. The service reconnects without a restart.',
      };
    }

    if (status.stage === 'not-configured') {
      return {
        ...base,
        state: 'blocked',
        summary:
          'No database is configured. This service stores its tables inside a ' +
          'Postgres database you already run — it does not have one of its own.',
        action:
          'Set DATABASE_URL and DATABASE_READ_URL in the environment, then check again.',
      };
    }

    if (status.stage === 'unreachable') {
      return {
        ...base,
        state: 'blocked',
        summary: status.error ?? 'The database could not be reached.',
        action: 'Fix the connection and check again.',
      };
    }

    return {
      ...base,
      state: 'done',
      summary: `Connected. The agent's tables live in the "${status.schema}" schema.`,
      action: null,
    };
  }

  private tablesStep(
    status: ReturnType<PrimaryDb['getStatus']>,
    revealDetail: boolean,
  ): SetupStep {
    const base = {
      id: 'tables' as const,
      title: 'Create the agent tables',
      blocking: true,
      detail: revealDetail ? status.detail : null,
    };

    if (status.stage === 'not-configured' || status.stage === 'unreachable') {
      return {
        ...base,
        state: 'pending',
        summary: 'Waiting for a database connection.',
        action: null,
      };
    }

    if (status.stage === 'tables-missing') {
      return {
        ...base,
        state: 'blocked',
        summary:
          status.error ??
          'The agent tables are missing and could not be created automatically.',
        action:
          'Run the SQL below as a role that may create objects, then check again.',
      };
    }

    return {
      ...base,
      state: 'done',
      summary: `All ${AGENT_TABLES.length} agent_* tables exist in "${status.schema}".`,
      action: null,
    };
  }

  private readStep(
    status: ReturnType<ReadDb['getStatus']>,
    revealDetail: boolean,
  ): SetupStep {
    const base = {
      id: 'read' as const,
      title: 'Add the read-only connection',
      // Deliberately not blocking. Without it the agent cannot answer anything,
      // but an operator should still be able to get in and see that fact
      // written down rather than meeting a locked door.
      blocking: false,
      detail: revealDetail ? status.detail : null,
    };

    if (status.stage === 'ready') {
      return {
        ...base,
        state: 'done',
        summary:
          'Connected, and proven unable to write. This is what makes ' +
          'administrator-authored SQL safe to run.',
        action: null,
      };
    }

    return {
      ...base,
      state: 'blocked',
      summary: status.error ?? 'The read-only connection is not available.',
      action:
        status.stage === 'writable'
          ? 'Point DATABASE_READ_URL at a SELECT-only role, then check again.'
          : 'Create a read-only role with the SQL below and set DATABASE_READ_URL to it.',
    };
  }

  private accountStep(
    adminCount: number | null,
    databaseReady: boolean,
  ): SetupStep {
    const base = {
      id: 'account' as const,
      title: 'Create the administrator account',
      detail: null,
      blocking: true,
    };

    if (!databaseReady || adminCount === null) {
      return {
        ...base,
        state: 'pending',
        summary: 'Waiting for the database, which is where the account is stored.',
        action: null,
      };
    }

    if (adminCount > 0) {
      return {
        ...base,
        state: 'done',
        summary: `${adminCount} operator account(s) exist. Setup is finished.`,
        action: null,
      };
    }

    return {
      ...base,
      state: 'blocked',
      summary:
        'No operator account exists yet. The first one owns this deployment: it ' +
        'can read every conversation and change what the agent may do.',
      action: 'Choose an email address and a password of at least 12 characters.',
    };
  }

  private warn(what: string, error: unknown): void {
    this.logger.warn(
      `Setup re-check: ${what} failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The grants a read-only role needs. Shown in the setup screen and the guide. */
export function buildReadRoleSql(database: string, schema = 'public'): string {
  return `-- A role that can read everything the agent should see, and write nothing.
-- Run as a database owner. Choose your own password.

CREATE ROLE ori_reader LOGIN PASSWORD 'choose-a-strong-password';

GRANT CONNECT ON DATABASE ${quoteLiteralIdent(database)} TO ori_reader;
GRANT USAGE   ON SCHEMA ${quoteLiteralIdent(schema)} TO ori_reader;
GRANT SELECT  ON ALL TABLES IN SCHEMA ${quoteLiteralIdent(schema)} TO ori_reader;

-- Tables created later should be readable too, without repeating this.
ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteLiteralIdent(schema)}
  GRANT SELECT ON TABLES TO ori_reader;

-- A seatbelt, not the guarantee: any client can undo it with
-- SET TRANSACTION READ WRITE. The guarantee is that no write privilege was
-- granted above, which the service verifies before it opens the connection.
ALTER ROLE ori_reader SET default_transaction_read_only = on;

-- Then set:
--   DATABASE_READ_URL=postgres://ori_reader:choose-a-strong-password@host:5432/${database}`;
}

/** Quotes an identifier for display in generated SQL. */
function quoteLiteralIdent(value: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}
