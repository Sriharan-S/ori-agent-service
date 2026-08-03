export interface EmbeddingPrefixes {
  /** Prepended to the user's question before it is embedded. */
  query: string;
  /** Prepended to each stored passage before it is embedded. */
  passage: string;
}

export const NO_PREFIXES: EmbeddingPrefixes = { query: '', passage: '' };

/**
 * Instruction prefixes an embedding model was trained to expect.
 *
 * Most retrieval embedders are **asymmetric**: they were fine-tuned on pairs
 * where the question and the passage were marked differently, so that the
 * vector for "how much does it cost" lands near a passage about pricing rather
 * than near other questions about cost. Feed both sides the same bare text and
 * the model still works — it just works measurably worse, and silently, which
 * is the awkward part. There is no error, no warning, and no way to tell from
 * the outside that recall is a few points below what the model can do.
 *
 * The exact strings are not interchangeable. They are the literal text each
 * model saw during training, so `query: ` helps E5 and does nothing useful for
 * BGE. Using the wrong family's prefix is worse than using none.
 *
 * This table is only the *default*. An operator can override either side on the
 * model row, and an empty string there means "deliberately none" as distinct
 * from "not set" — see `resolvePrefixes`.
 */
const FAMILIES: Array<{
  /** Matched against a lowercased model id, so `@cf/baai/bge-…` matches `bge-`. */
  test: RegExp;
  prefixes: EmbeddingPrefixes;
}> = [
  // BAAI BGE, English v1 and v1.5. The query side carries the instruction and
  // the passage side is deliberately bare — that asymmetry is the design.
  {
    test: /bge-(small|base|large)-en/,
    prefixes: {
      query: 'Represent this sentence for searching relevant passages: ',
      passage: '',
    },
  },
  // BGE-M3 and the v2/ICL generation dropped the instruction prefix.
  { test: /bge-m3|bge-multilingual|bge-en-icl/, prefixes: NO_PREFIXES },

  // Microsoft E5, including the multilingual and instruct variants. Both sides
  // are prefixed here, and omitting them costs E5 more than most.
  {
    test: /(^|[/\-_])e5-|multilingual-e5|e5-mistral/,
    prefixes: { query: 'query: ', passage: 'passage: ' },
  },

  // Nomic. Distinct verbs rather than nouns.
  {
    test: /nomic-embed/,
    prefixes: { query: 'search_query: ', passage: 'search_document: ' },
  },

  // Google EmbeddingGemma uses a structured task prompt. The passage form
  // carries a title slot; `none` is what the model expects when there isn't one.
  {
    test: /embeddinggemma/,
    prefixes: {
      query: 'task: search result | query: ',
      passage: 'title: none | text: ',
    },
  },

  // Qwen3-Embedding takes an instruction on the query side only.
  {
    test: /qwen3-embedding/,
    prefixes: {
      query:
        'Instruct: Given a search query, retrieve relevant passages that answer it\nQuery: ',
      passage: '',
    },
  },

  // mxbai-embed-large was distilled against the BGE-style query instruction.
  {
    test: /mxbai-embed/,
    prefixes: {
      query: 'Represent this sentence for searching relevant passages: ',
      passage: '',
    },
  },

  // GTE and OpenAI's text-embedding-3 are symmetric — no prefix by design.
  { test: /gte-|text-embedding-3|text-embedding-ada/, prefixes: NO_PREFIXES },
];

/**
 * The prefixes a model id implies, or none when it is not a family we know.
 *
 * Returning `NO_PREFIXES` for an unrecognised model is the safe default: a
 * missing prefix costs a few points of accuracy, while a wrongly guessed one
 * actively misleads the model. Exported so the console can show an operator what
 * will be used before they save.
 */
export function defaultPrefixesFor(modelId: string): EmbeddingPrefixes {
  const id = modelId.toLowerCase();
  return FAMILIES.find((family) => family.test.test(id))?.prefixes ?? NO_PREFIXES;
}

/**
 * What to actually prepend, combining the stored overrides with the defaults.
 *
 * `null` and `undefined` mean "nothing was chosen, use what this model family
 * expects". An empty string means "no prefix, deliberately" — which an operator
 * needs to be able to say, because a provider that has already applied the
 * prefix server-side would otherwise get it twice.
 */
export function resolvePrefixes(
  modelId: string,
  query: string | null | undefined,
  passage: string | null | undefined,
): EmbeddingPrefixes {
  const fallback = defaultPrefixesFor(modelId);
  return {
    query: query ?? fallback.query,
    passage: passage ?? fallback.passage,
  };
}
