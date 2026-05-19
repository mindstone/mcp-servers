import type { FetchExceptionShape, StreamCloseReason } from './diagnostics.js';
import type { ChatErrorCode } from './errors.js';
import type {
  IntentConversationCreate,
  IntentConversationCreateResult,
  IntentConversationFocusResult,
  IntentConversationHistoryResult,
  IntentConversationMessage,
  DocumentContextPayload,
  IntentConversationMessageResult,
  PageContextPayload,
  StreamEvent,
  TabContextPayload,
} from './types.js';

export type CreateConversationInput = Omit<
  IntentConversationCreate,
  'appId' | 'clientId'
> & {
  appId?: IntentConversationCreate['appId'];
  clientId?: IntentConversationCreate['clientId'];
};

export type CreateConversationResult = IntentConversationCreateResult;

export type SendMessageInput = Omit<IntentConversationMessage, 'appId' | 'clientId'> & {
  conversationId: string;
  appId?: IntentConversationMessage['appId'];
  clientId?: IntentConversationMessage['clientId'];
  tabContext?: TabContextPayload;
  pageContext?: PageContextPayload;
  documentContext?: DocumentContextPayload;
};

export type SendMessageResult = IntentConversationMessageResult;

export interface GetHistoryInput {
  conversationId: string;
}

export type GetHistoryResult = IntentConversationHistoryResult;

export interface FocusInRebelInput {
  conversationId: string;
}

export type FocusInRebelResult = IntentConversationFocusResult;

export interface ConnectStreamInput {
  conversationId: string;
  lastEventId?: string;
  signal?: AbortSignal;
}

export type ConnectStreamEvent = StreamEvent;

export interface ResponseError {
  code: ChatErrorCode;
  message: string;
  status?: number;
}

export type ConnectStreamError = ResponseError | FetchExceptionShape;

export interface IntentClientError extends Error {
  code: ChatErrorCode;
  status?: number;
}

export interface ConnectStreamHandlers {
  onEvent: (event: ConnectStreamEvent) => void;
  onClose: (reason: StreamCloseReason) => void;
  onError: (error: ConnectStreamError) => void;
}
