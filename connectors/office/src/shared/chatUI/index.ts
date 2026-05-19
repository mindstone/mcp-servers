export { SHARED_CHAT_UI_COPY } from './copy.js';

export { normalizeText, escapeHtml } from './safeText.js';

export type {
  DateFormatter,
  TimestampViewModel,
  ContextChipViewModel,
  EmptyStateViewModel,
  ContextChipInput,
} from './format.js';
export {
  hostFromUrl,
  formatRelativeTime,
  formatTimestampTitle,
  buildTimestampViewModel,
  buildContextChipViewModel,
  buildEmptyStateViewModel,
} from './format.js';

export type {
  SharedConnectionHealth,
  SharedHeaderStatus,
  ConversationNoticeKind,
  MessageRoleViewModel,
  MessageEntryViewModel,
  StreamingEntryViewModel,
  ThinkingEntryViewModel,
  ConversationEntryViewModel,
  ConversationNoticeViewModel,
} from './viewModels.js';
export {
  mapMessageRole,
  mergeStreamingAssistantText,
  buildMessageViewModel,
  buildConversationEntries,
  resolveHeaderStatus,
  buildConversationNotice,
} from './viewModels.js';
