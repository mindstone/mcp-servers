import { z } from 'zod';
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
export const audioMedia = Object.keys(binaryExtensions).filter(media => media.startsWith('audio/'));
export const canonicalAudio = value => Buffer.from(value, 'base64').toString('base64') === value;
export const base64AudioSchema = z.object({ field: z.string().min(1), array: z.string().min(1).optional(), sequence: z.literal(true).optional(),
  media_type: z.enum(audioMedia).optional(), media_type_field: z.string().min(1).optional(),
}).strict().refine(value => Boolean(value.media_type) !== Boolean(value.media_type_field)).refine(value => !value.sequence || (!value.array && Boolean(value.media_type)));
export function base64Representation(descriptor, item, outputFormat) {
  const binding = descriptor.base64_audio;
  const media = binding.media_type_field ? item[binding.media_type_field] : binding.media_type;
  if (!audioMedia.includes(media)) return undefined;
  const format = descriptor.output_formats;
  const selected = outputFormat ?? format?.default;
  const representation = format && format.values.includes(selected) ? audioRepresentation(selected) : undefined;
  return format ? representation && { ...representation, extension: binaryExtensions[representation.media_type] }
    : { media_type: media, extension: binaryExtensions[media] };
}
export function audioRepresentation(format) {
  if (typeof format !== 'string') return undefined;
  const match = /^(mp3|wav|pcm|ulaw|alaw|opus)_([1-9][0-9]*)(?:_([1-9][0-9]*))?$/.exec(format);
  if (!match) return undefined;
  return { media_type: codecs[match[1]], format };
}
export function binaryRepresentation(descriptor, media, outputFormat) {
  if (descriptor.base64_audio) return undefined;
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
