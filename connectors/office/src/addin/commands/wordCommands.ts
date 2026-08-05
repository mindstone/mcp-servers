/**
 * Word command handlers — maps sidecar command actions to Office.js API calls.
 * Each handler receives arbitrary params and returns a structured CommandResult.
 * Runs in the Office WebView (browser context).
 *
 * Requires WordApi 1.4+ for comment support.
 */

import { executeWordCommand, type CommandResult } from '../officeExecutor.js';

export type WordCommandHandler = (params: Record<string, unknown>) => Promise<CommandResult>;

const wordCommands: Record<string, WordCommandHandler> = {
  read_document: readDocument,
  get_document_structure: getDocumentStructure,
  get_selection: getSelection,
  find_text: findText,
  insert_text: insertText,
  replace_text: replaceText,
  format_text: formatText,
  apply_style: applyStyle,
  insert_table: insertTable,
  read_table: readTable,
  update_table_cell: updateTableCell,
  insert_image: insertImage,
  insert_break: insertBreak,
  set_header_footer: setHeaderFooter,
  get_properties: getProperties,
  get_comments: getComments,
  add_comment: addComment,
  resolve_comment: resolveComment,
  get_tracked_changes: getTrackedChanges,
  accept_reject_changes: acceptRejectChanges,
};

/**
 * Look up a Word command handler by action name.
 * Returns null if the action is not recognized.
 */
