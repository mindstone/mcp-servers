const HTML_ESCAPE_PATTERN = /[&<>"']/g;

const HTML_ESCAPE_LOOKUP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
} as const;

export function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function escapeHtml(value: string | null | undefined): string {
  return normalizeText(value).replace(
    HTML_ESCAPE_PATTERN,
    (char) => HTML_ESCAPE_LOOKUP[char as keyof typeof HTML_ESCAPE_LOOKUP],
  );
}
