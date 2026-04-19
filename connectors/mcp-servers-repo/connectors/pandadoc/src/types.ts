export const REQUEST_TIMEOUT_MS = 30_000;
export const PANDADOC_API_BASE = 'https://api.pandadoc.com/public/v1';
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export interface BridgeState {
  port: number;
  token: string;
}

export class PandaDocError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'PandaDocError';
  }
}

export interface DocumentCompact {
  id: string;
  name: string;
  status: string;
  date_created: string;
  date_modified: string;
  expiration_date: string | null;
  version: string | null;
}

export interface DocumentDetails extends DocumentCompact {
  date_completed: string | null;
  date_sent: string | null;
  created_by: Record<string, unknown>;
  template: Record<string, unknown> | null;
  recipients: Record<string, unknown>[];
  fields: Record<string, unknown>[];
  tokens: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  tags: string[];
  grand_total: Record<string, unknown> | null;
  linked_objects: Record<string, unknown>[];
}

export interface DocumentListResponse {
  results: Record<string, unknown>[];
}

export interface TemplateListResponse {
  results: Record<string, unknown>[];
}

export interface DocumentCreateResponse {
  id: string;
  name: string;
  status: string;
  date_created: string;
  date_modified: string;
  expiration_date: string | null;
  version: string | null;
  uuid: string;
  links: Array<{ rel: string; href: string; type: string }>;
  info_message: string;
}

export interface DocumentSendResponse {
  id: string;
  name: string;
  status: string;
  date_created: string;
  date_modified: string;
  recipients: Array<Record<string, unknown>>;
}
