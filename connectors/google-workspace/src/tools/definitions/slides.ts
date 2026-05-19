import { ToolMetadata } from "../../modules/tools/registry.js";

// Google Slides Tools
export const slidesTools: ToolMetadata[] = [
  {
    name: 'read_workspace_presentation',
    category: 'Slides/Presentations',
    description: `Read content from a Google Slides presentation.

    Returns human-readable text by default with slide content and optional speaker notes.
    Use return_json: true for the raw Google Slides API response.

    Usage examples:
    
    1. Simple read:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz" }
    
    2. Include speaker notes:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "include_notes": true }
    
    3. With character limit:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "max_chars": 10000 }
    
    4. Get raw JSON structure:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "return_json": true }
    
    Response includes:
    - Presentation title and URL
    - Slide count and content (default: up to 50,000 characters)
    - Truncation indicator if content exceeds limit
    
    Note: For very large presentations, consider using max_chars to limit response size.`,
    aliases: ['read_slides', 'get_presentation', 'view_presentation'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        presentation_id: {
          type: 'string',
          description: 'Google Slides presentation ID (from URL or extract_workspace_presentation_id)'
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default: 50000)'
        },
        include_notes: {
          type: 'boolean',
          description: 'Include speaker notes in output (default: false)'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw Google Slides API JSON instead of formatted text (default: false)'
        }
      },
      required: ['presentation_id']
    }
  },
  {
    name: 'create_workspace_presentation',
    category: 'Slides/Presentations',
    description: `Create a new Google Slides presentation.

    Creates a blank presentation with the specified title.

    Usage examples:
    
    1. Create presentation:
       { "email": "user@example.com", "title": "Q4 Review" }
    
    Returns the new presentation's ID and URL.
    Note: The presentation will contain a single blank slide.`,
    aliases: ['create_slides', 'new_presentation', 'make_presentation'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        title: {
          type: 'string',
          description: 'Title for the new presentation'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'list_workspace_presentation_slides',
    category: 'Slides/Presentations',
    description: `List all slides in a Google Slides presentation with metadata.

    Returns information about each slide including title and text preview.

    Usage examples:
    
    1. List slides:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz" }
    
    2. Include speaker notes:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "include_notes": true }
    
    Returns slide metadata: index, title (if present), text content preview, and optional speaker notes.`,
    aliases: ['list_slides', 'get_slides', 'presentation_slides'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        presentation_id: {
          type: 'string',
          description: 'Google Slides presentation ID'
        },
        include_notes: {
          type: 'boolean',
          description: 'Include speaker notes for each slide (default: false)'
        }
      },
      required: ['presentation_id']
    }
  },
  {
    name: 'get_workspace_slide',
    category: 'Slides/Presentations',
    description: `Get content from a specific slide in a Google Slides presentation.

    Retrieves detailed content from a single slide by its index (0-based).

    Usage examples:
    
    1. Get first slide:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz" }
    
    2. Get slide by index:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "slide_index": 2 }
    
    3. Get raw JSON:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "slide_index": 0, "return_json": true }
    
    Returns: slide title, text content, and speaker notes.`,
    aliases: ['get_single_slide', 'read_slide', 'view_slide'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        presentation_id: {
          type: 'string',
          description: 'Google Slides presentation ID'
        },
        slide_index: {
          type: 'number',
          description: 'Slide index (0-based, default: 0 for first slide)'
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters for text content (default: 50000)'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw slide JSON instead of formatted text (default: false)'
        }
      },
      required: ['presentation_id']
    }
  },
  {
    name: 'extract_workspace_presentation_id',
    category: 'Slides/Presentations',
    description: `Extract a Google Slides presentation ID from a URL or validate an existing ID.

    This is a utility tool that helps parse various Google Slides URL formats.

    Supported formats:
    - https://docs.google.com/presentation/d/{id}/edit
    - https://docs.google.com/presentation/d/{id}/edit?...
    - https://docs.google.com/presentation/d/{id}
    - Just the presentation ID itself

    Usage examples:
    
    1. Extract from URL:
       { "input": "https://docs.google.com/presentation/d/1ABC123xyz/edit" }
    
    2. Validate existing ID:
       { "input": "1ABC123xyz" }
    
    Returns the extracted/validated presentation ID.`,
    aliases: ['parse_slides_url', 'get_presentation_id', 'presentation_id_from_url'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Google Slides URL or presentation ID to parse'
        }
      },
      required: ['input']
    }
  },
  {
    name: 'batch_update_workspace_presentation',
    category: 'Slides/Presentations',
    description: `Execute multiple updates to a Google Slides presentation in a single request.

    This is the low-level API for modifying presentations. It accepts an array of request objects
    that are passed directly to the Google Slides API batchUpdate endpoint.

    Common request types include:
    - createSlide: Add a new slide to the presentation
    - duplicateObject: Copy an existing slide or element
    - deleteObject: Remove a slide, shape, or other element
    - insertText: Add text to a shape or text box
    - replaceAllText: Find and replace text throughout the presentation
    - updateTextStyle: Format text (bold, italic, font, color, etc.)
    - createShape: Add shapes (rectangles, ellipses, etc.)
    - createTable: Add a table to a slide
    - createImage: Insert an image from URL
    - updateSlidesPosition: Reorder slides
    - updatePageProperties: Modify slide background, size, etc.

    Usage examples:
    
    1. Create a new slide:
       { 
         "email": "user@example.com", 
         "presentation_id": "1ABC123xyz",
         "requests": [
           { "createSlide": { "insertionIndex": 1, "slideLayoutReference": { "predefinedLayout": "TITLE_AND_BODY" } } }
         ]
       }
    
    2. Insert text into a shape:
       {
         "email": "user@example.com",
         "presentation_id": "1ABC123xyz",
         "requests": [
           { "insertText": { "objectId": "shape123", "insertionIndex": 0, "text": "Hello World" } }
         ]
       }
    
    3. Replace all occurrences of text:
       {
         "email": "user@example.com",
         "presentation_id": "1ABC123xyz",
         "requests": [
           { "replaceAllText": { "containsText": { "text": "{{placeholder}}", "matchCase": true }, "replaceText": "Actual Value" } }
         ]
       }
    
    4. Delete an object:
       {
         "email": "user@example.com",
         "presentation_id": "1ABC123xyz",
         "requests": [
           { "deleteObject": { "objectId": "slide456" } }
         ]
       }
    
    5. Multiple operations with revision control:
       {
         "email": "user@example.com",
         "presentation_id": "1ABC123xyz",
         "requests": [
           { "replaceAllText": { "containsText": { "text": "{{date}}" }, "replaceText": "2025-01-15" } },
           { "replaceAllText": { "containsText": { "text": "{{author}}" }, "replaceText": "John Doe" } }
         ],
         "write_control": { "requiredRevisionId": "abc123" }
       }
    
    Note: Changes are atomic - if any request fails, none are applied. Use return_json: true
    to see the full API response including created object IDs.
    
    Returns: Success message with update count, or raw API response with return_json: true.
    
    Reference: https://developers.google.com/slides/api/reference/rest/v1/presentations/batchUpdate`,
    aliases: ['batch_update_slides', 'update_presentation', 'modify_presentation'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        presentation_id: {
          type: 'string',
          description: 'Google Slides presentation ID or URL'
        },
        requests: {
          type: 'array',
          items: {
            type: 'object'
          },
          description: 'Array of update request objects (see Google Slides API reference for schema)'
        },
        write_control: {
          type: 'object',
          properties: {
            requiredRevisionId: {
              type: 'string',
              description: 'Revision ID for optimistic concurrency control (optional)'
            }
          },
          description: 'Optional write control settings'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw API response instead of formatted text (default: false)'
        }
      },
      required: ['presentation_id', 'requests']
    }
  },
  {
    name: 'get_workspace_slide_thumbnail',
    category: 'Slides/Presentations',
    description: `Get a thumbnail image URL for a specific slide in a Google Slides presentation.

    Generates a temporary URL to a PNG image of the slide. Useful for:
    - Creating slide previews
    - Building slide navigation UIs
    - Generating presentation summaries with images

    IMPORTANT: The returned URL expires after 30 minutes. Download or use the image before expiration.

    Usage examples:
    
    1. Get default (medium) thumbnail:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "slide_id": "p" }
    
    2. Get large thumbnail:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "slide_id": "p", "thumbnail_size": "LARGE" }
    
    3. Get small thumbnail for quick preview:
       { "email": "user@example.com", "presentation_id": "1ABC123xyz", "slide_id": "g12345", "thumbnail_size": "SMALL" }
    
    Thumbnail sizes:
    - SMALL: 200px width
    - MEDIUM: 800px width (default)
    - LARGE: 1600px width

    Returns: Thumbnail URL, dimensions, and expiration note.
    
    Note: Use list_workspace_presentation_slides to get slide IDs (slideId field).`,
    aliases: ['get_slide_thumbnail', 'slide_preview'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        presentation_id: {
          type: 'string',
          description: 'Google Slides presentation ID or URL'
        },
        slide_id: {
          type: 'string',
          description: 'Slide object ID (from list_workspace_presentation_slides)'
        },
        thumbnail_size: {
          type: 'string',
          enum: ['SMALL', 'MEDIUM', 'LARGE'],
          description: 'Size of the thumbnail (default: MEDIUM)'
        }
      },
      required: ['presentation_id', 'slide_id']
    }
  }
];
