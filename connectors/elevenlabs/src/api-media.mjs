// Shared by generation and execution; generic media never use the legacy MP3 fallback.
export const binaryExtensions = Object.freeze({
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/pcm': 'pcm', 'audio/basic': 'ulaw', 'audio/ulaw': 'ulaw',
  'audio/alaw': 'alaw', 'audio/opus': 'opus', 'audio/ogg': 'ogg',
  'application/zip': 'zip', 'text/csv': 'csv', 'video/mp4': 'mp4',
});
const boundAliases = Object.freeze({
  'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  'audio/opus': ['audio/ogg'], 'audio/pcm': ['application/octet-stream'],
  'audio/basic': ['application/octet-stream'], 'audio/alaw': ['application/octet-stream'],
});
const codecs = Object.freeze({ mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', ulaw: 'audio/basic', alaw: 'audio/alaw', opus: 'audio/opus' });
export function audioRepresentation(format) {
  if (typeof format !== 'string') return undefined;
  const match = /^(mp3|wav|pcm|ulaw|alaw|opus)_([1-9][0-9]*)(?:_([1-9][0-9]*))?$/.exec(format);
  if (!match) return undefined;
  return { media_type: codecs[match[1]], format };
}
export function binaryRepresentation(descriptor, media, outputFormat) {
  const binding = descriptor.output_formats;
  if (binding) {
    const selected = outputFormat ?? binding.default;
    if (!binding.values.includes(selected)) return undefined;
    const representation = audioRepresentation(selected);
    if (!representation || (media !== descriptor.media_type && media !== representation.media_type && !boundAliases[representation.media_type]?.includes(media))) return undefined;
    return { ...representation, extension: binaryExtensions[representation.media_type] };
  }
  if (!Object.hasOwn(binaryExtensions, media)) return undefined;
  if (descriptor.media_type !== media && !(descriptor.media_type === 'audio/*' && media.startsWith('audio/'))) return undefined;
  return { media_type: media, extension: binaryExtensions[media] };
}
