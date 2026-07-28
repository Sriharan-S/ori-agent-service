import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { ReadDb } from '../db/read.db';
import type { RequestContext } from '../auth/identity';
import { decideAmbiguity, type ScoredMatch } from './ambiguity';
import type {
  FunctionDefinition,
  FunctionResult,
} from './function.contract';
import {
  applyRowBounds,
  compileSqlTemplate,
  SqlTemplateError,
  TOTAL_COLUMN,
} from './sql-template';

export interface RunOutcome {
  result: FunctionResult;
  scopesApplied: Record<string, string | number>;
  rowCount: number;
}

/**
 * Executes a read function.
 *
 * Nothing in here is specific to what the function does. It compiles the
 * author's template with the caller's parameters and scope values, bounds the
 * result, runs it on the read-only connection, and shapes the rows according to
 * the declared return type.
 *
 * The ambiguity decision uses the same shared helper for every function, so
 * "which one did you mean" behaves identically everywhere and is tuned in one
 * place.
 */
@Injectable()
export class SqlFunctionRunner {
  private readonly logger = new Logger(SqlFunctionRunner.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly readDb: ReadDb,
  ) {}

  async run(
    definition: FunctionDefinition,
    params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<RunOutcome> {
    if (!definition.sqlTemplate) {
      return {
        result: {
          status: 'error',
          message: 'This function has no query body.',
          retryable: false,
        },
        scopesApplied: {},
        rowCount: 0,
      };
    }

    const { limit, offset } = this.resolveBounds(definition, params);

    let compiled;
    try {
      compiled = compileSqlTemplate({
        template: definition.sqlTemplate,
        params,
        scopeFilters: definition.scopeFilters,
        scopeValues: context.endUser.scopes,
        unscopedKeys: context.role.unscopedKeys,
      });
    } catch (error) {
      // Almost always a missing scope value — the caller's role is not exempt
      // and the application did not supply one. Refusing is the point.
      if (error instanceof SqlTemplateError) {
        this.logger.warn(
          `${definition.name} refused for role ${context.role.name}: ${error.message}`,
        );
        return {
          result: {
            status: 'denied',
            reason: 'You do not have access to that information.',
          },
          scopesApplied: {},
          rowCount: 0,
        };
      }
      throw error;
    }

    // Ask for one more row than requested so truncation is knowable even when
    // the window count is unavailable.
    const bounded = applyRowBounds(compiled, limit, offset);

    let rows: Array<Record<string, unknown>>;
    let total: number;
    try {
      const executed = await this.readDb.query<Record<string, unknown>>(
        bounded.sql,
        bounded.values,
        { label: definition.name },
      );
      rows = executed.rows;
      total = rows.length > 0 ? Number(rows[0]![TOTAL_COLUMN] ?? rows.length) : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`${definition.name} query failed: ${message}`);

      return {
        result: {
          status: 'error',
          message: /statement timeout|canceling statement/i.test(message)
            ? 'That lookup took too long and was stopped.'
            : 'That lookup failed unexpectedly.',
          retryable: true,
        },
        scopesApplied: compiled.scopesApplied,
        rowCount: 0,
      };
    }

    const clean = rows.map(stripEngineColumns);
    const searchedBy = describeSearch(params);

    if (clean.length === 0) {
      return {
        result: { status: 'empty', searchedBy },
        scopesApplied: compiled.scopesApplied,
        rowCount: 0,
      };
    }

    const result = this.shape(definition, clean, total, offset, searchedBy);

    return {
      result,
      scopesApplied: compiled.scopesApplied,
      rowCount: clean.length,
    };
  }

  private shape(
    definition: FunctionDefinition,
    rows: Array<Record<string, unknown>>,
    total: number,
    offset: number,
    searchedBy: string,
  ): FunctionResult {
    switch (definition.returns) {
      case 'list':
        return {
          status: 'list',
          data: rows,
          total,
          truncated: offset + rows.length < total,
        };

      case 'single':
        return { status: 'single', data: rows[0]!, confidence: 1 };

      case 'single-or-ambiguous':
        return this.shapeLookup(rows, searchedBy);

      case 'confirmation':
        return { status: 'single', data: rows[0]!, confidence: 1 };

      default:
        return { status: 'single', data: rows[0]!, confidence: 1 };
    }
  }

