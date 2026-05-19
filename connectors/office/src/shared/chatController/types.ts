import type { ChatErrorCode } from '../intentClient/errors.js';
import type { ChatStatePersistence } from '../intentClient/persistence.js';
import type {
  DocumentContextPayload,
  IntentMessageWire,
  PageContextPayload,
  TabContextPayload,
} from '../intentClient/types.js';

export interface ChatMessage extends IntentMessageWire {
  partial?: boolean;
  turnId?: string;
}

export interface ChatContext {
  tabContext?: TabContextPayload;
  pageContext?: PageContextPayload;
  documentContext?: DocumentContextPayload;
}

export interface ConversationContext {
  pageTitle?: string;
  pageUrl?: string;
}

export interface ContextProvider {
  captureContext(): Promise<ChatContext | null> | ChatContext | null;
}

export interface ChatControllerError {
  code: ChatErrorCode | 'BUSY' | 'MISSING_CONTEXT' | 'UNKNOWN';
  message: string;
  status?: number;
}

export interface ChatControllerSnapshot {
  phase: 'hydrating' | 'idle' | 'sending' | 'streaming' | 'reconnecting' | 'offline' | 'revoked';
  conversationId: string | null;
  conversationContext: ConversationContext;
  messages: ChatMessage[];
  turnStatus: 'idle' | 'running';
  error: ChatControllerError | null;
  retryableSend: string | null;
  creatingConversation: boolean;
  reconnectAttempt: number;
}

export interface ChatController {
  getSnapshot(): ChatControllerSnapshot;
  subscribe(listener: () => void): () => void;
  getStreamingText(): string;
  subscribeStreamingText(listener: () => void): () => void;
  send(text: string): Promise<void>;
  startFresh(): Promise<void>;
  openInRebel(): Promise<void>;
  dispose(): void;
}

export interface ControllerTransitionDiagnosticEvent {
  kind: 'controller.transition';
  from: ChatControllerSnapshot['phase'];
  to: ChatControllerSnapshot['phase'];
  conversationId: string | null;
  requestId?: string;
}

export interface ControllerOfflineProbeDiagnosticEvent {
  kind: 'controller.offline-probe';
  trigger: 'send-error' | 'stream-error' | 'stream-close';
  reachable: boolean;
  attempt?: number;
  requestId?: string;
}

export interface ControllerAbortDiagnosticEvent {
  kind: 'controller.abort';
  source: 'start-fresh' | 'dispose';
  requestId?: string;
}

export type ChatControllerDiagnosticEvent =
  | ControllerTransitionDiagnosticEvent
  | ControllerOfflineProbeDiagnosticEvent
  | ControllerAbortDiagnosticEvent;

export type { ChatStatePersistence };
