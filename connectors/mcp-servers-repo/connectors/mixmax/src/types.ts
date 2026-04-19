export const REQUEST_TIMEOUT_MS = 30_000;
export const MIXMAX_API_BASE = 'https://api.mixmax.com/v1';

export interface BridgeState {
  port: number;
  token: string;
}

export class MixmaxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'MixmaxError';
  }
}

export interface SequenceItem {
  _id: string;
  name: string;
  numStages?: number;
  isPaused?: boolean;
  numRecipients?: number;
  numFinished?: number;
  numBounced?: number;
  createdAt?: string;
}

export interface SequencesResponse {
  results: SequenceItem[];
  hasNext?: boolean;
  next?: string;
}

export interface MessagesResponse {
  results: MessageItem[];
  hasNext?: boolean;
  next?: string;
}

export interface MessageItem {
  _id: string;
  subject?: string;
  recipients?: {
    to?: Array<{ email: string }>;
    cc?: Array<{ email: string }>;
    bcc?: Array<{ email: string }>;
  };
  sentAt?: string;
  scheduledAt?: string;
  opens?: number;
  clicks?: number;
  state?: string;
}

export interface SnippetsResponse {
  results: SnippetItem[];
  hasNext?: boolean;
  next?: string;
}

export interface SnippetItem {
  _id: string;
  name?: string;
  subject?: string;
  body?: string;
  isShared?: boolean;
}

export interface MeetingType {
  name?: string;
  duration?: number;
  location?: string;
  slug?: string;
  link?: string;
}
