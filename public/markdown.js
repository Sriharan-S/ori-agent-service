/* A small markdown renderer for agent answers.
 *
 * Built from DOM nodes rather than innerHTML. The text being rendered came from
 * a language model, which in turn read rows from a database that end users can
 * put text into — so it is untrusted twice over, and assembling an HTML string
 * from it would be an injection waiting to happen. Creating elements and setting
 * textContent cannot inject anything, whatever the input says.
 *
 * It covers what answers actually contain: paragraphs, bullet and numbered
 * lists, bold, italic, inline code, and links. Not a general markdown
 * implementation, and deliberately not — anything it does not recognise is
 * shown as the literal text the model wrote, which is the honest failure mode.
 */

/**
 * `**bold**`, `*italic*`, `` `code` ``, and `[text](url)`, in one pass.
 *
 * The underscore forms require a non-word character on each outer edge, which
 * is what CommonMark specifies and what keeps snake_case intact. Without it,
 * any answer containing two underscored words joined them into one italic run:
 * `find_user needs one of: email, user_id` rendered as "finduser needs one of:
 * email, userid", silently deleting the underscores from values a user might
 * need to copy. Asterisk emphasis has no such rule because `*` does not occur
 * inside identifiers.
 */
const INLINE =
  /(\*\*[^*]+\*\*|(?<![A-Za-z0-9])__[^_]+__(?![A-Za-z0-9])|\*[^*\n]+\*|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9])|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

/** Only these schemes become real links. Anything else stays as text. */
function safeHref(url) {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

function renderInline(target, text) {
  for (const part of text.split(INLINE)) {
    if (!part) continue;

    if ((part.startsWith('**') && part.endsWith('**') && part.length > 4) ||
        (part.startsWith('__') && part.endsWith('__') && part.length > 4)) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      target.append(strong);
      continue;
    }

    if ((part.startsWith('*') && part.endsWith('*') && part.length > 2) ||
        (part.startsWith('_') && part.endsWith('_') && part.length > 2)) {
      const em = document.createElement('em');
      em.textContent = part.slice(1, -1);
      target.append(em);
      continue;
    }

    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      target.append(code);
      continue;
    }

    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      const href = safeHref(link[2]);
      if (href) {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = link[1];
        target.append(anchor);
      } else {
        // A javascript: or data: URL is shown, not linked.
        target.append(document.createTextNode(part));
      }
      continue;
    }

    target.append(document.createTextNode(part));
  }

  return target;
}

/**
 * Render markdown into a fresh fragment.
 *
 * Block handling is line-based: consecutive list items become one list, blank
 * lines separate paragraphs, and a run of ordinary lines becomes a single
 * paragraph with the line breaks preserved.
 */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');

  let index = 0;

  const isBullet = (line) => /^\s*[-*•]\s+/.test(line);
  const isNumbered = (line) => /^\s*\d+[.)]\s+/.test(line);

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') { index += 1; continue; }

    // Fenced code block.
    if (/^\s*```/.test(line)) {
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      const pre = document.createElement('pre');
      pre.className = 'md-code';
      pre.textContent = body.join('\n');
      fragment.append(pre);
      continue;
    }

    // Heading — rendered as bold text rather than an <h*>, so an answer cannot
    // restyle the surrounding page.
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      const paragraph = document.createElement('p');
      const strong = document.createElement('strong');
      renderInline(strong, heading[1]);
      paragraph.append(strong);
      fragment.append(paragraph);
      index += 1;
      continue;
    }

    if (isBullet(line) || isNumbered(line)) {
      const ordered = isNumbered(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      list.className = 'md-list';

      while (index < lines.length && (ordered ? isNumbered(lines[index]) : isBullet(lines[index]))) {
        const item = document.createElement('li');
        renderInline(item, lines[index].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
        list.append(item);
        index += 1;
      }

      fragment.append(list);
      continue;
    }

    // Ordinary paragraph: gather until a blank line or a block starts.
    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !isBullet(lines[index]) &&
      !isNumbered(lines[index]) &&
      !/^\s*```/.test(lines[index]) &&
      !/^\s*#{1,6}\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    const paragraph = document.createElement('p');
    paragraphLines.forEach((text, position) => {
      if (position > 0) paragraph.append(document.createElement('br'));
      renderInline(paragraph, text);
    });
    fragment.append(paragraph);
  }

  return fragment;
}

/** Replace an element's contents with rendered markdown. */
export function setMarkdown(element, source) {
  element.replaceChildren(renderMarkdown(source));
  return element;
}
