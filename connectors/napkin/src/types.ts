export const REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeState {
  port: number;
  token: string;
}

export class NapkinError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'NapkinError';
  }
}

// ---------------------------------------------------------------------------
// Napkin API types
// ---------------------------------------------------------------------------

export type OutputFormat = 'svg' | 'png' | 'ppt';
export type ColorMode = 'light' | 'dark' | 'both';
export type Orientation = 'auto' | 'horizontal' | 'vertical' | 'square';
export type TextExtractionMode = 'auto' | 'rewrite' | 'preserve';
export type SortStrategy = 'relevance' | 'random' | 'variation';
export type RequestStatus = 'pending' | 'completed' | 'failed';

export interface VisualRequest {
  content: string;
  format?: OutputFormat;
  language?: string;
  context?: string;
  style_id?: string;
  visual_query?: string;
  visual_queries?: string[];
  visual_id?: string;
  visual_ids?: string[];
  transparent_background?: boolean;
  color_mode?: ColorMode;
  number_of_visuals?: number;
  orientation?: Orientation;
  text_extraction_mode?: TextExtractionMode;
  sort_strategy?: SortStrategy;
  width?: number;
  height?: number;
}

export interface GeneratedFile {
  url: string;
  visual_id: string;
  visual_query?: string;
  style_id: string;
  width: number;
  height: number;
  color_mode?: string;
}

export interface StatusWarning {
  message: string;
  code: string;
}

export interface StatusError {
  message: string;
  code: string;
}

export interface VisualStatusResponse {
  id: string;
  status: RequestStatus;
  request?: Record<string, unknown>;
  generated_files?: GeneratedFile[];
  warnings?: StatusWarning[];
  error?: StatusError;
  credits?: { consumed: number };
}

export interface CreateVisualResponse {
  id: string;
  status: RequestStatus;
  request?: Record<string, unknown>;
}

export const FORMAT_EXTENSIONS: Record<string, string> = {
  svg: '.svg',
  png: '.png',
  ppt: '.pptx',
};
