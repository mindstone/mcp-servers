import type { ChatControllerSnapshot, ChatMessage } from '../chatController/types.js';
import { SHARED_CHAT_UI_COPY } from './copy.js';
import {
  buildTimestampViewModel,
  type DateFormatter,
  type TimestampViewModel,
} from './format.js';

export type SharedConnectionHealth = 'healthy' | 'reconnecting' | 'degraded';
export type SharedHeaderStatus = 'connected' | 'reconnecting' | 'degraded' | 'not-ready';
export type ConversationNoticeKind = 'reconnecting' | 'offline' | 'revoked' | 'error';

export interface MessageRoleViewModel {
  role: ChatMessage['role'];
  direction: 'outgoing' | 'incoming';
  speakerLabel: string;
}

export interface MessageEntryViewModel extends MessageRoleViewModel {
  kind: 'message';
  id: string;
  text: string;
  timestamp: TimestampViewModel;
  partial: boolean;
  partialLabel: string | null;
}

export interface StreamingEntryViewModel extends MessageRoleViewModel {
  kind: 'streaming';
  id: 'streaming-assistant';
  text: string;
  showCursor: true;
}

export interface ThinkingEntryViewModel extends MessageRoleViewModel {
  kind: 'thinking';
  id: 'thinking-assistant';
  label: string;
}

export type ConversationEntryViewModel =
  | MessageEntryViewModel
  | StreamingEntryViewModel
  | ThinkingEntryViewModel;

export interface ConversationNoticeViewModel {
  kind: ConversationNoticeKind;
  tone: 'info' | 'warning' | 'danger';
  message: string | null;
}

export function mapMessageRole(
  role: ChatMessage['role'],
): MessageRoleViewModel {
  switch (role) {
    case 'user':
      return {
        role,
        direction: 'outgoing',
        speakerLabel: SHARED_CHAT_UI_COPY.userLabel,
      };
    case 'assistant':
      return {
        role,
        direction: 'incoming',
        speakerLabel: SHARED_CHAT_UI_COPY.assistantLabel,
      };
  }

  const exhaustiveRole: never = role;
  throw new Error(`Unsupported chat role: ${exhaustiveRole}`);
}

export function mergeStreamingAssistantText(parts: Iterable<string>): string {
  let text = '';
  for (const part of parts) {
    if (part.length > 0) {
      text += part;
    }
  }
  return text;
}

export function buildMessageViewModel(
  message: ChatMessage,
  options: {
    now?: number;
    formatTimestampTitle?: DateFormatter;
  } = {},
): MessageEntryViewModel {
  return {
    kind: 'message',
    id: message.id,
    text: message.text,
    ...mapMessageRole(message.role),
    timestamp: buildTimestampViewModel(
      message.createdAt,
      options.now ?? Date.now(),
      options.formatTimestampTitle,
    ),
    partial: message.partial === true,
    partialLabel: message.partial ? SHARED_CHAT_UI_COPY.partialMessageLabel : null,
  };
}

export function buildConversationEntries(input: {
  messages: ChatMessage[];
  streamingText: string;
  turnStatus: 'idle' | 'running';
  now?: number;
  formatTimestampTitle?: DateFormatter;
}): ConversationEntryViewModel[] {
  const now = input.now ?? Date.now();
  const entries: ConversationEntryViewModel[] = input.messages.map((message) =>
    buildMessageViewModel(message, {
      now,
      ...(input.formatTimestampTitle ? { formatTimestampTitle: input.formatTimestampTitle } : {}),
    }),
  );

  if (input.turnStatus === 'running' && input.streamingText.length > 0) {
    entries.push({
      kind: 'streaming',
      id: 'streaming-assistant',
      text: input.streamingText,
      showCursor: true,
      ...mapMessageRole('assistant'),
    });
  } else if (input.turnStatus === 'running') {
    entries.push({
      kind: 'thinking',
      id: 'thinking-assistant',
      label: SHARED_CHAT_UI_COPY.thinkingLabel,
      ...mapMessageRole('assistant'),
    });
  }

  return entries;
}

export function resolveHeaderStatus(input: {
  surfaceReady: boolean;
  connectionHealth: SharedConnectionHealth;
}): SharedHeaderStatus {
  if (!input.surfaceReady) return 'not-ready';
  if (input.connectionHealth === 'reconnecting') return 'reconnecting';
  if (input.connectionHealth === 'degraded') return 'degraded';
  return 'connected';
}

export function buildConversationNotice(input: {
  phase: ChatControllerSnapshot['phase'];
  errorMessage?: string | null;
}): ConversationNoticeViewModel | null {
  const message = input.errorMessage?.trim() || null;

  switch (input.phase) {
    case 'reconnecting':
      return {
        kind: 'reconnecting',
        tone: 'info',
        message,
      };
    case 'offline':
      return {
        kind: 'offline',
        tone: 'warning',
        message,
      };
    case 'revoked':
      return {
        kind: 'revoked',
        tone: 'danger',
        message,
      };
    default:
      return message
        ? {
            kind: 'error',
            tone: 'danger',
            message,
          }
        : null;
  }
}
