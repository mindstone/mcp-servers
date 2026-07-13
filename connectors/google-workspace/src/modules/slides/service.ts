import { google, slides_v1 } from 'googleapis';
import { BaseGoogleService } from '../../services/base/BaseGoogleService.js';
import {
  SlidesOperationResult,
  ReadPresentationOptions,
  CreatePresentationOptions,
  GetSlideOptions,
  BatchUpdatePresentationOptions,
  ThumbnailOptions,
  PresentationResponse,
  SlideInfo,
} from './types.js';
import { SLIDES_SCOPES } from './scopes.js';
import { describeApiError } from '../../utils/apiError.js';

const DEFAULT_MAX_CHARS = 50000;
const TRUNCATION_MARKER = '\n\n[TRUNCATED - presentation exceeds character limit]';

export class SlidesService extends BaseGoogleService<slides_v1.Slides> {
  private initialized = false;

  constructor() {
    super({
      serviceName: 'Google Slides',
      version: 'v1',
    });
  }

  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      this.initialized = true;
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize Slides service');
    }
  }

  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private checkInitialized(): void {
    if (!this.initialized) {
      throw this.handleError(
        new Error('Slides service not initialized'),
        'Please ensure the service is initialized before use'
      );
    }
  }

  /**
   * Construct a Google Slides URL from presentation ID
   */
  private constructPresentationUrl(presentationId: string): string {
    return `https://docs.google.com/presentation/d/${presentationId}/edit`;
  }

  /**
   * Extract text content from a slide's page elements
   */
  private extractTextFromPageElements(elements: slides_v1.Schema$PageElement[] | undefined): string {
    if (!elements) {
      return '';
    }

    const textParts: string[] = [];

    for (const element of elements) {
      // Handle shapes with text
      if (element.shape?.text?.textElements) {
        for (const textElement of element.shape.text.textElements) {
          if (textElement.textRun?.content) {
            textParts.push(textElement.textRun.content);
          }
        }
      }

      // Handle tables
      if (element.table?.tableRows) {
        for (const row of element.table.tableRows) {
          if (row.tableCells) {
            for (const cell of row.tableCells) {
              if (cell.text?.textElements) {
                for (const textElement of cell.text.textElements) {
                  if (textElement.textRun?.content) {
                    textParts.push(textElement.textRun.content);
                  }
                }
              }
            }
          }
        }
      }

      // Handle groups (recursive)
      if (element.elementGroup?.children) {
        const groupText = this.extractTextFromPageElements(element.elementGroup.children);
        if (groupText) {
          textParts.push(groupText);
        }
      }
    }

    return textParts.join('');
  }

  /**
   * Extract speaker notes from a slide
   */
  private extractSpeakerNotes(slide: slides_v1.Schema$Page): string {
    const notesPage = slide.slideProperties?.notesPage;
    if (!notesPage?.pageElements) {
      return '';
    }

    // Notes are typically in a shape with placeholder type BODY
    for (const element of notesPage.pageElements) {
      if (element.shape?.placeholder?.type === 'BODY' && element.shape.text?.textElements) {
        const notesText: string[] = [];
        for (const textElement of element.shape.text.textElements) {
          if (textElement.textRun?.content) {
            notesText.push(textElement.textRun.content);
          }
        }
        return notesText.join('').trim();
      }
    }

    return '';
  }

  /**
   * Get the title from a slide (usually in a TITLE or CENTERED_TITLE placeholder)
   */
  private extractSlideTitle(slide: slides_v1.Schema$Page): string | undefined {
    if (!slide.pageElements) {
      return undefined;
    }

    for (const element of slide.pageElements) {
      const placeholderType = element.shape?.placeholder?.type;
      if (
        (placeholderType === 'TITLE' || placeholderType === 'CENTERED_TITLE') &&
        element.shape?.text?.textElements
      ) {
        const titleParts: string[] = [];
        for (const textElement of element.shape.text.textElements) {
          if (textElement.textRun?.content) {
            titleParts.push(textElement.textRun.content);
          }
        }
        const title = titleParts.join('').trim();
        if (title) {
          return title;
        }
      }
    }

    return undefined;
  }

  /**
   * Process slides into SlideInfo array
   */
  private processSlidesToInfo(
    slides: slides_v1.Schema$Page[],
    includeNotes: boolean
  ): SlideInfo[] {
    return slides.map((slide, index) => {
      const info: SlideInfo = {
        slideId: slide.objectId || `slide-${index}`,
        index,
        title: this.extractSlideTitle(slide),
        textContent: this.extractTextFromPageElements(slide.pageElements),
      };

      if (includeNotes) {
        info.speakerNotes = this.extractSpeakerNotes(slide);
      }

      return info;
    });
  }

  /**
   * Read a presentation and return its content
   */
  async getPresentation(
    email: string,
    presentationId: string,
    options: ReadPresentationOptions = {}
  ): Promise<SlidesOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SLIDES_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.slides({ version: 'v1', auth })
      );

      const response = await client.presentations.get({
        presentationId,
      });

      const presentation = response.data;
      const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
      const includeNotes = options.includeNotes ?? false;

      // Process slides
      const slides = presentation.slides || [];
      const slidesInfo = this.processSlidesToInfo(slides, includeNotes);

      // Build text content
      const contentParts: string[] = [];
      for (const slideInfo of slidesInfo) {
        if (slideInfo.title) {
          contentParts.push(`## Slide ${slideInfo.index + 1}: ${slideInfo.title}`);
        } else {
          contentParts.push(`## Slide ${slideInfo.index + 1}`);
        }

        if (slideInfo.textContent?.trim()) {
          contentParts.push(slideInfo.textContent.trim());
        }

        if (includeNotes && slideInfo.speakerNotes?.trim()) {
          contentParts.push(`\n[Speaker Notes]: ${slideInfo.speakerNotes.trim()}`);
        }

        contentParts.push('');
      }

      let textContent = contentParts.join('\n');
      let truncated = false;

      if (textContent.length > maxChars) {
        textContent = textContent.substring(0, maxChars) + TRUNCATION_MARKER;
        truncated = true;
      }

      const result: PresentationResponse = {
        title: presentation.title || 'Untitled',
        presentationId: presentation.presentationId || presentationId,
        presentationUrl: this.constructPresentationUrl(presentation.presentationId || presentationId),
        slideCount: slides.length,
        content: textContent,
        truncated,
        revisionId: presentation.revisionId || undefined,
      };

      return {
        success: true,
        data: options.returnJson ? presentation : result,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Create a new presentation
   */
  async createPresentation(
    email: string,
    options: CreatePresentationOptions
  ): Promise<SlidesOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SLIDES_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.slides({ version: 'v1', auth })
      );

      const response = await client.presentations.create({
        requestBody: {
          title: options.title,
        },
      });

      const presentationId = response.data.presentationId;
      if (!presentationId) {
        return {
          success: false,
          error: 'Failed to create presentation - no presentationId returned',
        };
      }

      const result: PresentationResponse = {
        title: options.title,
        presentationId,
        presentationUrl: this.constructPresentationUrl(presentationId),
        slideCount: response.data.slides?.length || 0,
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * List slides in a presentation with metadata
   */
  async listSlides(
    email: string,
    presentationId: string,
    includeNotes: boolean = false
  ): Promise<SlidesOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SLIDES_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.slides({ version: 'v1', auth })
      );

      const response = await client.presentations.get({
        presentationId,
      });

      const slides = response.data.slides || [];
      const slidesInfo = this.processSlidesToInfo(slides, includeNotes);

      return {
        success: true,
        data: slidesInfo,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Get a specific slide by index
   */
  async getSlide(
    email: string,
    options: GetSlideOptions
  ): Promise<SlidesOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SLIDES_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.slides({ version: 'v1', auth })
      );

      const response = await client.presentations.get({
        presentationId: options.presentationId,
      });

      const slides = response.data.slides || [];
      const slideIndex = options.slideIndex ?? 0;

      if (slideIndex < 0 || slideIndex >= slides.length) {
        return {
          success: false,
          error: `Slide index ${slideIndex} is out of range. Presentation has ${slides.length} slides (0-${slides.length - 1}).`,
        };
      }

      const slide = slides[slideIndex];
      const slideInfo: SlideInfo = {
        slideId: slide.objectId || `slide-${slideIndex}`,
        index: slideIndex,
        title: this.extractSlideTitle(slide),
        textContent: this.extractTextFromPageElements(slide.pageElements),
        speakerNotes: this.extractSpeakerNotes(slide),
      };

      // Apply character limit if specified
      const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
      if (slideInfo.textContent && slideInfo.textContent.length > maxChars) {
        slideInfo.textContent = slideInfo.textContent.substring(0, maxChars) + TRUNCATION_MARKER;
      }

      if (options.returnJson) {
        return {
          success: true,
          data: slide as unknown as PresentationResponse,
        };
      }

      return {
        success: true,
        data: [slideInfo],
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Batch update a presentation with multiple operations
   * This is the core API for modifying presentations programmatically.
   *
   * @param email - User email for authentication
   * @param presentationId - ID of the presentation to update
   * @param options - BatchUpdatePresentationOptions containing requests array and optional writeControl
   * @returns SlidesOperationResult with SlidesBatchUpdateResponse data
   */
  async batchUpdate(
    email: string,
    presentationId: string,
    options: BatchUpdatePresentationOptions
  ): Promise<SlidesOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SLIDES_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.slides({ version: 'v1', auth })
      );

      const response = await client.presentations.batchUpdate({
        presentationId,
        requestBody: {
          requests: options.requests,
          writeControl: options.writeControl,
        },
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Get a thumbnail image for a specific slide page
   *
   * @param email - User email for authentication
   * @param presentationId - ID of the presentation
   * @param pageObjectId - Object ID of the slide/page to generate thumbnail for
   * @param options - Optional thumbnail settings (mimeType, thumbnailSize)
   * @returns SlidesOperationResult with SlidesThumbnail data containing contentUrl, width, height
   */
  async getPageThumbnail(
    email: string,
    presentationId: string,
    pageObjectId: string,
    options?: ThumbnailOptions
  ): Promise<SlidesOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      // Use FULL scope for consistency - READONLY tokens are rare in practice
      await this.validateScopes(email, [SLIDES_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.slides({ version: 'v1', auth })
      );

      // googleapis requires dotted query param keys for thumbnail properties
      const response = await client.presentations.pages.getThumbnail({
        presentationId,
        pageObjectId,
        'thumbnailProperties.mimeType': options?.mimeType || 'PNG',
        'thumbnailProperties.thumbnailSize': options?.thumbnailSize || 'MEDIUM',
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }
}
