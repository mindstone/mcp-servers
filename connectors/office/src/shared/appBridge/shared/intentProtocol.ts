/**
 * Rebel App Bridge — App → Rebel intent schemas (Stage 6c).
 *
 * Zod schemas that external apps use when posting to `/intent/*` routes. The
 * bridge parses the request body against these at the boundary so downstream
 * handlers (Stage 7's `appBridgeIntentService`) only see validated shapes.
 *
 * Stage 6c finalises the `/intent/conversation/create` contract used by the
 * browser extension's popup quick actions (Summarise / Ask / Save). Stage 7
 * will wire a real handler; until then the router returns 501 with structured
 * payload whenever no handler is injected — the client side is fully plumbed
 * so Stage 7 just has to swap the handler.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { z } from 'zod';

/**
 * The set of intents the extension can fire when creating a conversation.
 *
 * - `summarise` / `ask` / `save_to_notes` are the popup quick-action kinds
 *   shipped in Stage 6c+7 of the bridge plan.
 * - `chat` is the embedded-chat side panel kind (`260421_embedded_chat_in_extension`
 *   Stage 3): the user types directly into the side panel composer instead
 *   of clicking a quick action, so the prompt is just the user text plus
 *   the page context — no canned template.
 */
export const INTENT_KINDS = ['summarise', 'ask', 'save_to_notes', 'chat'] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

/**
 * TabContext captured by the extension popup at click time via
 * `chrome.tabs.query({ active: true, currentWindow: true })`. All fields are
 * optional so the handler can choose to fall back to "Rebel context tab"
 * when the extension fires an intent without an active tab (edge case —
 * popup always has one, but guard anyway).
 */
export const TabContextSchema = z
  .object({
    tabId: z.number().int().nonnegative().optional(),
    windowId: z.number().int().nonnegative().optional(),
    url: z.string().max(2048).optional(),
    title: z.string().max(1024).optional(),
  })
  .strict();
export type TabContextPayload = z.infer<typeof TabContextSchema>;

/**
 * Readable page context accompanying each intent — what the user saw on the
 * tab when they clicked. `text` is optional so popups can send a lightweight
 * ping first and have Rebel fetch the body via read_page. `selection` is the
 * highlighted text when present.
 */
export const PageContextSchema = z
  .object({
    title: z.string().max(1024).optional(),
    url: z.string().max(2048).optional(),
    selection: z.string().max(200_000).optional(),
    text: z.string().max(200_000).optional(),
  })
  .strict();
export type PageContextPayload = z.infer<typeof PageContextSchema>;

export const DocumentContextSchema = z
  .object({
    host: z.string().max(64).optional(),
    title: z.string().max(1024).optional(),
    url: z.string().max(2048).optional(),
  })
  .strict();
export type DocumentContextPayload = z.infer<typeof DocumentContextSchema>;

/**
 * POST /intent/conversation/create.
 *
 * Required: `appId`, `clientId`, `intent`.
 * Optional: `tabContext`, `pageContext`, `userText` (for the "Ask about this"
 * quick action), `title` (optional conversation title hint),
 * `switchToConversation` (defaults `true` for backward compat — popup quick
 * actions still focus the Rebel window; the embedded chat side panel
 * passes `false` so sending a message from the extension does NOT yank
 * the desktop window to the foreground).
 *
 * The `switchToConversation` flag controls BOTH downstream broadcasts
 * the handler emits (`conversations:start-requested` AND
 * `intent:external-context-arrived`) — see `appBridgeIntentService.createConversation`.
 */
export const IntentConversationCreateSchema = z
  .object({
    appId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
    intent: z.enum(INTENT_KINDS),
    tabContext: TabContextSchema.optional(),
    pageContext: PageContextSchema.optional(),
    documentContext: DocumentContextSchema.optional(),
    userText: z.string().max(16_000).optional(),
    title: z.string().max(256).optional(),
    switchToConversation: z.boolean().default(true).optional(),
  })
  .strict();
export type IntentConversationCreate = z.infer<typeof IntentConversationCreateSchema>;

/**
 * POST /intent/conversation/:id/message — Stage 7 ships the composer wiring;
 * Stage 6c leaves this as an explicit 501. The schema is fully specified so
 * Stage 7 needs only to implement the handler.
 */
export const IntentConversationMessageSchema = z
  .object({
    appId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
    text: z.string().min(1).max(16_000),
    tabContext: TabContextSchema.optional(),
    pageContext: PageContextSchema.optional(),
    documentContext: DocumentContextSchema.optional(),
  })
  .strict();
export type IntentConversationMessage = z.infer<typeof IntentConversationMessageSchema>;

/**
 * Response shape for `POST /intent/conversation/create`. Handlers return this
 * (or throw an `AppBridgeError`); the router serialises it to the wire.
 */
