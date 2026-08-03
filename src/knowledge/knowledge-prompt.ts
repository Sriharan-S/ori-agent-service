import type { Passage } from './retrieval.service';

/**
 * How retrieved passages are put in front of a model.
 *
 * There are three consumers and they need three different framings, which is
 * why this is not one function. The loop is deciding what to *call*, so its
 * passages are background — useful for mapping a user's vocabulary onto a
 * function, dangerous if mistaken for an answer. The synthesizer is writing
 * prose and may quote them as fact. The document-only path is answering
 * entirely from them and must say where each claim came from.
 *
 * The distinction is load-bearing. A model given documentation while it is
 * choosing a function will, if the framing allows it, answer from the
 * documentation instead of looking anything up — and confidently report a
 * balance from a worked example in a PDF.
 */

const MAX_PASSAGE_CHARS = 900;

/**
 * Context for the agent loop.
 *
 * Framed as vocabulary and background, with an explicit instruction not to
 * treat it as data. Notably it does *not* say "answer from this": the loop's
 * only job is choosing functions, and every fact it reports must still come
 * from one.
 */
export function formatGrounding(passages: Passage[]): string {
  if (passages.length === 0) return '';

  const body = passages
    .map((passage) => `- ${label(passage)}: ${clip(passage.content)}`)
    .join('\n');

  return `${body}

This is background about how this application works — what its terms mean and
how the pieces relate. Use it to work out which function answers the question
and what the user's words refer to.

It is documentation, not data. It is not current, it is not about any specific
record, and nothing in it is an answer. Never report a number, a name, a status
or a date from it. If the user is asking about a real record, look it up.`;
}

/**
 * Context for the synthesizer, alongside real function results.
 *
 * This is where "explain what the Agile Compatibility Index actually is" comes
 * from: the results supply the score, the passages supply what the score means.
 * The precedence rule is explicit because the two can disagree — a document
 * describing last quarter's bands against a live score computed under this
 * quarter's — and the live result has to win.
 */
export function formatReference(passages: Passage[]): string {
  if (passages.length === 0) return '';

  const body = passages
    .map((passage) => `- ${label(passage)}: ${clip(passage.content)}`)
    .join('\n');

  return `
═══ BACKGROUND ═══
${body}

Use this only to explain or give context to the facts above — what a term means,
how something works, what a range signifies. The facts above always win: if this
disagrees with them, it is out of date and you ignore it. Never take a number, a
name, a date or a status from here. Do not mention that you were given
background, and do not pad the answer with it when the question did not call for
it.`;
}

/**
 * The document-only answer.
 *
 * Used when no function fits the question but the documentation covers it. This
 * is the one place the agent answers without touching live data, so it is also
 * the only place a citation is required — a reader has to be able to tell
 * "your documentation says this" from "your records say this".
 */
export function formatSources(passages: Passage[]): string {
  return passages
    .map((passage, index) => `[${index + 1}] ${label(passage)}\n${clip(passage.content)}`)
    .join('\n\n');
}

function label(passage: Passage): string {
  return passage.heading && passage.heading !== passage.title
    ? `${passage.title} — ${passage.heading}`
    : passage.title;
}

/**
 * Passages are already chunk-sized, but a chunk that ran to the ceiling plus
 * five of its friends is most of a context window. Cut on a sentence so the
 * tail is not a fragment the model might complete for itself.
 */
function clip(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_PASSAGE_CHARS) return text;

  const cut = text.slice(0, MAX_PASSAGE_CHARS);
  const lastStop = cut.lastIndexOf('. ');
  return `${lastStop > MAX_PASSAGE_CHARS / 2 ? cut.slice(0, lastStop + 1) : cut}…`;
}
