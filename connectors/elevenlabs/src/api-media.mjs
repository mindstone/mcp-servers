import { z } from 'zod';
// Shared by generation and execution; generic media never use the legacy MP3 fallback.
export const binaryExtensions = Object.freeze({
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/pcm': 'pcm', 'audio/basic': 'ulaw', 'audio/ulaw': 'ulaw',
  'audio/alaw': 'alaw', 'audio/opus': 'opus', 'audio/ogg': 'ogg',
  'text/plain': 'txt', 'application/zip': 'zip', 'application/x-zip': 'zip', 'text/csv': 'csv', 'video/mp4': 'mp4',
});
// Upload file extensions for every audio reader, older tools and generic bindings alike: the major audio and video formats.
export const audioUploadExtensions = Object.freeze({
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime',
  aac: 'audio/aac', opus: 'audio/opus', oga: 'audio/ogg', aiff: 'audio/aiff', aif: 'audio/aiff', wma: 'audio/x-ms-wma',
  amr: 'audio/amr', mpga: 'audio/mpeg', '3gp': 'video/3gpp', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/mp4',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpeg: 'video/mpeg', mpg: 'video/mpeg', pcm: 'audio/pcm',
});
// Raw PCM needs an explicit binding: only request contracts that declare a PCM input format accept it.
export function audioUploadMediaTypes(includePcm = false) {
  return [...new Set(Object.values(audioUploadExtensions))].filter(media => includePcm || media !== 'audio/pcm');
}
const boundAliases = Object.freeze({
  'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  'audio/opus': ['audio/ogg'], 'audio/pcm': ['application/octet-stream'],
  'audio/basic': ['application/octet-stream'], 'audio/alaw': ['application/octet-stream'],
});
const codecs = Object.freeze({ mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', ulaw: 'audio/basic', alaw: 'audio/alaw', opus: 'audio/opus' });
// text/plain is a saved file only when its schema declares binary bytes; otherwise it stays ordinary text.
export function isBinaryMedia(media, schema) {
  return typeof media === 'string' && Object.hasOwn(binaryExtensions, media) && (media !== 'text/plain' || schema?.format === 'binary');
}
export const audioMedia = Object.keys(binaryExtensions).filter(media => media.startsWith('audio/'));
export const canonicalAudio = value => Buffer.from(value, 'base64').toString('base64') === value;
export const base64AudioSchema = z.object({ field: z.string().min(1), array: z.string().min(1).optional(), sequence: z.literal(true).optional(),
  media_type: z.enum(audioMedia).optional(), media_type_field: z.string().min(1).optional(),
}).strict().refine(value => Boolean(value.media_type) !== Boolean(value.media_type_field)).refine(value => !value.sequence || (!value.array && Boolean(value.media_type)));
export const multipartResponseSchema = z.object({ metadata: z.literal('application/json'), audio: z.literal('audio/*') }).strict();
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
  if (Object.hasOwn(binaryExtensions, media) && !isBinaryMedia(media, descriptor.schema)) return undefined;
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
