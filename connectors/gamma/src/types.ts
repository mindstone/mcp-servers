export const REQUEST_TIMEOUT_MS = 30_000;

/** Export polling interval in ms — overridable via GAMMA_EXPORT_POLL_INTERVAL_MS */
export const EXPORT_POLL_INTERVAL_MS = parseInt(
  process.env.GAMMA_EXPORT_POLL_INTERVAL_MS ?? '5000',
  10,
);

/** Max export polling attempts — overridable via GAMMA_EXPORT_POLL_MAX_ATTEMPTS */
export const EXPORT_POLL_MAX_ATTEMPTS = parseInt(
  process.env.GAMMA_EXPORT_POLL_MAX_ATTEMPTS ?? '12',
  10,
);

export interface BridgeState {
  port: number;
  token: string;
}

export class GammaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'GammaError';
  }
}

// ---------------------------------------------------------------------------
// Gamma API types
// ---------------------------------------------------------------------------

export type GenerationFormat = 'presentation' | 'document' | 'webpage' | 'social';
export type TextMode = 'generate' | 'condense' | 'preserve';
export type TextAmount = 'brief' | 'medium' | 'detailed' | 'extensive';
export type ImageSource =
  | 'aiGenerated'
  | 'pictographic'
  | 'unsplash'
  | 'giphy'
  | 'webAllImages'
  | 'webFreeToUse'
  | 'webFreeToUseCommercially'
  | 'placeholder'
  | 'noImages';
export type CardDimensions =
  | 'fluid'
  | '16x9'
  | '4x3'
  | 'pageless'
  | 'letter'
  | 'a4'
  | '1x1'
  | '4x5'
  | '9x16';
export type CardSplit = 'auto' | 'inputTextBreaks';
export type AccessLevel = 'noAccess' | 'view' | 'comment' | 'edit' | 'fullAccess';

export interface HeaderFooterItem {
  type: 'text' | 'image' | 'cardNumber';
  value?: string;
  source?: 'themeLogo' | 'custom';
  src?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export interface HeaderFooterOptions {
  topLeft?: HeaderFooterItem;
  topRight?: HeaderFooterItem;
  topCenter?: HeaderFooterItem;
  bottomLeft?: HeaderFooterItem;
  bottomRight?: HeaderFooterItem;
  bottomCenter?: HeaderFooterItem;
  hideFromFirstCard?: boolean;
  hideFromLastCard?: boolean;
}

export interface GenerationRequest {
  inputText: string;
  format?: GenerationFormat;
  textMode?: TextMode;
  themeId?: string;
  numCards?: number;
  cardSplit?: CardSplit;
  additionalInstructions?: string;
  folderIds?: string[];
  exportAs?: 'pdf' | 'pptx';
  textOptions?: {
    amount?: TextAmount;
    tone?: string;
    audience?: string;
    language?: string;
  };
  imageOptions?: {
    source?: ImageSource;
    model?: string;
    style?: string;
  };
  cardOptions?: {
    dimensions?: CardDimensions;
    headerFooter?: HeaderFooterOptions;
  };
  sharingOptions?: {
    workspaceAccess?: AccessLevel;
    externalAccess?: Exclude<AccessLevel, 'fullAccess'>;
    emailOptions?: {
      recipients?: string[];
      access?: AccessLevel;
    };
  };
}

export interface CreateFromTemplateRequest {
  gammaId: string;
  prompt?: string;
  themeId?: string;
  folderIds?: string[];
  exportAs?: 'pdf' | 'pptx';
  imageOptions?: {
    source?: ImageSource;
    model?: string;
    style?: string;
  };
  sharingOptions?: {
    workspaceAccess?: AccessLevel;
    externalAccess?: Exclude<AccessLevel, 'fullAccess'>;
    emailOptions?: {
      recipients?: string[];
      access?: AccessLevel;
    };
  };
}

export interface GenerationResponse {
  generationId: string;
}

export interface GenerationStatus {
  generationId: string;
  status: 'pending' | 'completed' | 'failed';
  gammaUrl?: string;
  pdfUrl?: string;
  pptxUrl?: string;
  credits?: {
    deducted: number;
    remaining: number;
  };
  error?: string;
}

export interface Theme {
  id: string;
  name: string;
  type: 'standard' | 'custom';
  colorKeywords?: string[];
  toneKeywords?: string[];
}

export interface Folder {
  id: string;
  name: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}
