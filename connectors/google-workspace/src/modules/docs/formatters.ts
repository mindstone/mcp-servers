/**
 * Utilities for formatting Google Docs content and parsing URLs.
 */

/**
 * Construct a Google Docs URL from document ID
 */
export function constructDocumentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

/**
 * Extract document ID from various Google Docs URL formats.
 * Supports:
 * - https://docs.google.com/document/d/{id}/edit
 * - https://docs.google.com/document/d/{id}/edit?...
 * - https://docs.google.com/document/d/{id}
 * - docs.google.com/document/d/{id}/...
 * - Just the document ID itself
 */
export function extractDocumentIdFromUrl(input: string): string | null {
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
    // Standard Google Docs URL
    /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/,
    // With open instead of edit
    /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)\/open/,
    // URL-encoded
    /docs\.google\.com%2Fdocument%2Fd%2F([a-zA-Z0-9_-]+)/,
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
 * Format document metadata as human-readable text
 */
export function formatDocumentHeader(
  title: string,
  documentId: string,
  options?: {
    truncated?: boolean;
    wordCount?: number;
    revisionId?: string;
  }
): string {
  const lines: string[] = [
    `Document: ${title}`,
    `URL: ${constructDocumentUrl(documentId)}`,
    `ID: ${documentId}`,
  ];

  if (options?.wordCount !== undefined) {
    lines.push(`Word count: ${options.wordCount}`);
  }

  if (options?.truncated) {
    lines.push('Status: TRUNCATED (content exceeded limit)');
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Format a document read result as human-readable text
 */
export function formatDocumentAsText(
  title: string,
  documentId: string,
  content: string,
  options?: {
    truncated?: boolean;
    includeHeader?: boolean;
  }
): string {
  if (options?.includeHeader === false) {
    return content;
  }

  const header = formatDocumentHeader(title, documentId, {
    truncated: options?.truncated,
  });

  return `${header}\n${content}`;
}
