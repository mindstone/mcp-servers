/**
 * Shared utilities for email-imap tool handlers.
 */

import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { MessageAddressObject, MessageStructureObject } from 'imapflow';

import type { ClientConfig } from '../types.js';
import { getConnection } from '../imap-client.js';
import { getPreset, listPresetKeys } from '../presets.js';
import { wrapUntrusted, unwrapUntrusted } from '../untrusted-content.js';

/**
 * Envelope source tag for every attacker-controlled string an email message
 * carries (bodies, subjects, display names, attachment filenames). LLM01
 * mitigation: the host LLM must treat these as DATA, not instructions.
 * Wrapping is content-agnostic — applied even to empty or injection-shaped
 * content — and the canonical helper neutralises embedded close-tag variants
 * so the envelope cannot be broken out of (VAL-EMAIL-115 / VAL-CROSS-011 /
 * VAL-CROSS-012).
 */
export const UNTRUSTED_EMAIL_SOURCE = 'external-email';

/**
 * Wrap one attacker-controlled email text field in the untrusted-content
 * envelope. `null`/`undefined` pass through as `null` so optional fields
 * keep their shape in the JSON response.
 */
export function wrapEmailField(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }
  return wrapUntrusted(text, UNTRUSTED_EMAIL_SOURCE) ?? null;
}

/**
 * Wrap a list of attacker-controlled strings (e.g. IMAP flag keywords, which
 * a caller can write server-side via email_set_flags) in per-item envelopes.
 */
export function wrapEmailFieldList(values: string[]): string[] {
  return values.map((value) => wrapUntrusted(value, UNTRUSTED_EMAIL_SOURCE) ?? value);
}

/**
 * Strip one untrusted-content envelope layer from a caller-supplied mailbox
 * name, trim, and FAIL CLOSED when nothing usable remains. Schema validation
 * (`z.string().min(1)` / `.trim().min(1)`) runs BEFORE unwrapping, so an
 * enveloped-but-empty value such as
 * `<untrusted-content source="external-email"></untrusted-content>` passes
 * the schema as 62 non-blank characters and would otherwise reach the
 * network as an empty mailbox name (`mailboxCreate('')` / `mailboxDelete('')`
 * / `getMailboxLock('')`). The non-empty check must run on the value that is
 * actually sent to the server.
 */
export function unwrapMailboxName(raw: string, field: string): string {
  const value = unwrapUntrusted(raw).trim();
  if (value.length === 0) {
    throw new Error(
      `"${field}" must be a non-empty mailbox name after removing any ` +
        'untrusted-content envelope',
    );
  }
  return value;
}

/**
 * In-memory client config. Set by initClients(), read by tool handlers.
 */
let clientConfig: ClientConfig | null = null;

export function setClientConfig(config: ClientConfig | null): void {
  clientConfig = config ? { ...config } : null;
}

export function getClientConfig(): ClientConfig | null {
  return clientConfig;
}

export function ensureInitialized(): ClientConfig {
  if (!clientConfig) {
    throw new Error('Email clients are not initialized');
  }
  return clientConfig;
}

/**
 * Attachment metadata from a parsed message.
 */
export interface AttachmentMetadata {
  filename: string | null;
  contentType: string;
  size: number;
  /** MIME part identifier — pass to email_get_attachment to download. */
  part: string;
}

/**
 * Parsed message parts (text, html, attachments).
 */
export interface MessageParts {
  textPart?: string;
  htmlPart?: string;
  attachments: AttachmentMetadata[];
}

/**
 * Format email addresses for display.
 */
export function formatAddresses(addresses?: MessageAddressObject[]): string {
  if (!addresses || addresses.length === 0) {
    return '';
  }

  return addresses
    .map((address) => {
      if (!address.address) {
        return '';
      }

      if (address.name) {
        return `${address.name} <${address.address}>`;
      }

      return address.address;
    })
    .filter((entry) => entry.length > 0)
    .join(', ');
}

/**
 * Format a date value to ISO string.
 */
export function formatDate(date: Date | string | undefined): string | null {
  if (!date) {
    return null;
  }

  if (date instanceof Date) {
    return date.toISOString();
  }

  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Generate a unique Message-ID for an email.
 */
export function generateMessageId(email: string): string {
  const [, domain = 'localhost'] = email.split('@');
  return `<${randomUUID()}@${domain}>`;
}

/**
 * Read a stream into a Buffer.
 */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk as Buffer);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Download a message part as text by UID and part number.
 */