export function getWordCommandHandler(action: string): WordCommandHandler | null {
  return wordCommands[action] ?? null;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

interface ParagraphInfo {
  text: string;
  style: string;
  index: number;
  formatting?: {
    fontName?: string;
    fontSize?: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
  };
}

/**
 * read_document — Read paragraphs from the document body.
 * Params:
 *   maxParagraphs     (number, default 500) — cap on returned paragraphs
 *   startParagraph    (number, default 0)   — paragraph offset for pagination
 *   includeFormatting (boolean, default false) — include font/style metadata
 */
async function readDocument(params: Record<string, unknown>): Promise<CommandResult> {
  const maxParagraphs =
    typeof params['maxParagraphs'] === 'number' && params['maxParagraphs'] > 0
      ? params['maxParagraphs']
      : 500;
  const startParagraph =
    typeof params['startParagraph'] === 'number' && params['startParagraph'] >= 0
      ? params['startParagraph']
      : 0;
  const includeFormatting =
    typeof params['includeFormatting'] === 'boolean' ? params['includeFormatting'] : false;

  return executeWordCommand(async (context) => {
    const paragraphs = context.document.body.paragraphs;
    const loadProps: string[] = ['text', 'style'];
    if (includeFormatting) {
      loadProps.push('font/name', 'font/size', 'font/bold', 'font/italic', 'font/color');
    }
    paragraphs.load(loadProps);
    await context.sync();

    const result: ParagraphInfo[] = [];
    const endIdx = Math.min(paragraphs.items.length, startParagraph + maxParagraphs);

    for (let i = startParagraph; i < endIdx; i++) {
      const p = paragraphs.items[i]!;
      const info: ParagraphInfo = { text: p.text, style: p.style, index: i };

      if (includeFormatting) {
        info.formatting = {
          fontName: p.font.name,
          fontSize: p.font.size,
          bold: p.font.bold,
          italic: p.font.italic,
          color: p.font.color,
        };
      }

      result.push(info);
    }

    return {
      paragraphs: result,
      totalParagraphs: paragraphs.items.length,
      hasMore: endIdx < paragraphs.items.length,
    };
  });
}

/**
 * get_selection — Get the currently selected text.
 */
async function getSelection(_params: Record<string, unknown>): Promise<CommandResult> {
  return executeWordCommand(async (context) => {
    const selection = context.document.getSelection();
    selection.load('text');
    await context.sync();

    return {
      text: selection.text,
      isEmpty: selection.text.length === 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Markdown helpers for insert_text
// ---------------------------------------------------------------------------

interface MarkdownLine {
  text: string;
  headingLevel: number;
  segments: Array<{ text: string; bold: boolean; italic: boolean }>;
}

/**
 * Parse a single line for heading markers and inline bold/italic.
 */
function parseMarkdownLine(line: string): MarkdownLine {
  // Check for heading (# through ######)
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  const headingLevel = headingMatch ? headingMatch[1]!.length : 0;
  const rawText = headingMatch ? headingMatch[2]! : line;

  // Parse inline bold (**text**) and italic (*text*)
  const segments: Array<{ text: string; bold: boolean; italic: boolean }> = [];
  let remaining = rawText;

  while (remaining.length > 0) {
    // Bold+italic (***text***)
    const boldItalicMatch = remaining.match(/^\*\*\*(.+?)\*\*\*/);
    if (boldItalicMatch) {
      segments.push({ text: boldItalicMatch[1]!, bold: true, italic: true });
      remaining = remaining.slice(boldItalicMatch[0]!.length);
      continue;
    }

    // Bold (**text**)
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      segments.push({ text: boldMatch[1]!, bold: true, italic: false });
      remaining = remaining.slice(boldMatch[0]!.length);
      continue;
    }

    // Italic (*text*)
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      segments.push({ text: italicMatch[1]!, bold: false, italic: true });
      remaining = remaining.slice(italicMatch[0]!.length);
      continue;
    }

    // Regular text up to the next '*'
    const nextStar = remaining.indexOf('*');
    const chunk = nextStar === -1 ? remaining : remaining.slice(0, nextStar);
    if (chunk.length > 0) {
      segments.push({ text: chunk, bold: false, italic: false });
    }
    remaining = nextStar === -1 ? '' : remaining.slice(chunk.length);
  }

  const plainText = segments.map((s) => s.text).join('');
  return { text: plainText, headingLevel, segments };
}

const HEADING_STYLES: Record<number, string> = {
  1: 'Heading 1',
  2: 'Heading 2',
  3: 'Heading 3',
  4: 'Heading 4',
  5: 'Heading 5',
  6: 'Heading 6',
};

/**
 * Insert a paragraph with markdown formatting.
 * Inserts text, applies heading style, then applies bold/italic to segments.
 */
async function insertMarkdownParagraph(
  context: Word.RequestContext,
  parsed: MarkdownLine,
  target: Word.Body,
  insertLocation: Word.InsertLocation.start | Word.InsertLocation.end,
  explicitStyle?: string,
): Promise<void> {
  const paragraph = target.insertParagraph(parsed.text, insertLocation);

  // Apply heading or explicit style
  const style = explicitStyle ?? (parsed.headingLevel > 0 ? HEADING_STYLES[parsed.headingLevel] : undefined);
  if (style) {
    paragraph.style = style;
  }

  // Apply inline bold/italic formatting via search within the paragraph range
  const hasFormatting = parsed.segments.some((s) => s.bold || s.italic);
  if (hasFormatting) {
    await context.sync();

    for (const segment of parsed.segments) {
      if (!segment.bold && !segment.italic) continue;

      const results = paragraph.search(segment.text, { matchCase: true });
      results.load('items');
      await context.sync();

      for (const range of results.items) {
        if (segment.bold) range.font.bold = true;
        if (segment.italic) range.font.italic = true;
      }
    }
  }
}

/**
 * insert_text — Insert text at a location in the document.
 * Params:
 *   text           (string, required) — supports basic markdown: **bold**, *italic*, # headings
 *   location       ("end" | "start" | "afterParagraph" | "beforeParagraph" | "replaceSelection", default "end")
 *   paragraphIndex (number, optional) — target paragraph for afterParagraph/beforeParagraph
 *   style          (string, optional) — Word style name (e.g., "Heading 1", "Quote")
 */
async function insertText(params: Record<string, unknown>): Promise<CommandResult> {
  const text = params['text'];
  if (typeof text !== 'string' || text.length === 0) {
    return {
      success: false,
      error: 'The "text" parameter is required and must be a non-empty string.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const location = typeof params['location'] === 'string' ? params['location'] : 'end';
  const style = typeof params['style'] === 'string' ? params['style'] : undefined;

  return executeWordCommand(async (context) => {
    const lines = (text as string).split('\n').filter((line) => line.length > 0);
    const parsedLines = lines.map(parseMarkdownLine);

    switch (location) {
      case 'end':
        for (const parsed of parsedLines) {
          await insertMarkdownParagraph(context, parsed, context.document.body, Word.InsertLocation.end, style);
        }
        break;

      case 'start':
        // Insert in reverse order at start to maintain original order
        for (let i = parsedLines.length - 1; i >= 0; i--) {
          await insertMarkdownParagraph(context, parsedLines[i]!, context.document.body, Word.InsertLocation.start, style);
        }
        break;

      case 'afterParagraph': {
        const idx = params['paragraphIndex'];
        if (typeof idx !== 'number') {
          throw new Error('The "paragraphIndex" parameter is required for location "afterParagraph".');
        }
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load('items');
        await context.sync();

        if (idx >= paragraphs.items.length) {
          throw new Error(`Paragraph index ${idx} out of range. Document has ${paragraphs.items.length} paragraphs.`);
        }

        let insertAfter = paragraphs.items[idx]!.getRange('After');
        for (const parsed of parsedLines) {
          const newParagraph = insertAfter.insertParagraph(parsed.text, Word.InsertLocation.after);
          if (style ?? (parsed.headingLevel > 0 ? HEADING_STYLES[parsed.headingLevel] : undefined)) {
            newParagraph.style = style ?? HEADING_STYLES[parsed.headingLevel]!;
          }
          insertAfter = newParagraph.getRange('After');
        }
        break;
      }

      case 'beforeParagraph': {
        const idx = params['paragraphIndex'];
        if (typeof idx !== 'number') {
          throw new Error('The "paragraphIndex" parameter is required for location "beforeParagraph".');
        }
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load('items');
        await context.sync();

        if (idx >= paragraphs.items.length) {
          throw new Error(`Paragraph index ${idx} out of range. Document has ${paragraphs.items.length} paragraphs.`);
        }

        const insertBefore = paragraphs.items[idx]!;
        for (const parsed of parsedLines) {
          const newParagraph = insertBefore.insertParagraph(parsed.text, Word.InsertLocation.before);
          if (style ?? (parsed.headingLevel > 0 ? HEADING_STYLES[parsed.headingLevel] : undefined)) {
            newParagraph.style = style ?? HEADING_STYLES[parsed.headingLevel]!;
          }
        }
        break;
      }

      case 'replaceSelection': {
        const selection = context.document.getSelection();
        // For replace, join all lines and insert as single text block
        const fullText = parsedLines.map((p) => p.text).join('\n');
        selection.insertText(fullText, Word.InsertLocation.replace);
        if (style) {
          const selParagraphs = selection.paragraphs;
          selParagraphs.load('items');
          await context.sync();
          for (const p of selParagraphs.items) {
            p.style = style;
          }
        }
        break;
      }

      default:
        throw new Error(
          `Unsupported insert location: "${location}". Use "end", "start", "afterParagraph", "beforeParagraph", or "replaceSelection".`,
        );
    }

    await context.sync();
    return { success: true };
  });
}

/**
 * add_comment — Add a comment to the document at a target location.
 * Requires WordApi 1.4+.
 * Params:
 *   text            (string, required)  — comment body
 *   target          (object, required)  — { type: "selection" | "paragraph" | "searchText", paragraphIndex?, searchText? }
 *   replyToCommentId (string, optional) — parent comment ID for threaded reply
 */
async function addComment(params: Record<string, unknown>): Promise<CommandResult> {
  const text = params['text'];
  if (typeof text !== 'string' || text.length === 0) {
    return {
      success: false,
      error: 'The "text" parameter is required and must be a non-empty string.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const replyToCommentId = typeof params['replyToCommentId'] === 'string' ? params['replyToCommentId'] : undefined;
  const target = params['target'] as
    | { type: string; paragraphIndex?: number; searchText?: string }
    | undefined;

  // If replying to an existing comment, find the comment and add a reply
  if (replyToCommentId) {
    return executeWordCommand(async (context) => {
      const body = context.document.body;
      const comments = body.getComments();
      comments.load(['id']);
      await context.sync();

      const parentComment = comments.items.find((c) => c.id === replyToCommentId);
      if (!parentComment) {
        throw new Error(`Comment with ID "${replyToCommentId}" not found.`);
      }

      const reply = parentComment.reply(text as string);
      reply.load('id');
      await context.sync();

      return { success: true, commentId: reply.id, parentCommentId: replyToCommentId };
    });
  }

  return executeWordCommand(async (context) => {
    let range: Word.Range;
    const targetType = target?.type ?? 'selection';

    switch (targetType) {
      case 'selection':
        range = context.document.getSelection();
        break;

      case 'paragraph': {
        const idx = target?.paragraphIndex;
        if (typeof idx !== 'number') {
          throw new Error('The "paragraphIndex" field is required for target type "paragraph".');
        }
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load('items');
        await context.sync();

        if (idx >= paragraphs.items.length) {
          throw new Error(`Paragraph index ${idx} out of range. Document has ${paragraphs.items.length} paragraphs.`);
        }
        range = paragraphs.items[idx]!.getRange('Whole');
        break;
      }

      case 'searchText': {
        const searchText = target?.searchText;
        if (typeof searchText !== 'string' || searchText.length === 0) {
          throw new Error('The "searchText" field is required for target type "searchText".');
        }
        const results = context.document.body.search(searchText, {});
        results.load('items');
        await context.sync();

        if (results.items.length === 0) {
          throw new Error(`No matches found for "${searchText}".`);
        }
        range = results.items[0]!;
        break;
      }

      default:
        throw new Error(`Unsupported target type: "${targetType}". Use "selection", "paragraph", or "searchText".`);
    }

    const comment = range.insertComment(text as string);
    comment.load('id');
    await context.sync();

    return { success: true, commentId: comment.id };
  });
}

/**
 * get_properties — Get document metadata properties including word/page count.
 */
async function getProperties(_params: Record<string, unknown>): Promise<CommandResult> {
  return executeWordCommand(async (context) => {
    const properties = context.document.properties;
    properties.load([
      'title',
      'author',
      'creationDate',
      'lastAuthor',
      'lastSaveTime',
      'subject',
      'keywords',
      'comments',
      'category',
      'revisionNumber',
    ]);

    // Load body for word count estimation
    const body = context.document.body;
    body.load('text');
    await context.sync();

    // Estimate word count from body text
    const bodyText = body.text.trim();
    const wordCount = bodyText.length > 0 ? bodyText.split(/\s+/).length : 0;

    // Load custom properties
    const customProperties = context.document.properties.customProperties;
    customProperties.load(['key', 'value', 'type']);
    await context.sync();

    const customProps: Record<string, unknown> = {};
    for (const prop of customProperties.items) {
      customProps[prop.key] = prop.value;
    }

    return {
      title: properties.title,
      author: properties.author,
      subject: properties.subject,
      keywords: properties.keywords,
      category: properties.category,
      comments: properties.comments,
      creationDate: properties.creationDate,
      lastModifiedBy: properties.lastAuthor,
      lastSaveTime: properties.lastSaveTime,
      revision: properties.revisionNumber,
      wordCount,
      customProperties: customProps,
    };
  });
}

// ---------------------------------------------------------------------------
// Stage 3 — Additional command implementations
// ---------------------------------------------------------------------------

interface HeadingInfo {
  text: string;
  level: number;
  paragraphIndex: number;
  estimatedPage?: number;
}

/** Average paragraphs per page — rough estimate for page number calculation. */
const ESTIMATED_PARAGRAPHS_PER_PAGE = 25;

/**
 * get_document_structure — Get heading outline tree with optional page estimates.
 * Params:
 *   includePageNumbers (boolean, default true) — include approximate page numbers
 */
async function getDocumentStructure(params: Record<string, unknown>): Promise<CommandResult> {
  const includePageNumbers =
    typeof params['includePageNumbers'] === 'boolean' ? params['includePageNumbers'] : true;

  return executeWordCommand(async (context) => {
    const paragraphs = context.document.body.paragraphs;
    paragraphs.load(['text', 'style']);
    await context.sync();

    const headings: HeadingInfo[] = [];

    for (let i = 0; i < paragraphs.items.length; i++) {
      const p = paragraphs.items[i]!;
      const style = p.style.toLowerCase();
      let level = -1;

      if (style.includes('heading 1') || style === 'heading1') level = 1;
      else if (style.includes('heading 2') || style === 'heading2') level = 2;
      else if (style.includes('heading 3') || style === 'heading3') level = 3;
      else if (style.includes('heading 4') || style === 'heading4') level = 4;
      else if (style.includes('heading 5') || style === 'heading5') level = 5;
      else if (style.includes('heading 6') || style === 'heading6') level = 6;

      if (level > 0 && p.text.trim().length > 0) {
        const heading: HeadingInfo = { text: p.text, level, paragraphIndex: i };
        if (includePageNumbers) {
          heading.estimatedPage = Math.floor(i / ESTIMATED_PARAGRAPHS_PER_PAGE) + 1;
        }
        headings.push(heading);
      }
    }

    const totalParagraphs = paragraphs.items.length;
    const estimatedPages = Math.ceil(totalParagraphs / ESTIMATED_PARAGRAPHS_PER_PAGE);

    return {
      headingCount: headings.length,
      totalParagraphs,
      estimatedPages,
      headings,
    };
  });
}

interface FindMatch {
  text: string;
  paragraphIndex: number;
  paragraphText: string;
}

/**
 * find_text — Search for text in the document.
 * Params:
 *   searchText  (string, required)
 *   matchCase   (boolean, default false)
 *   matchWholeWord (boolean, default false)
 *   limit       (number, default 50)
 */
async function findText(params: Record<string, unknown>): Promise<CommandResult> {
  const searchText = params['searchText'];
  if (typeof searchText !== 'string' || searchText.length === 0) {
    return {
      success: false,
      error: 'The "searchText" parameter is required and must be a non-empty string.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const matchCase = typeof params['matchCase'] === 'boolean' ? params['matchCase'] : false;
  const matchWholeWord =
    typeof params['matchWholeWord'] === 'boolean' ? params['matchWholeWord'] : false;
  const limit =
    typeof params['limit'] === 'number' && params['limit'] > 0 ? params['limit'] : 50;

  return executeWordCommand(async (context) => {
    const body = context.document.body;
    const results = body.search(searchText as string, {
      matchCase,
      matchWholeWord,
    });
    results.load('text');
    await context.sync();

    const totalMatches = results.items.length;
    const count = Math.min(totalMatches, limit);
    const matches: FindMatch[] = [];

    // Load parent paragraph text for each match to provide context
    const paragraphRefs: Word.Paragraph[] = [];
    for (let i = 0; i < count; i++) {
      const range = results.items[i]!;
      const para = range.paragraphs.getFirst();
      para.load('text');
      paragraphRefs.push(para);
    }
    await context.sync();

    for (let i = 0; i < count; i++) {
      matches.push({
        text: results.items[i]!.text,
        paragraphIndex: i,
        paragraphText: paragraphRefs[i]?.text ?? '',
      });
    }

    return {
      matchCount: totalMatches,
      returnedCount: matches.length,
      matches,
    };
  });
}

/**
 * replace_text — Find and replace text throughout the document.
 * Params:
 *   searchText    (string, required)
 *   replaceText   (string, required)
 *   matchCase     (boolean, default false)
 *   matchWholeWord (boolean, default false)
 *   replaceAll    (boolean, default true)
 */
async function replaceText(params: Record<string, unknown>): Promise<CommandResult> {
  const searchText = params['searchText'];
  if (typeof searchText !== 'string' || searchText.length === 0) {
    return {
      success: false,
      error: 'The "searchText" parameter is required and must be a non-empty string.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const replacement = params['replaceText'];
  if (typeof replacement !== 'string') {
    return {
      success: false,
      error: 'The "replaceText" parameter is required and must be a string.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const matchCase = typeof params['matchCase'] === 'boolean' ? params['matchCase'] : false;
  const matchWholeWord =
    typeof params['matchWholeWord'] === 'boolean' ? params['matchWholeWord'] : false;
  const replaceAll = typeof params['replaceAll'] === 'boolean' ? params['replaceAll'] : true;

  return executeWordCommand(async (context) => {
    const body = context.document.body;
    const results = body.search(searchText, { matchCase, matchWholeWord });
    results.load('text');
    await context.sync();

    const totalMatches = results.items.length;

    if (totalMatches === 0) {
      return { replacementsCount: 0, message: 'No matches found.' };
    }

    const count = replaceAll ? totalMatches : 1;
    for (let i = 0; i < count; i++) {
      results.items[i]!.insertText(replacement, Word.InsertLocation.replace);
    }
    await context.sync();

    return { replacementsCount: count, totalMatches };
  });
}

/**
 * format_text — Apply formatting to text at a target location.
 * Params:
 *   target     (object) — { type, startParagraph?, endParagraph?, searchText? }
 *   formatting (object) — { bold?, italic?, underline?, strikethrough?, fontFamily?, fontSize?, fontColor?, highlightColor?, alignment? }
 */
async function formatText(params: Record<string, unknown>): Promise<CommandResult> {
  const target = params['target'] as
    | { type: string; startParagraph?: number; endParagraph?: number; searchText?: string }
    | undefined;
  const formatting = params['formatting'] as Record<string, unknown> | undefined;

  if (!target || typeof target.type !== 'string') {
    return {
      success: false,
      error: 'The "target" parameter with a "type" field is required.',
      code: 'INVALID_ARGUMENT',
    };
  }

  if (!formatting || typeof formatting !== 'object') {
    return {
      success: false,
      error: 'The "formatting" parameter is required.',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executeWordCommand(async (context) => {
    let range: Word.Range;

    switch (target.type) {
      case 'selection':
        range = context.document.getSelection();
        break;

      case 'paragraphRange': {
        const startIdx = typeof target.startParagraph === 'number' ? target.startParagraph : 0;
        const endIdx = typeof target.endParagraph === 'number' ? target.endParagraph : startIdx;
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load('items');
        await context.sync();

        if (startIdx >= paragraphs.items.length || endIdx >= paragraphs.items.length) {
          throw new Error(
            `Paragraph index out of range. Document has ${paragraphs.items.length} paragraphs.`,
          );
        }

        const startRange = paragraphs.items[startIdx]!.getRange('Start');
        const endRange = paragraphs.items[endIdx]!.getRange('End');
        range = startRange.expandTo(endRange);
        break;
      }

      case 'searchText': {
        if (typeof target.searchText !== 'string' || target.searchText.length === 0) {
          throw new Error('The "searchText" field is required for target type "searchText".');
        }
        const results = context.document.body.search(target.searchText, {});
        results.load('items');
        await context.sync();

        if (results.items.length === 0) {
          throw new Error(`No matches found for "${target.searchText}".`);
        }
        range = results.items[0]!;
        break;
      }

      default:
        throw new Error(`Unsupported target type: "${target.type}".`);
    }

    // Apply font formatting
    const font = range.font;
    if (typeof formatting['bold'] === 'boolean') font.bold = formatting['bold'];
    if (typeof formatting['italic'] === 'boolean') font.italic = formatting['italic'];
    if (typeof formatting['underline'] === 'boolean') {
      font.underline = formatting['underline']
        ? Word.UnderlineType.single
        : Word.UnderlineType.none;
    }
    if (typeof formatting['strikethrough'] === 'boolean')
      font.strikeThrough = formatting['strikethrough'];
    if (typeof formatting['fontFamily'] === 'string') font.name = formatting['fontFamily'];
    if (typeof formatting['fontSize'] === 'number') font.size = formatting['fontSize'];
    if (typeof formatting['fontColor'] === 'string') font.color = formatting['fontColor'];
    if (typeof formatting['highlightColor'] === 'string')
      font.highlightColor = formatting['highlightColor'];

    // Apply paragraph alignment
    if (typeof formatting['alignment'] === 'string') {
      const alignmentMap: Record<string, Word.Alignment> = {
        left: Word.Alignment.left,
        center: Word.Alignment.centered,
        right: Word.Alignment.right,
        justified: Word.Alignment.justified,
      };
      const align = alignmentMap[formatting['alignment']];
      if (align !== undefined) {
        // Alignment applies to the paragraph, not the range font
        const paragraph = range.paragraphs.getFirst();
        paragraph.alignment = align;
      }
    }

    await context.sync();
    return { success: true };
  });
}

/**
 * insert_table — Insert a table into the document.
 * Params:
 *   headers        (string[]) — column headers
 *   rows           (string[][]) — row data
 *   location       ("end" | "afterParagraph", default "end")
 *   paragraphIndex (number, optional)
 *   style          (string, optional) — table style name
 */
async function insertTable(params: Record<string, unknown>): Promise<CommandResult> {
  const headers = params['headers'];
  if (!Array.isArray(headers) || headers.length === 0) {
    return {
      success: false,
      error: 'The "headers" parameter is required and must be a non-empty array of strings.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const rows = params['rows'];
  if (!Array.isArray(rows)) {
    return {
      success: false,
      error: 'The "rows" parameter is required and must be an array of arrays.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const location = typeof params['location'] === 'string' ? params['location'] : 'end';
  const style = typeof params['style'] === 'string' ? params['style'] : undefined;

  return executeWordCommand(async (context) => {
    const columnCount = (headers as string[]).length;
    const rowCount = (rows as string[][]).length + 1; // +1 for header row
    const values: string[][] = [headers as string[]];

    for (const row of rows as string[][]) {
      // Pad or trim rows to match header count
      const paddedRow = [...row];
      while (paddedRow.length < columnCount) paddedRow.push('');
      values.push(paddedRow.slice(0, columnCount));
    }

    let table: Word.Table;

    if (location === 'afterParagraph' && typeof params['paragraphIndex'] === 'number') {
      const paragraphs = context.document.body.paragraphs;
      paragraphs.load('items');
      await context.sync();

      const idx = params['paragraphIndex'] as number;
      if (idx >= paragraphs.items.length) {
        throw new Error(
          `Paragraph index ${idx} out of range. Document has ${paragraphs.items.length} paragraphs.`,
        );
      }
      const range = paragraphs.items[idx]!.getRange('After');
      table = range.insertTable(rowCount, columnCount, Word.InsertLocation.after, values);
    } else {
      table = context.document.body.insertTable(
        rowCount,
        columnCount,
        Word.InsertLocation.end,
        values,
      );
    }

    if (style) {
      table.style = style;
    }

    await context.sync();
    return { success: true, rowCount: (rows as string[][]).length, columnCount };
  });
}

/**
 * insert_image — Insert an image from file path or base64.
 * Params:
 *   source         (object) — { type, filePath?, base64?, mimeType? }
 *   location       ("end" | "afterParagraph" | "replaceSelection", default "end")
 *   paragraphIndex (number, optional)
 *   width          (number, optional) — in points
 *   height         (number, optional) — in points
 */
async function insertImage(params: Record<string, unknown>): Promise<CommandResult> {
  const source = params['source'] as
    | { type: string; filePath?: string; base64?: string; mimeType?: string }
    | undefined;

  if (!source || typeof source.type !== 'string') {
    return {
      success: false,
      error: 'The "source" parameter with a "type" field is required.',
      code: 'INVALID_ARGUMENT',
    };
  }

  let base64Data: string;

  if (source.type === 'base64') {
    if (typeof source.base64 !== 'string' || source.base64.length === 0) {
      return {
        success: false,
        error: 'The "base64" field is required when source type is "base64".',
        code: 'INVALID_ARGUMENT',
      };
    }
    base64Data = source.base64;
  } else if (source.type === 'filePath') {
    // File reading not directly possible in browser WebView — this will be handled
    // by the sidecar converting the file to base64 before passing to the add-in.
    // For now we expect the sidecar to have already done this conversion.
    if (typeof source.base64 !== 'string' || source.base64.length === 0) {
      return {
        success: false,
        error:
          'File path images must be converted to base64 by the sidecar before reaching the add-in.',
        code: 'INVALID_ARGUMENT',
      };
    }
    base64Data = source.base64;
  } else {
    return {
      success: false,
      error: `Unsupported source type: "${source.type}". Use "filePath" or "base64".`,
      code: 'INVALID_ARGUMENT',
    };
  }

  const location = typeof params['location'] === 'string' ? params['location'] : 'end';

  return executeWordCommand(async (context) => {
    let image: Word.InlinePicture;

    if (location === 'replaceSelection') {
      const selection = context.document.getSelection();
      image = selection.insertInlinePictureFromBase64(base64Data, Word.InsertLocation.replace);
    } else if (
      location === 'afterParagraph' &&
      typeof params['paragraphIndex'] === 'number'
    ) {
      const paragraphs = context.document.body.paragraphs;
      paragraphs.load('items');
      await context.sync();

      const idx = params['paragraphIndex'] as number;
      if (idx >= paragraphs.items.length) {
        throw new Error(
          `Paragraph index ${idx} out of range. Document has ${paragraphs.items.length} paragraphs.`,
        );
      }
      const range = paragraphs.items[idx]!.getRange('After');
      image = range.insertInlinePictureFromBase64(base64Data, Word.InsertLocation.after);
    } else {
      const body = context.document.body;
      // Insert at end: append to the last paragraph's range
      const paragraphs = body.paragraphs;
      paragraphs.load('items');
      await context.sync();

      const lastParagraph = paragraphs.items[paragraphs.items.length - 1]!;
      const range = lastParagraph.getRange('End');
      image = range.insertInlinePictureFromBase64(base64Data, Word.InsertLocation.after);
    }

    if (typeof params['width'] === 'number') image.width = params['width'];
    if (typeof params['height'] === 'number') image.height = params['height'];

    await context.sync();
    return { success: true };
  });
}

/**
 * insert_break — Insert a page or section break.
 * Params:
 *   type           ("page" | "sectionNextPage" | "sectionContinuous")
 *   paragraphIndex (number, optional) — insert after this paragraph
 */
async function insertBreak(params: Record<string, unknown>): Promise<CommandResult> {
  const breakType = params['type'];
  if (typeof breakType !== 'string') {
    return {
      success: false,
      error: 'The "type" parameter is required ("page", "sectionNextPage", or "sectionContinuous").',
      code: 'INVALID_ARGUMENT',
    };
  }

  const breakTypeMap: Record<string, Word.BreakType> = {
    page: Word.BreakType.page,
    sectionNextPage: Word.BreakType.sectionNext,
    sectionContinuous: Word.BreakType.sectionContinuous,
  };

  const wordBreakType = breakTypeMap[breakType];
  if (wordBreakType === undefined) {
    return {
      success: false,
      error: `Unsupported break type: "${breakType}". Use "page", "sectionNextPage", or "sectionContinuous".`,
      code: 'INVALID_ARGUMENT',
    };
  }

  return executeWordCommand(async (context) => {
    const paragraphs = context.document.body.paragraphs;
    paragraphs.load('items');
    await context.sync();

    let targetParagraph: Word.Paragraph;

    if (typeof params['paragraphIndex'] === 'number') {
      const idx = params['paragraphIndex'] as number;
      if (idx >= paragraphs.items.length) {
        throw new Error(
          `Paragraph index ${idx} out of range. Document has ${paragraphs.items.length} paragraphs.`,
        );
      }
      targetParagraph = paragraphs.items[idx]!;
    } else {
      // Default to the last paragraph
      targetParagraph = paragraphs.items[paragraphs.items.length - 1]!;
    }

    targetParagraph.insertBreak(wordBreakType, Word.InsertLocation.after);
    await context.sync();

    return { success: true };
  });
}

/**
 * set_header_footer — Set header or footer text.
 * Params:
 *   type      ("header" | "footer")
 *   text      (string)
 *   target    ("default" | "firstPage" | "evenPages", default "default")
 *   alignment ("left" | "center" | "right", default "center")
 */
async function setHeaderFooter(params: Record<string, unknown>): Promise<CommandResult> {
  const type = params['type'];
  if (type !== 'header' && type !== 'footer') {
    return {
      success: false,
      error: 'The "type" parameter is required and must be "header" or "footer".',
      code: 'INVALID_ARGUMENT',
    };
  }

  const text = params['text'];
  if (typeof text !== 'string') {
    return {
      success: false,
      error: 'The "text" parameter is required and must be a string.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const target = typeof params['target'] === 'string' ? params['target'] : 'default';
  const alignment = typeof params['alignment'] === 'string' ? params['alignment'] : 'center';

  return executeWordCommand(async (context) => {
    const sections = context.document.sections;
    sections.load('items');
    await context.sync();

    if (sections.items.length === 0) {
      throw new Error('Document has no sections.');
    }

    // Process field code placeholders
    // {PAGE}, {NUMPAGES}, {DATE} are replaced with descriptive text since
    // inserting true Word field codes requires the Fields API (WordApi 1.5+).
    // The text-based approach works across all API versions and is readable.
    const processedText = (text as string)
      .replace(/\{PAGE\}/g, '[Page #]')
      .replace(/\{NUMPAGES\}/g, '[Total Pages]')
      .replace(/\{DATE\}/g, new Date().toLocaleDateString());

    // Apply to all sections
    for (const section of sections.items) {
      let headerFooter: Word.Body;

      const headerFooterType =
        target === 'firstPage'
          ? Word.HeaderFooterType.firstPage
          : target === 'evenPages'
            ? Word.HeaderFooterType.evenPages
            : Word.HeaderFooterType.primary;

      headerFooter =
        type === 'header'
          ? section.getHeader(headerFooterType)
          : section.getFooter(headerFooterType);

      // Clear existing content and insert new text
      headerFooter.clear();
      const paragraph = headerFooter.insertParagraph(processedText, Word.InsertLocation.start);

      const alignmentMap: Record<string, Word.Alignment> = {
        left: Word.Alignment.left,
        center: Word.Alignment.centered,
        right: Word.Alignment.right,
      };

      if (alignmentMap[alignment]) {
        paragraph.alignment = alignmentMap[alignment]!;
      }
    }

    await context.sync();
    return { success: true };
  });
}

interface CommentInfo {
  id: string;
  author: string;
  text: string;
  date: string;
  resolved: boolean;
}

/**
 * get_comments — Read all comments in the document.
 * Requires WordApi 1.4+.
 * Params:
 *   includeResolved (boolean, default false)
 */
async function getComments(params: Record<string, unknown>): Promise<CommandResult> {
  const includeResolved =
    typeof params['includeResolved'] === 'boolean' ? params['includeResolved'] : false;

  return executeWordCommand(async (context) => {
    const body = context.document.body;
    const comments = body.getComments();
    comments.load(['id', 'authorName', 'content', 'creationDate', 'resolved']);
    await context.sync();

    const result: CommentInfo[] = [];

    for (const comment of comments.items) {
      if (!includeResolved && comment.resolved) continue;

      result.push({
        id: comment.id,
        author: comment.authorName,
        text: comment.content,
        date: comment.creationDate?.toISOString?.() ?? '',
        resolved: comment.resolved,
      });
    }

    return { commentCount: result.length, comments: result };
  });
}

/**
 * resolve_comment — Resolve or delete a comment.
 * Requires WordApi 1.4+.
 * Params:
 *   commentId (string, required)
 *   action    ("resolve" | "delete")
 */
async function resolveComment(params: Record<string, unknown>): Promise<CommandResult> {
  const commentId = params['commentId'];
  if (typeof commentId !== 'string' || commentId.length === 0) {
    return {
      success: false,
      error: 'The "commentId" parameter is required.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const action = params['action'];
  if (action !== 'resolve' && action !== 'delete') {
    return {
      success: false,
      error: 'The "action" parameter must be "resolve" or "delete".',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executeWordCommand(async (context) => {
    const body = context.document.body;
    const comments = body.getComments();
    comments.load(['id', 'resolved']);
    await context.sync();

    const targetComment = comments.items.find((c) => c.id === commentId);
    if (!targetComment) {
      throw new Error(`Comment with ID "${commentId}" not found.`);
    }

    if (action === 'resolve') {
      targetComment.resolved = true;
    } else {
      targetComment.delete();
    }

    await context.sync();
    return { success: true, commentId, action };
  });
}

interface TrackedChangeInfo {
  id: string;
  type: string;
  author: string;
  date: string;
  text: string;
}

function getTrackedChangeIdentifier(change: Word.TrackedChange, index: number): string {
  return [
    index,
    change.author ?? '',
    change.date?.toISOString?.() ?? '',
    change.type ?? '',
    change.text ?? '',
  ].join('::');
}

/**
 * get_tracked_changes — Read tracked changes (revisions).
 * Params:
 *   limit (number, default 100)
 */
async function getTrackedChanges(params: Record<string, unknown>): Promise<CommandResult> {
  const limit =
    typeof params['limit'] === 'number' && params['limit'] > 0 ? params['limit'] : 100;

  return executeWordCommand(async (context) => {
    const body = context.document.body;
    const trackedChanges = body.getTrackedChanges();
    trackedChanges.load(['type', 'author', 'date', 'text']);
    await context.sync();

    const result: TrackedChangeInfo[] = [];
    const count = Math.min(trackedChanges.items.length, limit);

    for (let i = 0; i < count; i++) {
      const change = trackedChanges.items[i]!;
      result.push({
        id: getTrackedChangeIdentifier(change, i),
        type: change.type ?? 'unknown',
        author: change.author ?? '',
        date: change.date?.toISOString?.() ?? '',
        text: change.text ?? '',
      });
    }

    return {
      totalChanges: trackedChanges.items.length,
      returnedCount: result.length,
      changes: result,
    };
  });
}

/**
 * accept_reject_changes — Accept or reject tracked changes.
 * Params:
 *   action ("accept" | "reject")
 *   target (object) — { type: "specific" | "all" | "byAuthor", changeIds?, author? }
 */
async function acceptRejectChanges(params: Record<string, unknown>): Promise<CommandResult> {
  const action = params['action'];
  if (action !== 'accept' && action !== 'reject') {
    return {
      success: false,
      error: 'The "action" parameter must be "accept" or "reject".',
      code: 'INVALID_ARGUMENT',
    };
  }

  const target = params['target'] as
    | { type: string; changeIds?: string[]; author?: string }
    | undefined;

  if (!target || typeof target.type !== 'string') {
    return {
      success: false,
      error: 'The "target" parameter with a "type" field is required.',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executeWordCommand(async (context) => {
    const body = context.document.body;
    const trackedChanges = body.getTrackedChanges();
    trackedChanges.load(['author', 'date', 'type', 'text']);
    await context.sync();

    let changesToProcess: Word.TrackedChange[] = [];

    switch (target.type) {
      case 'all':
        changesToProcess = [...trackedChanges.items];
        break;

      case 'specific': {
        const ids = new Set(target.changeIds ?? []);
        changesToProcess = trackedChanges.items.filter((change, index) =>
          ids.has(getTrackedChangeIdentifier(change, index)),
        );
        break;
      }

      case 'byAuthor': {
        if (typeof target.author !== 'string') {
          throw new Error('The "author" field is required for target type "byAuthor".');
        }
        const authorLower = target.author.toLowerCase();
        changesToProcess = trackedChanges.items.filter(
          (c) => (c.author ?? '').toLowerCase() === authorLower,
        );
        break;
      }

      default:
        throw new Error(
          `Unsupported target type: "${target.type}". Use "specific", "all", or "byAuthor".`,
        );
    }

    for (const change of changesToProcess) {
      if (action === 'accept') {
        change.accept();
      } else {
        change.reject();
      }
    }

    await context.sync();
    return { success: true, processedCount: changesToProcess.length, action };
  });
}

/**
 * read_table — Read a table's cell values as a 2D array.
 * Params:
 *   tableIndex (number, default 0) — 0-based index into the document's tables
 */
async function readTable(params: Record<string, unknown>): Promise<CommandResult> {
  const tableIndexParam = params['tableIndex'];
  if (
    tableIndexParam !== undefined &&
    (typeof tableIndexParam !== 'number' || !Number.isInteger(tableIndexParam) || tableIndexParam < 0)
  ) {
    return {
      success: false,
      error: 'The "tableIndex" parameter must be a non-negative integer.',
      code: 'INVALID_ARGUMENT',
    };
  }
  const tableIndex = typeof tableIndexParam === 'number' ? tableIndexParam : 0;

  return executeWordCommand(async (context) => {
    const tables = context.document.body.tables;
    tables.load('items');
    await context.sync();

    if (tables.items.length === 0) {
      throw new Error('The document contains no tables.');
    }
    if (tableIndex >= tables.items.length) {
      throw new Error(
        `Table index ${tableIndex} out of range. Document has ${tables.items.length} table(s) (0-based).`,
      );
    }

    const table = tables.items[tableIndex]!;
    table.load(['values', 'rowCount']);
    await context.sync();

    const values = table.values;
    return {
      tableIndex,
      rowCount: table.rowCount,
      columnCount: values[0]?.length ?? 0,
      values,
    };
  });
}

/**
 * update_table_cell — Replace the text of a single table cell.
 * Params:
 *   tableIndex  (number, default 0) — 0-based table index
 *   rowIndex    (number, required)  — 0-based row
 *   columnIndex (number, required)  — 0-based column
 *   text        (string, required)  — new cell text (may be empty to clear the cell)
 */
async function updateTableCell(params: Record<string, unknown>): Promise<CommandResult> {
  const tableIndexParam = params['tableIndex'];
  const rowIndex = params['rowIndex'];
  const columnIndex = params['columnIndex'];
  const text = params['text'];

  if (
    tableIndexParam !== undefined &&
    (typeof tableIndexParam !== 'number' || !Number.isInteger(tableIndexParam) || tableIndexParam < 0)
  ) {
    return {
      success: false,
      error: 'The "tableIndex" parameter must be a non-negative integer.',
      code: 'INVALID_ARGUMENT',
    };
  }
  if (typeof rowIndex !== 'number' || !Number.isInteger(rowIndex) || rowIndex < 0) {
    return {
      success: false,
      error: 'The "rowIndex" parameter is required and must be a non-negative integer (0-based).',
      code: 'INVALID_ARGUMENT',
    };
  }
  if (typeof columnIndex !== 'number' || !Number.isInteger(columnIndex) || columnIndex < 0) {
    return {
      success: false,
      error: 'The "columnIndex" parameter is required and must be a non-negative integer (0-based).',
      code: 'INVALID_ARGUMENT',
    };
  }
  if (typeof text !== 'string') {
    return {
      success: false,
      error: 'The "text" parameter is required and must be a string (may be empty).',
      code: 'INVALID_ARGUMENT',
    };
  }
  const tableIndex = typeof tableIndexParam === 'number' ? tableIndexParam : 0;

  return executeWordCommand(async (context) => {
    const tables = context.document.body.tables;
    tables.load('items');
    await context.sync();

    if (tables.items.length === 0) {
      throw new Error('The document contains no tables.');
    }
    if (tableIndex >= tables.items.length) {
      throw new Error(
        `Table index ${tableIndex} out of range. Document has ${tables.items.length} table(s) (0-based).`,
      );
    }

    const table = tables.items[tableIndex]!;
    table.load(['values', 'rowCount']);
    await context.sync();

    const columnCount = table.values[0]?.length ?? 0;
    if (rowIndex >= table.rowCount || columnIndex >= columnCount) {
      throw new Error(
        `Cell (${rowIndex}, ${columnIndex}) out of range. Table ${tableIndex} has ${table.rowCount} row(s) and ${columnCount} column(s) (0-based).`,
      );
    }

    const cell = table.getCell(rowIndex, columnIndex);
    cell.value = text as string;
    await context.sync();

    return { success: true, tableIndex, rowIndex, columnIndex };
  });
}

/**
 * apply_style — Apply a named paragraph style to existing paragraphs.
 * Params:
 *   style  (string, required) — style name: built-in ("Heading 1", "Title",
 *                               "Quote", …) or a custom style defined in the document
 *   target (object, required) — which paragraphs to style:
 *     { type: 'selection' }
 *     { type: 'paragraphRange', startParagraph, endParagraph }  (0-based, inclusive)
 *     { type: 'searchText', searchText }  (every paragraph containing the text)
 */
async function applyStyle(params: Record<string, unknown>): Promise<CommandResult> {
  const style = params['style'];
  if (typeof style !== 'string' || style.trim().length === 0) {
    return {
      success: false,
      error: 'The "style" parameter is required and must be a non-empty string (e.g. "Heading 1", "Quote").',
      code: 'INVALID_ARGUMENT',
    };
  }

  const target = params['target'] as
    | { type: string; startParagraph?: number; endParagraph?: number; searchText?: string }
    | undefined;
  if (!target || typeof target.type !== 'string') {
    return {
      success: false,
      error: 'The "target" parameter with a "type" field is required.',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executeWordCommand(async (context) => {
    let paragraphsToStyle: Word.Paragraph[] = [];

    switch (target.type) {
      case 'selection': {
        const selection = context.document.getSelection();
        const paragraphs = selection.paragraphs;
        paragraphs.load('items');
        await context.sync();
        if (paragraphs.items.length === 0) {
          throw new Error('The current selection contains no paragraphs to style.');
        }
        paragraphsToStyle = [...paragraphs.items];
        break;
      }

      case 'paragraphRange': {
        const startIdx = typeof target.startParagraph === 'number' ? target.startParagraph : 0;
        const endIdx = typeof target.endParagraph === 'number' ? target.endParagraph : startIdx;
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load('items');
        await context.sync();

        if (startIdx >= paragraphs.items.length || endIdx >= paragraphs.items.length) {
          throw new Error(
            `Paragraph index out of range. Document has ${paragraphs.items.length} paragraphs.`,
          );
        }
        paragraphsToStyle = paragraphs.items.slice(startIdx, endIdx + 1);
        break;
      }

      case 'searchText': {
        if (typeof target.searchText !== 'string' || target.searchText.length === 0) {
          throw new Error('The "searchText" field is required for target type "searchText".');
        }
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load(['text']);
        await context.sync();

        paragraphsToStyle = paragraphs.items.filter((p) => p.text.includes(target.searchText!));
        if (paragraphsToStyle.length === 0) {
          throw new Error(`No paragraphs contain "${target.searchText}".`);
        }
        break;
      }

      default:
        throw new Error(`Unsupported target type: "${target.type}".`);
    }

    for (const paragraph of paragraphsToStyle) {
      paragraph.style = style as string;
    }
    await context.sync();

    return { success: true, styledParagraphs: paragraphsToStyle.length, style };
  });
}
