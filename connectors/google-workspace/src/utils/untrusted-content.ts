export function wrapUntrustedContent(content: string, source: string): string {
  const safe = content.replaceAll('</untrusted-content>', '<&#47;untrusted-content>');
  return `<untrusted-content source="${escapeAttr(source)}">${safe}</untrusted-content>`;
}

export function wrapUntrustedJsonStrings<T>(value: T, source: string): T {
  if (typeof value === 'string') {
    return wrapUntrustedContent(value, source) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => wrapUntrustedJsonStrings(item, source)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, wrapUntrustedJsonStrings(item, source)])
    ) as T;
  }
  return value;
}

function escapeAttr(s: string): string {
  return s.replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
