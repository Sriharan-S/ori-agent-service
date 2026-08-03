import { Injectable, Logger } from '@nestjs/common';

export interface ExtractedText {
  text: string;
  /** What the extractor understood the input to be. */
  kind: 'pdf' | 'word' | 'text' | 'markdown' | 'csv';
}

export class UnsupportedDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDocumentError';
  }
}

/**
 * Uploaded bytes to plain text.
 *
 * The parsers are loaded on first use rather than at import time. A PDF library
 * is a large dependency with a native-ish surface, and a service whose main job
 * is answering chat requests should not fail to boot because one of them is
 * unhappy — nor should it pay their startup cost on a deployment where nobody
 * ever uploads a PDF. A parser that cannot be loaded becomes a failed document
 * with a readable reason, which is a row in the console, not an outage.
 */
@Injectable()
export class ExtractorService {
  private readonly logger = new Logger(ExtractorService.name);

  async extract(
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<ExtractedText> {
    const kind = classify(filename, mimeType, buffer);

    switch (kind) {
      case 'pdf':
        return { text: normalise(await this.readPdf(buffer)), kind };
      case 'word':
        return { text: normalise(await this.readWord(buffer)), kind };
      default:
        return { text: normalise(this.readPlain(buffer)), kind };
    }
  }

  private async readPdf(buffer: Buffer): Promise<string> {
    let parse: (input: Buffer) => Promise<{ text: string }>;

    try {
      const loaded: unknown = await import('pdf-parse');
      parse = resolveDefault(loaded) as typeof parse;
    } catch (error) {
      this.logger.error(`pdf-parse could not be loaded: ${describe(error)}`);
      throw new UnsupportedDocumentError(
        'PDF support is not available on this deployment. Paste the text ' +
          'instead, or upload a Word or text file.',
      );
    }

    const parsed = await parse(buffer).catch((error: unknown) => {
      throw new UnsupportedDocumentError(
        `That PDF could not be read: ${describe(error)}`,
      );
    });

    if (!parsed.text.trim()) {
      throw new UnsupportedDocumentError(
        'That PDF has no extractable text. It is most likely a scan — run it ' +
          'through OCR first, or paste the text in directly.',
      );
    }

    return parsed.text;
  }

  private async readWord(buffer: Buffer): Promise<string> {
    let extractRawText: (input: {
      buffer: Buffer;
    }) => Promise<{ value: string }>;

    try {
      const loaded = (await import('mammoth')) as unknown as {
        extractRawText?: typeof extractRawText;
        default?: { extractRawText: typeof extractRawText };
      };
      const resolved = loaded.extractRawText ?? loaded.default?.extractRawText;
      if (!resolved) throw new Error('mammoth exposed no extractRawText');
      extractRawText = resolved;
    } catch (error) {
      this.logger.error(`mammoth could not be loaded: ${describe(error)}`);
      throw new UnsupportedDocumentError(
        'Word support is not available on this deployment. Save the document ' +
          'as text and upload that instead.',
      );
    }

    const parsed = await extractRawText({ buffer }).catch((error: unknown) => {
      throw new UnsupportedDocumentError(
        `That Word file could not be read: ${describe(error)}`,
      );
    });

    if (!parsed.value.trim()) {
      throw new UnsupportedDocumentError('That Word file contains no text.');
    }

    return parsed.value;
  }

  /**
   * Anything else, as UTF-8.
   *
   * A binary file that reached here is one the classifier did not recognise. It
   * is caught by looking for a NUL byte rather than by trusting the extension,
   * because "upload the .doc" and "upload the .docx" are the same sentence to
   * everyone except a parser.
   */
  private readPlain(buffer: Buffer): string {
    if (buffer.includes(0)) {
      throw new UnsupportedDocumentError(
        'That looks like a binary file rather than a document. Supported ' +
          'formats are PDF, Word (.docx), plain text, Markdown and CSV.',
      );
    }

    const text = buffer.toString('utf8');
    if (!text.trim()) {
      throw new UnsupportedDocumentError('That file is empty.');
    }

    return text;
  }
}

/**
 * `import()` of a CommonJS module puts the export under `default`, and under
 * `default.default` when TypeScript's interop has already unwrapped it once.
 * Both shapes occur depending on how the file was compiled, so both are tried.
 */
function resolveDefault(loaded: unknown): unknown {
  const first = (loaded as { default?: unknown }).default ?? loaded;
  return (first as { default?: unknown }).default ?? first;
}

function classify(
  filename: string,
  mimeType: string,
  buffer: Buffer,
): ExtractedText['kind'] {
  const extension = filename.toLowerCase().split('.').pop() ?? '';

  // Magic bytes first: a PDF renamed to .txt is still a PDF, and reading it as
  // UTF-8 produces a page of mojibake that then gets embedded and searched.
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (
    buffer.subarray(0, 2).toString('latin1') === 'PK' &&
    (extension === 'docx' || mimeType.includes('wordprocessingml'))
  ) {
    return 'word';
  }

  if (extension === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  if (extension === 'docx' || mimeType.includes('wordprocessingml')) return 'word';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'csv' || mimeType === 'text/csv') return 'csv';

  return 'text';
}

/**
 * Whitespace as it will be stored.
 *
 * PDF extraction in particular produces ragged spacing and lone carriage
 * returns, and both the chunker's paragraph boundaries and the tsvector depend
 * on blank lines meaning what they look like they mean.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Non-breaking space, written as an escape so it is visible in review. PDF
    // extraction emits these liberally, and left alone they neither collapse
    // under the whitespace rules below nor split a word for the tsvector.
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
