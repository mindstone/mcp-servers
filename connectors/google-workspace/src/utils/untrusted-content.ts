export function wrapUntrustedContent(content: string, source: string): string {
  const safe = content.replaceAll('</untrusted-content>', '<&#47;untrusted-content>');
  return `<untrusted-content source="${escapeAttr(source)}">${safe}</untrusted-content>`;
}

function escapeAttr(s: string): string {
  return s.replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
