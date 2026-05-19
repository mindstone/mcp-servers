import type { StreamEvent } from './types.js';

export type IntentOp =
  | 'createConversation'
  | 'sendMessage'
  | 'getHistory'
  | 'focusInRebel'
  | 'connectStream';

export interface FetchExceptionShape {
  errName: string;
  errMsg: string;
  errConstructor: string;
  isTypeError: boolean;
  isDOMException: boolean;
  isAbortError: boolean;
}

export type StreamCloseReason = 'eof' | 'aborted' | 'error' | 'revoked';

export type DiagnosticEvent =
  | {
      kind: 'fetch.start';
      op: IntentOp;
      url: string;
      requestId: string;
      tokenLen: number;
      ts: number;
    }
  | {
      kind: 'fetch.response';
      op: IntentOp;
      url: string;
      requestId: string;
      status: number;
      ok: boolean;
      durMs: number;
      ts: number;
    }
  | {
      kind: 'fetch.threw';
      op: IntentOp;
      url: string;
      requestId: string;
      durMs: number;
      ts: number;
      shape: FetchExceptionShape;
    }
  | {
      kind: 'stream.open';
      requestId: string;
      conversationId: string;
      lastEventId?: string;
      ts: number;
    }
  | {
      kind: 'stream.event';
      requestId: string;
      eventKind: StreamEvent['type'];
      ts: number;
    }
  | {
      kind: 'stream.close';
      requestId: string;
      reason: StreamCloseReason;
      durMs: number;
      ts: number;
    }
  | {
      kind: 'stream.err';
      requestId: string;
      durMs: number;
      ts: number;
      shape: FetchExceptionShape;
    };

export interface DiagnosticSink {
  emit(event: DiagnosticEvent): void;
}

export const NO_OP_SINK: DiagnosticSink = {
  emit: () => {
    // Intentionally empty.
  },
};

export const REQUEST_ID_HEADER_NAME = 'X-Rebel-Diag-Id' as const;

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function requestIdHeader(
  requestId: string,
): [typeof REQUEST_ID_HEADER_NAME, string] {
  return [REQUEST_ID_HEADER_NAME, requestId];
}
