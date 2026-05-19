/**
 * Utilities for formatting Google Slides content and parsing URLs.
 */

/**
 * Construct a Google Slides URL from presentation ID
 */
export function constructPresentationUrl(presentationId: string): string {
  return `https://docs.google.com/presentation/d/${presentationId}/edit`;
}

/**
 * Extract presentation ID from various Google Slides URL formats.
 * Supports:
 * - https://docs.google.com/presentation/d/{id}/edit
 * - https://docs.google.com/presentation/d/{id}/edit?...
 * - https://docs.google.com/presentation/d/{id}
 * - docs.google.com/presentation/d/{id}/...
 * - Just the presentation ID itself
 */
export function extractPresentationIdFromUrl(input: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();

  // If it looks like just an ID (alphanumeric with hyphens/underscores, ~44 chars)
  if (/^[a-zA-Z0-9_-]{20,60}$/.test(trimmed)) {
    return trimmed;
  }

  // Try to extract from URL patterns
  const patterns = [
    // Standard Google Slides URL
    /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/,
    // With open instead of edit
    /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)\/open/,
    // URL-encoded
    /docs\.google\.com%2Fpresentation%2Fd%2F([a-zA-Z0-9_-]+)/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Format presentation metadata as human-readable text
 */
export function formatPresentationHeader(
  title: string,
  presentationId: string,
  options?: {
    truncated?: boolean;
    slideCount?: number;
    revisionId?: string;
  }
): string {
  const lines: string[] = [
    `Presentation: ${title}`,
    `URL: ${constructPresentationUrl(presentationId)}`,
    `ID: ${presentationId}`,
  ];

  if (options?.slideCount !== undefined) {
    lines.push(`Slides: ${options.slideCount}`);
  }

  if (options?.truncated) {
    lines.push('Status: TRUNCATED (content exceeded limit)');
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Format a slide read result as human-readable text
 */
export function formatSlideAsText(
  slideIndex: number,
  title: string | undefined,
  textContent: string | undefined,
  speakerNotes?: string
): string {
  const lines: string[] = [];

  if (title) {
    lines.push(`## Slide ${slideIndex + 1}: ${title}`);
  } else {
    lines.push(`## Slide ${slideIndex + 1}`);
  }

  if (textContent?.trim()) {
    lines.push(textContent.trim());
  }

  if (speakerNotes?.trim()) {
    lines.push(`\n[Speaker Notes]: ${speakerNotes.trim()}`);
  }

  return lines.join('\n');
}

/**
 * Format a presentation read result as human-readable text
 */
export function formatPresentationAsText(
  title: string,
  presentationId: string,
  content: string,
  options?: {
    truncated?: boolean;
    slideCount?: number;
    includeHeader?: boolean;
  }
): string {
  if (options?.includeHeader === false) {
    return content;
  }

  const header = formatPresentationHeader(title, presentationId, {
    truncated: options?.truncated,
    slideCount: options?.slideCount,
  });

  return `${header}\n${content}`;
}
