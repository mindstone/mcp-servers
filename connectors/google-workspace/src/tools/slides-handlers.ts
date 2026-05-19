import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getAccountManager, resolveEmail } from '../modules/accounts/index.js';
import { getSlidesService } from '../modules/slides/index.js';
import { extractPresentationIdFromUrl } from '../modules/slides/formatters.js';
import {
  ReadPresentationOptions,
  CreatePresentationOptions,
  GetSlideOptions,
  BatchUpdatePresentationOptions,
  ThumbnailOptions,
  PresentationResponse,
  SlideInfo,
  SlidesBatchUpdateResponse,
  SlidesThumbnail,
} from '../modules/slides/types.js';
import { McpToolResponse } from './types.js';
import {
  readAliasedBoolean,
  readAliasedNumber,
  readAliasedString,
  readAliasedValue
} from './arg-aliases.js';
import { wrapUntrustedContent, wrapUntrustedJsonStrings } from '../utils/untrusted-content.js';

// Handler argument types
interface ReadPresentationArgs {
  email?: string;
  presentation_id?: string;
  presentationId?: string;
  max_chars?: number;
  maxChars?: number;
  include_notes?: boolean;
  includeNotes?: boolean;
  return_json?: boolean;
  returnJson?: boolean;
}

interface CreatePresentationArgs {
  email?: string;
  title: string;
}

interface ListSlidesArgs {
  email?: string;
  presentation_id?: string;
  presentationId?: string;
  include_notes?: boolean;
  includeNotes?: boolean;
}

interface GetSlideArgs {
  email?: string;
  presentation_id?: string;
  presentationId?: string;
  slide_index?: number;
  slideIndex?: number;
  max_chars?: number;
  maxChars?: number;
  return_json?: boolean;
  returnJson?: boolean;
}

interface ExtractPresentationIdArgs {
  input: string;
}

interface BatchUpdatePresentationArgs {
  email?: string;
  presentation_id?: string;
  presentationId?: string;
  requests: object[];
  write_control?: {
    requiredRevisionId?: string;
  };
  writeControl?: {
    requiredRevisionId?: string;
  };
  return_json?: boolean;
  returnJson?: boolean;
}

interface GetSlideThumbnailArgs {
  email?: string;
  presentation_id?: string;
  presentationId?: string;
  slide_id?: string;
  slideId?: string;
  thumbnail_size?: 'SMALL' | 'MEDIUM' | 'LARGE';
  thumbnailSize?: 'SMALL' | 'MEDIUM' | 'LARGE';
}

/**
 * Format PresentationResponse as human-readable text
 */
function formatPresentationResponseAsText(pres: PresentationResponse): string {
  const lines: string[] = [];
  lines.push(`Presentation: ${pres.title}`);
  lines.push(`URL: ${pres.presentationUrl}`);
  lines.push(`ID: ${pres.presentationId}`);
  lines.push(`Slides: ${pres.slideCount}`);
  
  if (pres.truncated) {
    lines.push('Status: TRUNCATED (content exceeded limit)');
  }
  
  if (pres.content !== undefined) {
    lines.push('---');
    lines.push(pres.content);
  }
  
  return wrapUntrustedContent(lines.join('\n'), `google-workspace:slides:presentation/${pres.presentationId}`);
}

/**
 * Format SlideInfo array as human-readable text
 */
function formatSlidesAsText(slides: SlideInfo[]): string {
  if (!slides || slides.length === 0) {
    return 'No slides found.';
  }

  const lines: string[] = [];
  lines.push(`Slides: ${slides.length} slide${slides.length !== 1 ? 's' : ''}\n`);

  for (const slide of slides) {
    let line = `${slide.index + 1}. `;
    if (slide.title) {
      line += slide.title;
    } else {
      line += '(Untitled)';
    }
    line += ` [slideId: ${slide.slideId}]`;
    lines.push(line);
    
    if (slide.textContent?.trim()) {
      const preview = slide.textContent.trim().substring(0, 100);
      lines.push(`   Preview: ${preview}${slide.textContent.length > 100 ? '...' : ''}`);
    }
    
    if (slide.speakerNotes?.trim()) {
      const notesPreview = slide.speakerNotes.trim().substring(0, 50);
      lines.push(`   Notes: ${notesPreview}${slide.speakerNotes.length > 50 ? '...' : ''}`);
    }
  }

  return wrapUntrustedContent(lines.join('\n'), 'google-workspace:slides:list');
}

