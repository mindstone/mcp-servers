/**
 * Shared embedded-chat wire types.
 *
 * Stage 0 guardrail: this file must remain type-only re-exports from the
 * canonical app-bridge protocol declaration.
 */
export type {
  IntentKind,
  TabContextPayload,
  PageContextPayload,
  DocumentContextPayload,
  IntentConversationCreate,
  IntentConversationMessage,
  IntentConversationCreateResult,
  IntentConversationMessageResult,
  IntentConversationStateResult,
  IntentMessageWire,
  IntentConversationHistoryResult,
  IntentConversationFocusResult,
  StreamEvent,
} from '../appBridge/shared/intentProtocol.js';
