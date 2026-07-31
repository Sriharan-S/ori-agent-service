/**
 * Turning query results into something a person can be told.
 *
 * The synthesizer used to receive raw rows — `payment_status: "NOT_REQUIRED"`,
 * `created_at: "2026-01-29T03:05:57.389Z"`, `has_ai_counsellor: false` — and it
 * answered in that vocabulary, because that was the only vocabulary it had. Real
 * answers came out as *"It only shows program, registration status, payment
 * status, AI counsellor flag, and creation date"*, which is a description of a
 * database row, not an answer to a question.
 *
 * Prompting alone does not fix that reliably: a model asked not to mention a
 * field name, while looking at field names, will sometimes mention them anyway.
 * So the fix is upstream of the prompt — the model never sees the column names.
 * It sees labels, readable dates, and enum values as English.
 *
 * The rules are deliberately generic. Nothing here knows about OriginBI or any
 * other product: it works on the shape of the value, not on a list of known
 * columns, so a function written tomorrow benefits without an edit here.
 */

/** Columns that exist for the engine, not for the reader. */
const ENGINE_COLUMNS = new Set([
  'ori_total',
  'match_score',
  'label',
  'detail',
]);

/**
 * Keys that are internal identifiers. Kept out of the evidence entirely: a user
 * asking about their assessment does not want to be told a row id, and once a
 * model has seen one it tends to quote it.
 *
 * `id` itself is kept — a lookup's resolved id is sometimes genuinely the
 * answer ("what is my report number") — but anything ending `_id` is a foreign
 * key, which never is.
 */
function isInternalIdentifier(key: string): boolean {
  return /_id$/.test(key) || key === 'uuid' || /(^|_)(cognito_sub|password|hash|token|secret|url)$/.test(key);
}

/** `session_status` → `Session status`. */
export function humaniseKey(key: string): string {
  const stripped = key.replace(/_/g, ' ').trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * `NOT_REQUIRED` → `not required`, `PARTIALLY_EXPIRED` → `partially expired`.
 *
 * Only applied to values that look like enum constants — all caps with
 * underscores — so a genuine code like `OBI-G27-01/26-COLLEGE_STUDENT-065` is
 * left exactly as it is. Report numbers are quoted back to users verbatim and
 * mangling one would be worse than leaving an enum shouty.
 */
export function humaniseEnum(value: string): string {
  if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(value) && !/^[A-Z]{3,}$/.test(value)) {
    return value;
  }
  return value.toLowerCase().replace(/_/g, ' ');
}

/** An ISO timestamp becomes `29 January 2026`; a date-only value keeps its day. */
function humaniseDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value)) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function humaniseValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    return humaniseDate(trimmed) ?? humaniseEnum(trimmed);
  }

  if (Array.isArray(value)) {
    const parts = value.map(humaniseValue).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  if (typeof value === 'object') {
    // Nested JSON (a jsonb column) is summarised rather than dumped: a wall of
    // nested keys is exactly the thing that ends up quoted back at the user.
    const inner = describeRecord(value as Record<string, unknown>);
    return inner.length > 0 ? inner : null;
  }

  return null;
}

/** `Full name: Priya Sharma · Program: College Students` */
function describeRecord(record: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, raw] of Object.entries(record)) {
    if (ENGINE_COLUMNS.has(key)) continue;
    if (isInternalIdentifier(key)) continue;

    const value = humaniseValue(raw);
    if (value === null) continue;

    parts.push(`${humaniseKey(key)}: ${value}`);
  }

  return parts.join(' · ');
}

/**
 * A record rendered for the model, or null when nothing survived.
 *
 * Returns null rather than an empty string so a caller can tell "this row had
 * nothing worth saying" from "this row said nothing" — the difference matters
 * when deciding whether an answer is possible at all.
 */
export function presentRecord(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return humaniseValue(value);

  const described = describeRecord(value as Record<string, unknown>);
  return described.length > 0 ? described : null;
}

/**
 * The full evidence block, as numbered facts.
 *
 * Numbered rather than JSON because the shape is then obviously a list of
 * statements about the world, not a data structure to be described. That framing
 * does as much work as the wording of the prompt.
 */
export function presentRecords(rows: readonly unknown[], limit = 40): string {
  const lines: string[] = [];

  for (const row of rows.slice(0, limit)) {
    const described = presentRecord(row);
    if (described !== null) lines.push(`${lines.length + 1}. ${described}`);
  }

  if (rows.length > limit) {
    lines.push(`… and ${rows.length - limit} more not shown here.`);
  }

  return lines.join('\n');
}