export async function downloadPartAsText(uid: number, part: string): Promise<string> {
  const client = await getConnection();
  const partData = await client.download(uid, part, { uid: true });
  const content = await streamToBuffer(partData.content);
  return content.toString('utf8');
}

/**
 * Recursively collect text/html parts and attachments from a message structure.
 */
export function collectMessageParts(
  node: MessageStructureObject | undefined,
  parts: MessageParts,
): void {
  if (!node) {
    return;
  }

  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    for (const childNode of node.childNodes) {
      collectMessageParts(childNode, parts);
    }
    return;
  }

  const contentType = node.type.toLowerCase();
  const partIdentifier = node.part ?? '1';

  if (contentType === 'text/plain' && !parts.textPart) {
    parts.textPart = partIdentifier;
    return;
  }

  if (contentType === 'text/html' && !parts.htmlPart) {
    parts.htmlPart = partIdentifier;
    return;
  }

  const disposition = node.disposition?.toLowerCase();
  const filename =
    node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
  const isAttachment =
    disposition === 'attachment' ||
    (disposition === 'inline' && Boolean(filename)) ||
    (Boolean(filename) && !contentType.startsWith('text/'));

  if (!isAttachment) {
    return;
  }

  parts.attachments.push({
    filename,
    contentType,
    size: typeof node.size === 'number' ? node.size : 0,
    part: partIdentifier,
  });
}

/**
 * Remove duplicates from an array, preserving order (case-insensitive).
 */
export function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }

  return result;
}

/**
 * Resolve the drafts mailbox name for the current account.
 */
export async function resolveDraftsMailbox(): Promise<string> {
  const client = await getConnection();
  const listedMailboxes = await client.list();
  const mailboxByLowerName = new Map<string, string>();

  for (const mailbox of listedMailboxes) {
    mailboxByLowerName.set(mailbox.path.toLowerCase(), mailbox.path);
  }

  const exactDrafts = mailboxByLowerName.get('drafts');
  if (exactDrafts) {
    return exactDrafts;
  }

  const specialUseDrafts = listedMailboxes.find(
    (mailbox) => mailbox.specialUse === '\\Drafts',
  );
  if (specialUseDrafts) {
    return specialUseDrafts.path;
  }

  const iCloudPreset = getPreset('icloud');
  const yahooPreset = getPreset('yahoo');
  const fallbackCandidates = uniquePreserveOrder([
    'Drafts',
    'Draft',
    ...(iCloudPreset?.folderFallbacks.drafts ?? []),
    ...(yahooPreset?.folderFallbacks.drafts ?? []),
  ]);

  for (const candidate of fallbackCandidates) {
    const existing = mailboxByLowerName.get(candidate.toLowerCase());
    if (existing) {
      return existing;
    }
  }

  const defaultMailbox = fallbackCandidates[0] ?? 'Drafts';
  await client.mailboxCreate(defaultMailbox);
  return defaultMailbox;
}

/**
 * Resolve the trash mailbox name for the current account, or null when the
 * account has none. Unlike resolveDraftsMailbox this NEVER auto-creates the
 * mailbox: deletion fallbacks (\Deleted + expunge) are decided by the caller
 * based on whether a trash mailbox actually exists.
 */
export async function resolveTrashMailbox(): Promise<string | null> {
  const client = await getConnection();
  const listedMailboxes = await client.list();

  const specialUseTrash = listedMailboxes.find(
    (mailbox) => mailbox.specialUse === '\\Trash',
  );
  if (specialUseTrash) {
    return specialUseTrash.path;
  }

  const mailboxByLowerName = new Map<string, string>();
  for (const mailbox of listedMailboxes) {
    mailboxByLowerName.set(mailbox.path.toLowerCase(), mailbox.path);
  }

  const fallbackCandidates = uniquePreserveOrder([
    'Trash',
    'Deleted Messages',
    'Deleted Items',
    ...listPresetKeys().flatMap((key) => getPreset(key)?.folderFallbacks.trash ?? []),
  ]);

  for (const candidate of fallbackCandidates) {
    const existing = mailboxByLowerName.get(candidate.toLowerCase());
    if (existing) {
      return existing;
    }
  }

  return null;
}

/**
 * Ensure a mailbox exists, creating it if necessary.
 */
export async function ensureMailboxExists(mailbox: string): Promise<void> {
  const client = await getConnection();
  const listedMailboxes = await client.list();
  const exists = listedMailboxes.some(
    (entry) => entry.path.toLowerCase() === mailbox.toLowerCase(),
  );

  if (!exists) {
    await client.mailboxCreate(mailbox);
  }
}