/**
 * Format single slide as human-readable text
 */
function formatSlideAsText(slide: SlideInfo): string {
  const lines: string[] = [];
  
  if (slide.title) {
    lines.push(`## Slide ${slide.index + 1}: ${slide.title}`);
  } else {
    lines.push(`## Slide ${slide.index + 1}`);
  }
  
  lines.push(`ID: ${slide.slideId}`);
  lines.push('---');
  
  if (slide.textContent?.trim()) {
    lines.push(slide.textContent.trim());
  } else {
    lines.push('(No text content)');
  }
  
  if (slide.speakerNotes?.trim()) {
    lines.push(`\n[Speaker Notes]: ${slide.speakerNotes.trim()}`);
  }
  
  return wrapUntrustedContent(lines.join('\n'), `google-workspace:slides:slide/${slide.slideId}`);
}

/**
 * Read a Google Slides presentation
 */
export async function handleReadPresentation(args: ReadPresentationArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const presentationId = readAliasedString(rawArgs, 'presentation_id', 'presentationId');
  const maxChars = readAliasedNumber(rawArgs, 'max_chars', 'maxChars');
  const includeNotes = readAliasedBoolean(rawArgs, 'include_notes', 'includeNotes');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const slidesService = getSlidesService();
    
    const options: ReadPresentationOptions = {
      maxChars,
      includeNotes,
      returnJson,
    };
    
    const result = await slidesService.getPresentation(email, presentationId as string, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to read presentation');
    }
    
    if (returnJson) {
      return wrapUntrustedJsonStrings(result.data, `google-workspace:slides:presentation/${presentationId}`);
    }
    
    // Format as human-readable text
    const presResponse = result.data as PresentationResponse;
    return formatPresentationResponseAsText(presResponse);
  });
}

/**
 * Create a new Google Slides presentation
 */
export async function handleCreatePresentation(args: CreatePresentationArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const slidesService = getSlidesService();
    
    const options: CreatePresentationOptions = {
      title: args.title,
    };
    
    const result = await slidesService.createPresentation(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to create presentation');
    }
    
    const presResponse = result.data as PresentationResponse;
    return `Presentation created successfully!\n\nTitle: ${presResponse.title}\nURL: ${presResponse.presentationUrl}\nID: ${presResponse.presentationId}`;
  });
}

/**
 * List slides in a Google Slides presentation
 */
export async function handleListSlides(args: ListSlidesArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const presentationId = readAliasedString(rawArgs, 'presentation_id', 'presentationId');
  const includeNotes = readAliasedBoolean(rawArgs, 'include_notes', 'includeNotes');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const slidesService = getSlidesService();
    
    const result = await slidesService.listSlides(email, presentationId as string, includeNotes);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to list slides');
    }
    
    const slides = result.data as SlideInfo[];
    return formatSlidesAsText(slides);
  });
}

/**
 * Get a specific slide from a Google Slides presentation
 */
export async function handleGetSlide(args: GetSlideArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const presentationId = readAliasedString(rawArgs, 'presentation_id', 'presentationId');
  const slideIndex = readAliasedNumber(rawArgs, 'slide_index', 'slideIndex');
  const maxChars = readAliasedNumber(rawArgs, 'max_chars', 'maxChars');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const slidesService = getSlidesService();
    
    const options: GetSlideOptions = {
      presentationId: presentationId as string,
      slideIndex,
      maxChars,
      returnJson,
    };
    
    const result = await slidesService.getSlide(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to get slide');
    }
    
    if (returnJson) {
      return wrapUntrustedJsonStrings(result.data, `google-workspace:slides:slide/${presentationId}`);
    }
    
    // Format as human-readable text
    const slides = result.data as SlideInfo[];
    if (slides.length === 0) {
      throw new McpError(ErrorCode.InternalError, 'No slide data returned');
    }
    
    return formatSlideAsText(slides[0]);
  });
}