export interface IntentConversationCreateResult {
  conversationId: string;
  /** `new` when a fresh session was created; `resumed` when the handler reused an existing one. */
  state?: 'new' | 'resumed';
}

/**
 * Response shape for `POST /intent/conversation/:id/message` (Stage 7).
 *
 * - `state: 'submitted'` — the message was dispatched as a new user turn
 *   (no active turn was running). The session's turn is now in flight.
 * - `state: 'buffered'` — a turn was already active, so the message was
 *   appended to the per-conversation `pendingInputBuffer`. It will be
 *   submitted in FIFO order once the current turn completes.
 *
 * `queueSize` is the buffer depth *after* the append (0 when `submitted`).
 */
export interface IntentConversationMessageResult {
  conversationId: string;
  messageId: string;
  state: 'submitted' | 'buffered';
  queueSize: number;
}

/**
 * Response shape for `GET /intent/conversation/:id/state` (Stage 7).
 *
 * The extension uses this to drive status chips in the popup
 * ("Thinking…" / "Held 2 messages" / "Ready"). `turnStatus` mirrors the
 * internal agent-turn lifecycle at a safe granularity — we never leak
 * raw tool-call payloads.
 */
export interface IntentConversationStateResult {
  conversationId: string;
  turnStatus: 'idle' | 'running' | 'error';
  /** Length of `pendingInputBuffer` for this conversation; 0 when drained. */
  pendingMessages: number;
  /** ms-epoch of the last assistant delta/result; null before any turn ran. */
  lastAssistantAt: number | null;
}

/**
 * Lightweight message projection used by `GET /intent/conversation/:id/messages`
 * (embedded-chat side panel — Stage 1 of the embedded-chat plan).
 *
 * Only the fields the chat surface actually needs to render a bubble are
 * projected — raw `AgentTurnMessage` includes attachments, memory metadata,
 * approval receipts, etc. that would bloat the wire payload.
 *
 * Note: the desktop transcript uses three roles (`user`, `assistant`,
 * `result`) but for the chat wire we collapse `result` → `assistant` so
 * the extension renders a single "Rebel" bubble per turn. `selectVisibleMessages`
 * already filters intermediate assistants when a result exists, so mapping
 * `result → assistant` preserves the "last reply per turn" semantics.
 */
export interface IntentMessageWire {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** ms-epoch when the message was created. */
  createdAt: number;
  /** Optional turn correlation metadata for partial-response reconciliation. */
  turnId?: string;
}

/**
 * SSE payload contract for `GET /intent/conversation/:id/stream`.
 *
 * Canonical wire shape shared by all embedded-chat clients.
 */
export type StreamEvent =
  | { type: 'connected'; conversationId: string; turnStatus: string }
  | { type: 'assistant_delta'; turnId: string; text: string }
  | { type: 'tool_activity'; turnId: string; name: string; phase: string }
  | { type: 'assistant_done'; turnId: string }
  | { type: 'turn_error'; turnId: string; error: string }
  | { type: 'turn_started'; turnId: string }
  | { type: 'message_added'; message: IntentMessageWire }
  | { type: 'revoked' };

/**
 * Response shape for `GET /intent/conversation/:id/messages` (embedded
 * chat — Stage 1 of the `260421_embedded_chat_in_extension` plan).
 *
 * The service filters `AgentSession.messages` through `selectVisibleMessages`
 * so the extension renders the same transcript the desktop app shows
 * (hides system continuations, onboarding prompts, and superseded assistant
 * messages).
 *
 * `turnStatus` tells the client whether a turn is currently running so
 * the side panel can immediately show a "thinking…" indicator on first
 * hydration instead of waiting for the next stream event.
 *
 * `conversationTitle` mirrors the desktop header — optional because fresh
 * conversations may not have a resolved title yet.
 */
export interface IntentConversationHistoryResult {
  conversationId: string;
  messages: IntentMessageWire[];
  turnStatus: 'idle' | 'running';
  conversationTitle?: string;
}

/**
 * Response shape for `POST /intent/conversation/:id/focus` (embedded chat —
 * Stage 3 of `260421_embedded_chat_in_extension`).
 *
 * Powers the side panel's "Open in Rebel" button: the side panel posts to
 * this route and Rebel navigates the desktop window to the existing
 * conversation. `focused: true` means the focus broadcast was emitted —
 * the actual window-foregrounding happens on the renderer side via the
 * existing `conversations:start-requested` handler. `focused: false` is
 * reserved for future "we found the conversation but skipped the focus
 * broadcast for X reason" cases — the current handler always broadcasts.
 */
export interface IntentConversationFocusResult {
  conversationId: string;
  focused: boolean;
}
