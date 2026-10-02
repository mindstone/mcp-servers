/**
 * Minimal, namespace-agnostic XML reader for WebDAV/CalDAV multistatus bodies.
 *
 * Why hand-rolled rather than a dependency:
 *
 *  - CalDAV servers disagree about namespace PREFIXES, not element names.
 *    Alibaba answers with `D:`/`C:` (uppercase), others with `d:`/`cal:`/none.
 *    Everything this connector reads is identified by LOCAL name, so the
 *    reader drops prefixes entirely instead of resolving namespace URIs.
 *  - It never processes a DTD or an entity declaration, so XXE and
 *    entity-expansion ("billion laughs") attacks are impossible by
 *    construction rather than by configuration. `<!DOCTYPE …>` is skipped
 *    verbatim and only the five predefined entities plus numeric character
 *    references are decoded.
 *  - Adding a runtime dependency to a published connector needs a
 *    justification (root AGENTS.md "Keep runtime dependencies minimal"); a
 *    120-line tolerant reader for one document shape does not clear that bar.
 *
 * Malformed input FAILS LOUD with a structured error — a tolerant
 * "return what we got" reader would turn a broken response into an empty
 * calendar list, which is exactly the silent-failure class this connector
 * already fixed once in email search.
 */

import { EmailImapError } from '../types.js';

/** Hard ceilings: the HTTP layer already caps the body, these cap the shape. */
const MAX_DEPTH = 100;
const MAX_ELEMENTS = 200_000;

export interface XmlElement {
  /** Local element name, lower-cased (`D:href` and `d:HREF` both → `href`). */
  name: string;
  /** Attributes by lower-cased local name; values keep their original case. */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Direct text content, entity-decoded and concatenated. */
  text: string;
}

function badXml(detail: string): EmailImapError {
  return new EmailImapError(
    `The calendar server returned a response this connector could not parse as XML (${detail}).`,
    'CALDAV_BAD_RESPONSE',
    'Confirm EMAIL_IMAP_CALDAV_URL points at a CalDAV endpoint (not a webmail page or a proxy login screen).',
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode the five predefined XML entities and numeric character references.
 * Unknown entities are left verbatim: a CalDAV body that references a custom
 * entity is either broken or hostile, and silently dropping the reference
 * would corrupt event text.
 */
function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** `C:calendar-data` → `calendar-data`; `HREF` → `href`. */
function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(':');
  return (colon === -1 ? qualified : qualified.slice(colon + 1)).toLowerCase();
}

const NAME_CHARS = /[^\s/>=]/;

/**
 * Skip a `<!…>` construct (DOCTYPE, notation, …) without interpreting it.
 * A DOCTYPE's internal subset may itself contain `>`, so bracket nesting is
 * tracked; nothing inside is ever evaluated.
 */
function skipBangConstruct(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
    else if (char === '>' && depth <= 0) return i + 1;
  }
  throw badXml('unterminated declaration');
}

function parseAttributes(
  source: string,
  from: number,
): { attrs: Record<string, string>; selfClosing: boolean; end: number } {
  const attrs: Record<string, string> = {};
  let i = from;

  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (i >= source.length) throw badXml('unterminated start tag');

    if (source[i] === '>') return { attrs, selfClosing: false, end: i + 1 };
    if (source.startsWith('/>', i)) return { attrs, selfClosing: true, end: i + 2 };

    const nameStart = i;
    while (i < source.length && NAME_CHARS.test(source[i])) i += 1;
    if (i === nameStart) throw badXml(`unexpected character "${source[i]}" in start tag`);
    const name = localName(source.slice(nameStart, i));

    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== '=') {
      // Valueless attributes are HTML, not XML.
      throw badXml(`attribute "${name}" has no value`);
    }
    i += 1;
    while (i < source.length && /\s/.test(source[i])) i += 1;

    const quote = source[i];
    if (quote !== '"' && quote !== "'") throw badXml(`attribute "${name}" value is not quoted`);
    const valueStart = i + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd === -1) throw badXml(`attribute "${name}" value is unterminated`);
    attrs[name] = decodeEntities(source.slice(valueStart, valueEnd));
    i = valueEnd + 1;
  }
}

/**
 * Parse an XML document into a tree keyed by local element names.
 * Throws `EmailImapError` (code `CALDAV_BAD_RESPONSE`) on malformed input.
 */
export function parseXml(source: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let elements = 0;
  let i = 0;

  while (i < source.length) {
    if (source[i] !== '<') {
      const next = source.indexOf('<', i);
      const end = next === -1 ? source.length : next;
      const current = stack[stack.length - 1];
      if (current) current.text += decodeEntities(source.slice(i, end));
      i = end;
      continue;
    }

    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i);
      if (end === -1) throw badXml('unterminated processing instruction');
      i = end + 2;
      continue;
    }

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      if (end === -1) throw badXml('unterminated comment');
      i = end + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i);
      if (end === -1) throw badXml('unterminated CDATA section');
      const current = stack[stack.length - 1];
      // CDATA is literal by definition — no entity decoding.
      if (current) current.text += source.slice(i + 9, end);
      i = end + 3;
      continue;
    }

    if (source.startsWith('<!', i)) {
      i = skipBangConstruct(source, i + 2);
      continue;
    }

    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      if (end === -1) throw badXml('unterminated end tag');
      const name = localName(source.slice(i + 2, end).trim());
      const open = stack.pop();
      if (!open) throw badXml(`end tag "${name}" with no matching start tag`);
      if (open.name !== name) throw badXml(`end tag "${name}" does not close "${open.name}"`);
      i = end + 1;
      continue;
    }

    // Start tag.
    let nameEnd = i + 1;
    while (nameEnd < source.length && NAME_CHARS.test(source[nameEnd])) nameEnd += 1;
    if (nameEnd === i + 1) throw badXml('empty element name');
    const element: XmlElement = {
      name: localName(source.slice(i + 1, nameEnd)),
      attrs: {},
      children: [],
      text: '',
    };

    const { attrs, selfClosing, end } = parseAttributes(source, nameEnd);
    element.attrs = attrs;

    elements += 1;
    if (elements > MAX_ELEMENTS) throw badXml('document has too many elements');

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) throw badXml('document has more than one root element');
    else root = element;

    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_DEPTH) throw badXml('document is nested too deeply');
    }
    i = end;
  }

  if (stack.length > 0) throw badXml(`element "${stack[stack.length - 1].name}" is never closed`);
  if (!root) throw badXml('document has no root element');
  return root;
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function childNamed(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** Every descendant with this local name, in document order (self excluded). */
export function descendantsNamed(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const stack: XmlElement[] = [...element.children].reverse();
  while (stack.length > 0) {
    const next = stack.pop() as XmlElement;
    if (next.name === name) found.push(next);
    for (let i = next.children.length - 1; i >= 0; i -= 1) stack.push(next.children[i]);
  }
  return found;
}

/** First descendant with this local name, or `undefined`. */
export function descendantNamed(element: XmlElement, name: string): XmlElement | undefined {
  return descendantsNamed(element, name)[0];
}
