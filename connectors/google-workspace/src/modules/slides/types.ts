import { slides_v1 } from 'googleapis';

// Re-export Google API types for convenience
export type SlidesPresentation = slides_v1.Schema$Presentation;
export type SlidesRequest = slides_v1.Schema$Request;
export type SlidesBatchUpdateResponse = slides_v1.Schema$BatchUpdatePresentationResponse;
export type SlidesPage = slides_v1.Schema$Page;
export type SlidesPageElement = slides_v1.Schema$PageElement;
export type SlidesShape = slides_v1.Schema$Shape;
export type SlidesTextContent = slides_v1.Schema$TextContent;
export type SlidesTextElement = slides_v1.Schema$TextElement;
export type SlidesTextRun = slides_v1.Schema$TextRun;
export type SlidesThumbnail = slides_v1.Schema$Thumbnail;
export type SlidesWriteControl = slides_v1.Schema$WriteControl;

export interface ReadPresentationOptions {
  maxChars?: number;
  includeNotes?: boolean;
  returnJson?: boolean; // Default: false (human-readable text)
}

export interface BatchUpdatePresentationOptions {
  requests: SlidesRequest[];
  writeControl?: SlidesWriteControl;
  returnJson?: boolean; // Default: false (human-readable summary)
}

export interface ThumbnailOptions {
  mimeType?: 'PNG';
  thumbnailSize?: 'SMALL' | 'MEDIUM' | 'LARGE';
}

export interface CreatePresentationOptions {
  title: string;
}

export interface GetSlideOptions {
  presentationId: string;
  slideIndex?: number; // 0-based, defaults to first slide
  maxChars?: number;
  returnJson?: boolean;
}

export interface SlideInfo {
  slideId: string;
  index: number;
  title?: string;
  textContent?: string;
  speakerNotes?: string;
}

export interface PresentationResponse {
  title: string;
  presentationId: string;
  presentationUrl: string;
  slideCount: number;
  slides?: SlideInfo[];
  content?: string;
  truncated?: boolean;
  revisionId?: string;
}

export interface SlidesOperationResult {
  success: boolean;
  data?: PresentationResponse | SlidesPresentation | SlideInfo[] | SlidesBatchUpdateResponse | SlidesThumbnail;
  error?: string;
}

export interface ExtractPresentationIdResult {
  success: boolean;
  presentationId?: string;
  error?: string;
}
