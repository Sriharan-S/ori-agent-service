import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TABLES } from '../../src/db/migrations';

const SRC = join(__dirname, '..', '..', 'src');

/**
 * Every table this service owns is named `agent_*`, and every query has to say
 * so.
 *
 * This exists because getting it wrong is silent. Three writes were missed when
 * the prefix was introduced — the audit insert, both run-record statements, and
 * the service-registry lookup — and each of them is wrapped in a catch that
 * deliberately swallows failures so observability cannot break the request it
 * observes. The result was a service that answered correctly while recording
 * nothing: no audit trail, no run history, and every HTTP write action unable
 * to resolve its target.
 *
 * Nothing failed. Nothing was logged loudly enough to notice. Only querying the
 * database directly showed it. So the rule gets a test rather than a comment.
 */

/** The pre-prefix names, which may only appear in the code that renames them. */
const LEGACY_NAMES = AGENT_TABLES.map((table) => table.replace(/^agent_/, ''));

/**
 * `PrimaryDb.adoptLegacyBookkeeping` and migration `0000_prefix_legacy_tables`
 * refer to the old names by necessity — that is what they are for.
 */
const RENAME_PATHS = [join('db', 'primary.db.ts'), join('db', 'migrations.ts')];

function collectTypeScriptFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...collectTypeScriptFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }

  return found;
}

/** A table name that directly follows a schema interpolation. */
const QUALIFIED = /\$\{[^}]+\}\.([a-z_][a-z0-9_]*)/g;

describe('the agent addresses its own tables by their prefixed names', () => {
  const files = collectTypeScriptFiles(SRC);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((file) => [file.slice(SRC.length + 1), file]))(
    '%s',
    (label, file) => {
      const offenders: string[] = [];

      for (const match of readFileSync(file, 'utf8').matchAll(QUALIFIED)) {
        const table = match[1] ?? '';
        if (table.startsWith('agent_')) continue;
        if (!LEGACY_NAMES.includes(table)) continue;
        offenders.push(table);
      }

      const isRenamePath = RENAME_PATHS.some((path) => label.endsWith(path));
      expect(isRenamePath ? [] : offenders).toEqual([]);
    },
  );

  it('reaches every table it creates', () => {
    // A table nothing queries is either dead weight or a rename that was missed
    // on the read side, which looks identical from the outside.
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');

    const unreferenced = AGENT_TABLES.filter(
      (table) => !source.includes(`.${table}`),
    );

    expect(unreferenced).toEqual([]);
  });
});