  /**
   * Turn rows into either one record or a question.
   *
   * The `id` / `label` / `detail` / `match_score` column contract is checked
   * when the function is saved, so by the time a lookup runs those columns are
   * known to exist. A row missing `match_score` scores 100, which means a set of
   * unscored rows is uniformly tied and therefore always asks — the safe
   * direction to fail in.
   */
  private shapeLookup(
    rows: Array<Record<string, unknown>>,
    searchedBy: string,
  ): FunctionResult {
    const matches: ScoredMatch[] = rows.map((row) => {
      const detail = scalar(row.detail);

      return {
        id: typeof row.id === 'number' ? row.id : scalar(row.id),
        label: scalar(row.label) || scalar(row.id),
        ...(detail ? { detail } : {}),
        score: row.match_score === undefined ? 100 : Number(row.match_score),
      };
    });

    const decision = decideAmbiguity(
      matches,
      searchedBy,
      {
        gapThreshold: this.config.behaviour.disambiguationGapThreshold,
        minConfidentScore: this.config.behaviour.disambiguationMinConfidentScore,
        shortTermLength: this.config.behaviour.disambiguationShortTermLength,
        shortTermMinScore:
          this.config.behaviour.disambiguationShortTermMinScore,
      },
      this.config.behaviour.maxCandidatesReturned,
    );

    if (decision.outcome === 'empty') {
      return { status: 'empty', searchedBy };
    }

    if (decision.outcome === 'ambiguous') {
      return {
        status: 'ambiguous',
        candidates: decision.candidates,
        searchedBy,
      };
    }

    const chosen =
      rows.find((row) => row.id === decision.match.id) ?? rows[0]!;

    return {
      status: 'single',
      data: chosen,
      confidence: decision.confidence,
    };
  }

  /**
   * Row bounds. The author may set a default and a cap per function; the
   * service-wide maximum still wins, so no single function can ask for
   * everything.
   */
  private resolveBounds(
    definition: FunctionDefinition,
    params: Record<string, unknown>,
  ): { limit: number; offset: number } {
    const { defaultRowLimit, maxRowLimit, maxCandidatesReturned } =
      this.config.behaviour;

    if (definition.returns === 'single-or-ambiguous') {
      return { limit: maxCandidatesReturned, offset: 0 };
    }
    if (definition.returns === 'single') {
      return { limit: 1, offset: 0 };
    }

    const ceiling = Math.min(definition.maxLimit ?? maxRowLimit, maxRowLimit);
    const fallback = Math.min(
      definition.defaultLimit ?? defaultRowLimit,
      ceiling,
    );

    const requested =
      typeof params.limit === 'number' ? params.limit : fallback;
    const offset = typeof params.offset === 'number' ? params.offset : 0;

    return {
      limit: Math.min(Math.max(Math.trunc(requested), 1), ceiling),
      offset: Math.max(Math.trunc(offset), 0),
    };
  }
}

function stripEngineColumns(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const { [TOTAL_COLUMN]: _total, ...rest } = row;
  return rest;
}

/**
 * Render a column value as a string for a candidate label.
 *
 * A registry function's SQL is author-written, so a column could hold anything
 * Postgres can produce — including json. `String(…)` on an object yields
 * "[object Object]", which would show a user an unreadable choice, so structured
 * values are serialised rather than coerced.
 */
function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? '';
}

/** A human-readable description of what was searched for, for empty results. */
function describeSearch(params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        value !== null &&
        value !== '' &&
        key !== 'limit' &&
        key !== 'offset',
    )
    .map(([key, value]) => `${key} "${String(value)}"`);

  return parts.length > 0 ? parts.join(', ') : 'those details';
}