/**
 * Extract presentation ID from URL or validate existing ID
 */
export async function handleExtractPresentationId(args: ExtractPresentationIdArgs): Promise<McpToolResponse | string | object> {
  const presentationId = extractPresentationIdFromUrl(args.input);
  
  if (!presentationId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Could not extract presentation ID from input: "${args.input}". Expected a Google Slides URL (e.g., https://docs.google.com/presentation/d/{id}/edit) or a valid presentation ID.`
    );
  }
  
  return `Presentation ID: ${presentationId}`;
}

/**
 * Batch update a Google Slides presentation with multiple operations
 */
export async function handleBatchUpdatePresentation(args: BatchUpdatePresentationArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const presentationIdInput = readAliasedString(rawArgs, 'presentation_id', 'presentationId');
  const writeControl = readAliasedValue<{ requiredRevisionId?: string }>(rawArgs, 'write_control', 'writeControl');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  // Extract presentation ID from URL or use raw ID
  const presentationId = extractPresentationIdFromUrl(presentationIdInput as string);
  if (!presentationId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid presentation ID or URL: "${presentationIdInput}". Provide a valid Google Slides URL or presentation ID.`
    );
  }
  
  return await accountManager.withTokenRenewal(email, async () => {
    const slidesService = getSlidesService();
    
    const options: BatchUpdatePresentationOptions = {
      requests: args.requests as BatchUpdatePresentationOptions['requests'],
      writeControl,
      returnJson,
    };
    
    const result = await slidesService.batchUpdate(email, presentationId, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to update presentation');
    }
    
    if (returnJson) {
      return wrapUntrustedJsonStrings(result.data, `google-workspace:slides:batch/${presentationId}`);
    }
    
    // Format as human-readable text
    const response = result.data as SlidesBatchUpdateResponse;
    const repliesCount = response.replies?.length ?? 0;
    const lines: string[] = [
      'Presentation updated successfully!',
      '',
      `Presentation ID: ${presentationId}`,
      `URL: https://docs.google.com/presentation/d/${presentationId}/edit`,
      `Changes applied: ${repliesCount} request(s)`,
    ];
    
    // Include revision ID if present in the response's write control
    if (response.writeControl?.requiredRevisionId) {
      lines.push(`Revision ID: ${response.writeControl.requiredRevisionId}`);
    }
    
    return lines.join('\n');
  });
}

/**
 * Get a thumbnail for a specific slide in a Google Slides presentation
 */
export async function handleGetSlideThumbnail(args: GetSlideThumbnailArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const presentationIdInput = readAliasedString(rawArgs, 'presentation_id', 'presentationId');
  const slideId = readAliasedString(rawArgs, 'slide_id', 'slideId');
  const thumbnailSize = readAliasedValue<'SMALL' | 'MEDIUM' | 'LARGE'>(rawArgs, 'thumbnail_size', 'thumbnailSize');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  // Extract presentation ID from URL or use raw ID
  const presentationId = extractPresentationIdFromUrl(presentationIdInput as string);
  if (!presentationId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid presentation ID or URL: "${presentationIdInput}". Provide a valid Google Slides URL or presentation ID.`
    );
  }
  
  return await accountManager.withTokenRenewal(email, async () => {
    const slidesService = getSlidesService();
    
    const options: ThumbnailOptions | undefined = thumbnailSize
      ? { thumbnailSize }
      : undefined;
    
    const result = await slidesService.getPageThumbnail(email, presentationId, slideId as string, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to get slide thumbnail');
    }
    
    // Format as human-readable text
    const thumbnail = result.data as SlidesThumbnail;
    const lines: string[] = [
      'Slide thumbnail generated!',
      '',
      `Slide ID: ${slideId}`,
      `Thumbnail URL: ${thumbnail.contentUrl}`,
      `Dimensions: ${thumbnail.width}x${thumbnail.height}`,
      '',
      'Note: This URL expires in 30 minutes.',
    ];
    
    return lines.join('\n');
  });
}
