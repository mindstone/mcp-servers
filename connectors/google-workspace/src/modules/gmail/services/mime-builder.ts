import { randomUUID } from 'node:crypto';

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[\r\n]/g, '')
    .replace(/"/g, '\\"');
}

/**
 * Wraps a base64 string to 76-character lines per RFC 2045 §6.8.
 */
function wrapBase64(base64: string): string {
  return base64.replace(/(.{76})/g, '$1\r\n');
}

/**
 * RFC 2047 encode a header value if it contains non-ASCII characters.
 * Uses base64 encoding: =?UTF-8?B?<base64>?=
 * Returns the value unchanged if it's pure ASCII.
 */
function encodeHeaderIfNeeded(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

export interface MimeMessageParams {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  isHtml?: boolean;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    mimeType: string;
    content: string; // base64-encoded
  }>;
}

/**
 * Builds an RFC 2822–compliant MIME message and returns it as a
 * base64url-encoded string ready for the Gmail API `raw` field.
 *
 * Fixes applied vs. previous hand-rolled construction:
 * - Body uses `Content-Transfer-Encoding: base64` so UTF-8 is safe
 * - Attachment base64 is line-wrapped to 76 chars (RFC 2045)
 * - Boundary uses crypto.randomUUID() for reliable uniqueness
 */
export function buildMimeMessage(params: MimeMessageParams): string {
  const {
    to,
    subject,
    body,
    cc = [],
    bcc = [],
    isHtml = false,
    inReplyTo,
    references,
    attachments = [],
  } = params;

  const boundary = `boundary_${randomUUID()}`;
  const bodyContentType = isHtml ? 'text/html' : 'text/plain';

  const sanitizedTo = to.map(sanitizeHeaderValue).join(', ');
  const sanitizedSubject = sanitizeHeaderValue(subject);

  const headerParts = [
    'MIME-Version: 1.0\r\n',
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`,
    `To: ${sanitizedTo}\r\n`,
  ];

  if (cc.length > 0) {
    headerParts.push(`Cc: ${cc.map(sanitizeHeaderValue).join(', ')}\r\n`);
  }
  if (bcc.length > 0) {
    headerParts.push(`Bcc: ${bcc.map(sanitizeHeaderValue).join(', ')}\r\n`);
  }

  headerParts.push(`Subject: ${encodeHeaderIfNeeded(sanitizedSubject)}\r\n`);

  if (inReplyTo) {
    headerParts.push(`In-Reply-To: ${sanitizeHeaderValue(inReplyTo)}\r\n`);
  }
  if (references?.length) {
    headerParts.push(`References: ${references.map(sanitizeHeaderValue).join(' ')}\r\n`);
  }

  // Base64-encode the body so non-ASCII (UTF-8) content is safely transported
  const encodedBody = Buffer.from(body, 'utf-8').toString('base64');

  const messageParts = [
    ...headerParts,
    '\r\n',
    `--${boundary}\r\n`,
    `Content-Type: ${bodyContentType}; charset="UTF-8"\r\n`,
    'Content-Transfer-Encoding: base64\r\n\r\n',
    wrapBase64(encodedBody),
    '\r\n',
  ];

  for (const attachment of attachments) {
    const safeFilename = sanitizeFilename(attachment.filename);
    const safeMimeType = sanitizeHeaderValue(attachment.mimeType);
    messageParts.push(
      `--${boundary}\r\n`,
      `Content-Type: ${safeMimeType}\r\n`,
      'Content-Transfer-Encoding: base64\r\n',
      `Content-Disposition: attachment; filename="${safeFilename}"\r\n\r\n`,
      wrapBase64(attachment.content),
      '\r\n',
    );
  }

  messageParts.push(`--${boundary}--`);

  const fullMessage = messageParts.join('');
  return Buffer.from(fullMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
