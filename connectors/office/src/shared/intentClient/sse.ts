import type { StreamEvent } from './types.js';

export interface SSEFrame {
  event: string;
  data: string;
}

/**
 * Parse a chunk of accumulated SSE text into zero or more complete events
 * plus the leftover (incomplete) tail.
 *
 * SSE event format (per https://html.spec.whatwg.org/multipage/server-sent-events.html):
 *   - Events are separated by a blank line (`\n\n`).
 *   - Each event is a list of `field:value` lines.
 *   - Lines starting with `:` are comments (keepalive) and ignored.
 *   - We care about `event:` (defaults to `message`) and `data:` (concatenated
 *     with `\n` when repeated).
 *
 * The parser is intentionally forgiving: it drops fields it doesn't understand
 * and swallows empty events (keepalive-only blocks).
 */
export function parseSSEChunk(buffer: string): {
  events: SSEFrame[];
  remainder: string;
} {
  // Normalise CRLF → LF so line splits are stable regardless of server quirks.
  const normalised = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const boundary = '\n\n';
  const events: SSEFrame[] = [];
  let rest = normalised;
   
  while (true) {
    const idx = rest.indexOf(boundary);
    if (idx === -1) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + boundary.length);

    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.length === 0) continue;
      if (line.startsWith(':')) continue; // comment / keepalive
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      // Per spec: a single leading space after the colon is stripped.
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') {
        eventName = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
      // `id:`, `retry:` intentionally ignored — we don't implement Last-Event-ID.
    }
    if (dataLines.length === 0) {
      // Comment-only block — skip.
      continue;
    }
    events.push({ event: eventName, data: dataLines.join('\n') });
  }
  return { events, remainder: rest };
}

/**
 * Translate a raw SSE frame into a typed `StreamEvent`.
 * Unknown events and malformed payloads are silently dropped — SSE is
 * intentionally forward-compatible.
 */
export function toStreamEvent(frame: SSEFrame): StreamEvent | null {
  const { event, data } = frame;
  let parsed: unknown;
  try {
    parsed = data.length === 0 ? {} : JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;

  switch (event) {
    case 'connected': {
      if (typeof p.conversationId !== 'string' || typeof p.turnStatus !== 'string') {
        return null;
      }
      return {
        type: 'connected',
        conversationId: p.conversationId,
        turnStatus: p.turnStatus,
      };
    }
    case 'assistant_delta': {
      if (typeof p.turnId !== 'string' || typeof p.text !== 'string') return null;
      return { type: 'assistant_delta', turnId: p.turnId, text: p.text };
    }
    case 'tool_activity': {
      if (
        typeof p.turnId !== 'string' ||
        typeof p.name !== 'string' ||
        typeof p.phase !== 'string'
      ) {
        return null;
      }
      return {
        type: 'tool_activity',
        turnId: p.turnId,
        name: p.name,
        phase: p.phase,
      };
    }
    case 'assistant_done': {
      if (typeof p.turnId !== 'string') return null;
      return { type: 'assistant_done', turnId: p.turnId };
    }
    case 'turn_error': {
      if (typeof p.turnId !== 'string' || typeof p.error !== 'string') return null;
      return { type: 'turn_error', turnId: p.turnId, error: p.error };
    }
    case 'turn_started': {
      if (typeof p.turnId !== 'string') return null;
      return { type: 'turn_started', turnId: p.turnId };
    }
    case 'message_added': {
      const m = p.message as
        | { id?: unknown; role?: unknown; text?: unknown; createdAt?: unknown; turnId?: unknown }
        | undefined;
      if (
        !m ||
        typeof m.id !== 'string' ||
        (m.role !== 'user' && m.role !== 'assistant') ||
        typeof m.text !== 'string' ||
        typeof m.createdAt !== 'number'
      ) {
        return null;
      }
      return {
        type: 'message_added',
        message: {
          id: m.id,
          role: m.role,
          text: m.text,
          createdAt: m.createdAt,
          ...(typeof m.turnId === 'string' ? { turnId: m.turnId } : {}),
        },
      };
    }
    case 'revoked': {
      return { type: 'revoked' };
    }
    default:
      return null;
  }
}
