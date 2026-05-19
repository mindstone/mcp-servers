export type {
  IntentKind,
  TabContextPayload,
  PageContextPayload,
  IntentConversationCreate,
  IntentConversationMessage,
  IntentConversationCreateResult,
  IntentConversationMessageResult,
  IntentConversationStateResult,
  IntentMessageWire,
  IntentConversationHistoryResult,
  IntentConversationFocusResult,
  StreamEvent,
} from './types.js';

export type { ChatErrorCode } from './errors.js';
export {
  ALL_CHAT_ERROR_CODES,
  mapErrorResponse,
  mapFetchException,
} from './errors.js';

export type { SSEFrame } from './sse.js';
export { parseSSEChunk, toStreamEvent } from './sse.js';

export type {
  TransportSurface,
  TransportKind,
  TransportDescriptor,
  HeaderBuildInit,
  IntentTransportAdapter,
} from './intentTransportAdapter.js';

export type {
  IntentOp,
  FetchExceptionShape,
  StreamCloseReason,
  DiagnosticEvent,
  DiagnosticSink,
} from './diagnostics.js';
export { NO_OP_SINK } from './diagnostics.js';
export type {
  InMemoryDiagnosticBuffer,
  InMemoryDiagnosticBufferOptions,
} from './diagnosticBuffer.js';
export {
  composeDiagnosticSinks,
  createInMemoryDiagnosticBuffer,
} from './diagnosticBuffer.js';

export type { PersistedChatState, ChatStatePersistence } from './persistence.js';

export type {
  CreateConversationInput,
  CreateConversationResult,
  SendMessageInput,
  SendMessageResult,
  GetHistoryInput,
  GetHistoryResult,
  FocusInRebelInput,
  FocusInRebelResult,
  ConnectStreamInput,
  ConnectStreamEvent,
  ResponseError,
  ConnectStreamError,
  IntentClientError,
  ConnectStreamHandlers,
} from './clientTypes.js';

export type { IntentClient } from './client.js';
export { createIntentClient, isResponseError } from './client.js';
