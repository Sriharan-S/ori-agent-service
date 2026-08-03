export interface Chunk {
  ordinal: number;
  /** Nearest preceding heading, when the document has any. */
  heading: string | null;
  content: string;
}

/*
 * Sized for a 512-token embedder, which is what most of the small retrieval
 * models are — bge, e5, gte and the rest all cap there.
 *
 * English prose runs about four characters per token, so 1000 characters is
 * roughly 250 tokens and the 1500 ceiling roughly 375. That leaves real headroom
 * for the title, the heading and an instruction prefix, all of which are counted
 * too. The earlier 1800 was fine for prose and quietly wrong for the dense
 * material people also upload: CSV, tables and code run nearer 2.5 characters
 * per token, where 1800 characters is over 700 tokens. The provider does not
 * error on that — it embeds the first 512 and discards the rest, so the index
 * silently loses the tail of exactly the passages that were densest with facts.
 */
const TARGET_CHARS = 1000;
const MAX_CHARS = 1500;
const OVERLAP_CHARS = 150;

/**
 * Split a document into passages worth retrieving one at a time.
 *
 * Retrieval quality is decided here more than anywhere downstream. A chunk that
 * spans two unrelated topics matches both and answers neither; a chunk cut mid
 * sentence loses the subject of its own pronouns. So the split follows the
 * document's own structure — headings first, then paragraphs, then sentences —
 * and only falls back to a hard character cut for text that has no structure at
 * all, such as a PDF table extracted as one long line.
 *
 * Each chunk carries its nearest heading. That single line is often the only
 * thing establishing what a passage is *about*: "Credits are consumed when an
 * assessment starts" is much more findable under "Billing" than on its own.
 */
export function chunkDocument(text: string, title: string): Chunk[] {
  const chunks: Chunk[] = [];
  let heading: string | null = null;

  for (const section of splitByHeading(text)) {
    if (section.heading !== null) heading = section.heading;

    for (const body of packParagraphs(section.body)) {
      chunks.push({
        ordinal: chunks.length,
        heading: heading ?? null,
        // The title is prepended to the stored text, not kept beside it: both
        // the tsvector and the embedding are computed over this string, so a
        // passage from "Refund policy" is findable by that phrase even when the
        // words never occur in the passage itself.
        content: withContext(title, heading, body),
      });
    }
  }

  return chunks;
}

function withContext(
  title: string,
  heading: string | null,
  body: string,
): string {
  const prefix =
    heading && heading.toLowerCase() !== title.toLowerCase()
      ? `${title} — ${heading}`
      : title;
  return `${prefix}\n\n${body}`;
}

interface Section {
  heading: string | null;
  body: string;
}

/**
 * Markdown ATX headings, and the underlined and ALL-CAPS forms that pasted
 * documents use instead. A line is only a heading if it is short — a long
 * sentence in capitals is someone shouting, not a section title.
 */
function splitByHeading(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];

  let heading: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    const joined = body.join('\n').trim();
    if (joined.length > 0) sections.push({ heading, body: joined });
    body = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];

    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    const underlined =
      next !== undefined &&
      /^\s{0,3}[=-]{3,}\s*$/.test(next) &&
      line.trim().length > 0 &&
      line.trim().length <= 100;
    const shouted =
      /^[A-Z0-9][A-Z0-9 ,'&()/-]{2,60}$/.test(line.trim()) &&
      /[A-Z]{2,}/.test(line);

    if (atx || underlined || shouted) {
      flush();
      heading = (atx ? atx[2]! : line).trim();
      if (underlined) index += 1;
      continue;
    }

    body.push(line);
  }

  flush();
  return sections.length > 0 ? sections : [{ heading: null, body: text.trim() }];
}

/** Fill chunks to roughly TARGET_CHARS on paragraph boundaries. */
function packParagraphs(body: string): string[] {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const packed: string[] = [];
  let current = '';

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) packed.push(trimmed);
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHARS) {
      push();
      packed.push(...splitLongParagraph(paragraph));
      continue;
    }

    if (current.length + paragraph.length + 2 > TARGET_CHARS && current !== '') {
      push();
    }

    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
  }

  push();
  return packed;
}

/**
 * A paragraph too long to be a chunk, cut on sentences with a little overlap.
 *
 * The overlap is what keeps a fact that straddles the cut retrievable: without
 * it, "This expires after 30 days." landing alone at the top of the next chunk
 * has lost what "this" refers to, and matches nothing anybody would type.
 */
function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+[\])'"`’”]*\s*|[^.!?]+$/g) ?? [
    paragraph,
  ];

  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > TARGET_CHARS && current !== '') {
      parts.push(current.trim());
      const tail = current.slice(-OVERLAP_CHARS);
      const boundary = tail.search(/[.!?]\s/);
      current = boundary === -1 ? '' : tail.slice(boundary + 2);
    }
    current += sentence;
  }

  if (current.trim().length > 0) parts.push(current.trim());

  // A single sentence longer than the ceiling — a table row, a minified blob.
  // Nothing structural is left to cut on, so cut on length.
  return parts.flatMap((part) =>
    part.length <= MAX_CHARS ? [part] : hardSplit(part),
  );
}

function hardSplit(text: string): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += TARGET_CHARS) {
    parts.push(text.slice(index, index + TARGET_CHARS));
  }
  return parts;
}
