/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The renderer is a browser module, so it is loaded as source and evaluated
 * against jsdom rather than imported. That keeps it a plain ES module with no
 * build step — which is the point of the console — while still being testable.
 */
const SOURCE = readFileSync(
  join(__dirname, '..', '..', 'public', 'markdown.js'),
  'utf8',
);

/*
 * Evaluated rather than imported. Jest cannot resolve a `data:` module URL, and
 * adding a bundler to test one 200-line file would defeat the reason the console
 * has no build step. Dropping the `export` keywords leaves plain function
 * declarations, which `new Function` can hand straight back — and it runs
 * against jsdom's real DOM, so the assertions are about actual nodes.
 */
const renderMarkdown = (
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- The input is a file from this repository, read at test time; there is no untrusted string anywhere near it. The rule is guarding against evaluating request data, which this is not.
  new Function(
    `${SOURCE.replace(/^export\s+/gm, '')}\nreturn { renderMarkdown, setMarkdown };`,
  )() as { renderMarkdown: (source: string) => DocumentFragment }
).renderMarkdown;

function render(source: string): HTMLElement {
  const host = document.createElement('div');
  host.append(renderMarkdown(source));
  return host;
}

describe('markdown tables', () => {
  const TABLE = [
    '| Name | Programme | Status |',
    '| --- | --- | --- |',
    '| Priya Sharma | College Students | Completed |',
    '| Raj Kumar | School Students | In progress |',
  ].join('\n');

  it('renders a pipe table', () => {
    const host = render(TABLE);
    const table = host.querySelector('table.md-table');

    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('thead th')).toHaveLength(3);
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table!.querySelectorAll('tbody tr')[0]!.textContent).toContain(
      'Priya Sharma',
    );
  });

  it('labels cells so a narrow screen can show them as cards', () => {
    const cell = render(TABLE).querySelector('tbody td');
    expect(cell!.getAttribute('data-label')).toBe('Name');
  });

  it('scrolls inside its own container rather than widening the page', () => {
    expect(render(TABLE).querySelector('.md-tablewrap')).not.toBeNull();
  });

  it('honours column alignment', () => {
    const host = render(
      ['| L | C | R |', '| :-- | :-: | --: |', '| a | b | c |'].join('\n'),
    );
    const headers = [...host.querySelectorAll('th')];

    expect(headers[0]!.style.textAlign).toBe('left');
    expect(headers[1]!.style.textAlign).toBe('center');
    expect(headers[2]!.style.textAlign).toBe('right');
  });

  it('renders inline markup inside cells', () => {
    const host = render(
      ['| Name | Link |', '| --- | --- |', '| **Priya** | [doc](https://example.com) |'].join('\n'),
    );

    expect(host.querySelector('td strong')!.textContent).toBe('Priya');
    expect(host.querySelector('td a')!.getAttribute('href')).toBe(
      'https://example.com',
    );
  });

  it('does not linkify a javascript: URL in a cell', () => {
    const host = render(
      ['| A |', '| --- |', '| [x](javascript:alert(1)) |'].join('\n'),
    );
    expect(host.querySelector('td a')).toBeNull();
  });

  it('treats a sentence containing a pipe as a paragraph', () => {
    // The delimiter row is what makes a table a table. Without this check, any
    // answer mentioning "a | b" would be swallowed as malformed markup.
    const host = render('The separator is a | character in most shells.');

    expect(host.querySelector('table')).toBeNull();
    expect(host.textContent).toContain('a | character');
  });

  it('needs the delimiter row to match the header width', () => {
    const host = render(['| A | B |', '| --- |', '| 1 | 2 |'].join('\n'));
    expect(host.querySelector('table')).toBeNull();
  });

  it('handles optional outer pipes', () => {
    const host = render(['A | B', '--- | ---', '1 | 2'].join('\n'));

    expect(host.querySelectorAll('th')).toHaveLength(2);
    expect(host.querySelectorAll('tbody td')).toHaveLength(2);
  });

  it('keeps an escaped pipe as a literal', () => {
    const host = render(['| A |', '| --- |', String.raw`| a \| b |`].join('\n'));
    expect(host.querySelector('td')!.textContent).toBe('a | b');
  });

  it('pads a short row rather than dropping the columns', () => {
    const host = render(['| A | B | C |', '| --- | --- | --- |', '| 1 |'].join('\n'));
    expect(host.querySelectorAll('tbody td')).toHaveLength(3);
  });

  it('stops at the blank line after the table', () => {
    const host = render(`${TABLE}\n\nAnd that is everything.`);

    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(host.textContent).toContain('And that is everything.');
  });
});

describe('markdown emphasis', () => {
  it('leaves snake_case alone', () => {
    // find_user needs one of: email, user_id — two underscores that used to
    // become one italic run, silently deleting them from a value.
    const host = render('find_user needs one of: email, user_id.');

    expect(host.querySelector('em')).toBeNull();
    expect(host.textContent).toContain('find_user');
    expect(host.textContent).toContain('user_id');
  });

  it('still italicises a real _emphasis_ run', () => {
    expect(render('that is _important_ to note').querySelector('em')!.textContent)
      .toBe('important');
  });
});
