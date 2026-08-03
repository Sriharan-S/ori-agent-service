import type { FunctionResult } from '../registry/function.contract';
import { presentRecord, presentRecords } from './evidence';
import type { CallOutcome } from './orchestrator.types';

/**
 * What the model is told a tool returned.
 *
 * The rows themselves are rendered exactly as the synthesizer sees them — the
 * same humanised "Label: value" form, identifiers included. What differs is the
 * framing around them, and only that.
 *
 * An observation is read *while the model is still deciding what to do*, so it
 * carries mechanical detail the synthesizer must never see: the validator's
 * actual complaint, whether a retry is worth attempting, whether a call already
 * ran. Hand "needs at least one of: email, userid" to the synthesizer and it
 * repeats it at the user; withhold it from the loop and the loop makes the same
 * failing call twice.
 *
 * Note what is *not* different any more. Identifiers were once stripped from
 * the answer side and kept here, and that split caused two separate wrong-record
 * bugs — see the note in `evidence.ts`. Both readers now get the same facts.
 *
 * Artifacts stay withheld from both: a model that has seen a long signed URL
 * will eventually write a subtly different one.
 */
export function describeObservation(outcome: CallOutcome): string {
  const { result } = outcome;

  switch (result.status) {
    case 'single':
      return describeSingle(outcome, result);

    case 'list': {
      if (result.data.length === 0) {
        return 'No rows. Nothing matched those arguments.';
      }
      const shown = presentRecords(result.data, LIST_LIMIT);
      const header =
        result.total > result.data.length
          ? `${result.data.length} of ${result.total} rows:`
          : `${result.data.length} row(s):`;
      return truncate(`${header}\n${shown}`);
    }

    case 'ambiguous':
      // The loop stops here and the user is asked. Included for completeness —
      // resolving this by picking the top candidate is the one thing the agent
      // must never do.
      return (
        `Ambiguous: ${result.candidates.length} records matched ` +
        `${result.searchedBy}. Stopping to ask the user which one.`
      );

    case 'empty':
      return (
        `No rows. Nothing matched ${result.searchedBy}. Do not retry with the ` +
        'same arguments — either try a genuinely different function, or tell ' +
        'the user it was not found.'
      );

    case 'denied':
      return (
        `Denied. This caller may not do that: ${result.reason} ` +
        'Do not try another route to the same information.'
      );

    case 'error':
      return (
        `FAILED — nothing was created, changed or retrieved. ` +
        `${outcome.operatorDetail ?? result.message}` +
        (result.retryable
          ? ' Do not report this as pending or in progress; it did not happen.'
          : ' This will fail the same way again unless you change the arguments.')
      );

    default:
      return 'Failed for an unknown reason.';
  }
}

const LIST_LIMIT = 15;
const MAX_CHARS = 2000;

function describeSingle(
  outcome: CallOutcome,
  result: Extract<FunctionResult, { status: 'single' }>,
): string {
  const described = presentRecord(result.data);
  const artifacts = outcome.artifacts ?? [];

  // An action that produced a link has succeeded even when it returned no row
  // worth describing, and the model needs to know that so it stops rather than
  // retrying. It is told one exists, never what it says.
  const artifactNote =
    artifacts.length > 0
      ? ` The user will be given: ${artifacts
          .map((artifact) => artifact.label.toLowerCase())
          .join(', ')}. This is already handled — do not repeat the value and ` +
        'do not call anything else to produce it.'
      : '';

  if (described === null) {
    return `Done.${artifactNote || ' The action completed.'}`;
  }

  return truncate(`1 row:\n${described}${artifactNote}`);
}

/**
 * Observations accumulate across steps, so an unbounded one is a context leak
 * that gets worse every turn. Cut on a line boundary — half a "Label: value"
 * pair reads as a fact with a wrong value, which is worse than an obvious cut.
 */
function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;

  const cut = text.slice(0, MAX_CHARS);
  const lastBreak = cut.lastIndexOf('\n');
  const body = lastBreak > MAX_CHARS / 2 ? cut.slice(0, lastBreak) : cut;

  return `${body}\n… truncated. Ask the user to narrow the request if you need the rest.`;
}
