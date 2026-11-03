/**
 * PowerPoint command handlers — maps sidecar command actions to Office.js PowerPoint API calls.
 * Each handler receives arbitrary params and returns a structured CommandResult.
 * Runs in the Office WebView (browser context).
 *
 * Requires PowerPointApi 1.2+ for slide manipulation, 1.3+ for shapes.
 * Some features (speaker notes, advanced shape manipulation) require newer API sets.
 */

import { executePowerpointCommand, fail, type CommandResult } from '../officeExecutor.js';

export type PowerpointCommandHandler = (params: Record<string, unknown>) => Promise<CommandResult>;

function requireShapeFormatting(): void {
  if (!Office.context.requirements.isSetSupported('PowerPointApi', '1.4')) {
    fail('UNSUPPORTED_OPERATION', 'Shape formatting requires PowerPointApi 1.4. Update Office before adding a formatted shape.');
  }
}

const powerpointCommands: Record<string, PowerpointCommandHandler> = {
  get_slides: getSlides,
  get_slide_content: getSlideContent,
  add_slide: addSlide,
  apply_layout: applyLayout,
  delete_slide: deleteSlide,
  reorder_slides: reorderSlides,
  add_text_box: addTextBox,
  add_image: addImage,
  add_shape: addShape,
  delete_shape: deleteShape,
  format_shape: formatShape,
  update_text: updateText,
  get_speaker_notes: getSpeakerNotes,
  set_speaker_notes: setSpeakerNotes,
  get_presentation_properties: getPresentationProperties,
};

/**
 * Look up a PowerPoint command handler by action name.
 * Returns null if the action is not recognized.
 */
export function getPowerpointCommandHandler(action: string): PowerpointCommandHandler | null {
  return powerpointCommands[action] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a slide by 1-based index. */
function getSlideByIndex(
  slides: PowerPoint.SlideCollection,
  slideIndex: number,
): PowerPoint.Slide {
  // PowerPoint.js uses 0-based getItemAt, but our API is 1-based
  return slides.getItemAt(slideIndex - 1);
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

/**
 * get_slides — List all slides with summaries.
 * Params:
 *   limit (number, default 100)
 */
async function getSlides(params: Record<string, unknown>): Promise<CommandResult> {
  const limit =
    typeof params['limit'] === 'number' && params['limit'] > 0 ? params['limit'] : 100;

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load(['id']);
    await context.sync();

    const result: Array<{
      slideNumber: number;
      id: string;
      shapeCount: number;
      title: string;
    }> = [];

    const count = Math.min(slides.items.length, limit);

    for (let i = 0; i < count; i++) {
      const slide = slides.items[i]!;
      const shapes = slide.shapes;
      shapes.load(['id', 'type', 'name']);
      await context.sync();

      // Try to find a title shape
      let title = '';
      for (const shape of shapes.items) {
        if (shape.name.toLowerCase().includes('title')) {
          try {
            const textFrame = shape.textFrame;
            textFrame.load('textRange/text');
            await context.sync();
            title = textFrame.textRange.text;
          } catch {
            // Shape may not have text; skip
          }
          break;
        }
      }

      result.push({
        slideNumber: i + 1,
        id: slide.id,
        shapeCount: shapes.items.length,
        title,
      });
    }

    return { slideCount: slides.items.length, slides: result };
  });
}

/**
 * get_slide_content — Get full content of a specific slide.
 * Params:
 *   slideIndex (number, required) — 1-based slide index
 */
async function getSlideContent(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return {
      success: false,
      error: 'The "slideIndex" parameter is required and must be a positive number.',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT',
        `Slide index ${slideIndex} out of range. Presentation has ${slides.items.length} slides.`,
      );
    }

    const slide = getSlideByIndex(slides, slideIndex);
    const shapes = slide.shapes;
    shapes.load(['id', 'name', 'type', 'left', 'top', 'width', 'height']);
    await context.sync();

    const shapeDetails: Array<{
      id: string;
      name: string;
      type: string;
      position: { left: number; top: number; width: number; height: number };
      text?: string;
    }> = [];

    for (const shape of shapes.items) {
      const detail: (typeof shapeDetails)[number] = {
        id: shape.id,
        name: shape.name,
        type: String(shape.type),
        position: {
          left: shape.left,
          top: shape.top,
          width: shape.width,
          height: shape.height,
        },
      };

      // Try to load text content from shapes that support it
      try {
        const textFrame = shape.textFrame;
        textFrame.load('textRange/text');
        await context.sync();
        detail.text = textFrame.textRange.text;
      } catch {
        // Shape doesn't support text (e.g., images); skip
      }

      shapeDetails.push(detail);
    }

    return {
      slideNumber: slideIndex,
      slideId: slide.id,
      shapeCount: shapes.items.length,
      shapes: shapeDetails,
    };
  });
}

/**
 * add_slide — Add a new slide to the presentation.
 * Params:
 *   layout   (string, optional, default "Title and Content")
 *   position (number, optional) — 1-based insert position; default end
 *   title    (string, optional)
 *   subtitle (string, optional)
 *   body     (string, optional)
 */
async function addSlide(params: Record<string, unknown>): Promise<CommandResult> {
  const layoutName = typeof params['layout'] === 'string' ? params['layout'] : undefined;
  const position = typeof params['position'] === 'number' ? params['position'] : undefined;
  const title = typeof params['title'] === 'string' ? params['title'] : undefined;
  const subtitle = typeof params['subtitle'] === 'string' ? params['subtitle'] : undefined;
  const body = typeof params['body'] === 'string' ? params['body'] : undefined;

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (position !== undefined && (!Number.isInteger(position) || position < 1 || position > slides.items.length + 1)) {
      fail('INVALID_ARGUMENT', `Slide position ${position} out of range. Presentation has ${slides.items.length} slides.`);
    }

    // Resolve the requested layout against the slide masters (if given)
    let addOptions: PowerPoint.AddSlideOptions | undefined;
    if (layoutName) {
      const { layout, available } = await findLayoutByName(context, layoutName);
      if (!layout) {
        fail('ITEM_NOT_FOUND',
        `Layout "${layoutName}" not found. Available layouts: ${available.join(', ') || '(none found)'}.`,
        );
      }
      addOptions = { layoutId: layout.id };
    }

    const previousCount = slides.items.length;
    if (position !== undefined && (!Office.context.requirements.isSetSupported('PowerPointApi', '1.8') || typeof slides.getItemAt(0).moveTo !== 'function')) {
      fail('UNSUPPORTED_OPERATION', 'Moving slides requires a newer version of PowerPoint.');
    }

    slides.add(addOptions);
    const newSlide = slides.getItemAt(previousCount);
    if (position !== undefined) newSlide.moveTo(position - 1);
    newSlide.load('id');
    const hasText = title !== undefined || subtitle !== undefined || body !== undefined;
    if (hasText) newSlide.shapes.load(['id', 'name', 'type']);
    await context.sync();

    if (hasText) {
      try {
        for (const [placeholder, text] of [['subtitle', subtitle], ['title', title], ['body', body]] as const) {
          if (text === undefined) continue;
          const shape = newSlide.shapes.items.find((s) => {
            const name = s.name.toLowerCase();
            return placeholder === 'body' ? /content|body|text/.test(name)
              : name.includes(placeholder) && (placeholder !== 'title' || !name.includes('subtitle'));
          });
          if (!shape) fail('ITEM_NOT_FOUND', `Placeholder "${placeholder}" not found.`);
          shape.textFrame.textRange.text = text;
        }
        await context.sync();
      } catch (error) {
        fail('PARTIAL', `Created slide id: ${newSlide.id}, but could not finish the request: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      success: true,
      slideNumber: position ?? previousCount + 1,
      slideId: newSlide.id,
    };
  });
}

/**
 * delete_slide — Delete a slide by index.
 * Params:
 *   slideIndex (number, required) — 1-based
 */
async function deleteSlide(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return {
      success: false,
      error: 'The "slideIndex" parameter is required and must be a positive number.',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT',
        `Slide index ${slideIndex} out of range. Presentation has ${slides.items.length} slides.`,
      );
    }

    const slide = getSlideByIndex(slides, slideIndex);
    slide.delete();
    await context.sync();

    return { success: true, deletedSlide: slideIndex };
  });
}

/**
 * reorder_slides — Move a slide to a new position.
 * Params:
 *   fromIndex (number, required) — current 1-based index
 *   toIndex   (number, required) — target 1-based position
 */
async function reorderSlides(params: Record<string, unknown>): Promise<CommandResult> {
  const fromIndex = params['fromIndex'];
  const toIndex = params['toIndex'];

  if (typeof fromIndex !== 'number' || fromIndex < 1) {
    return { success: false, error: 'The "fromIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }
  if (typeof toIndex !== 'number' || toIndex < 1) {
    return { success: false, error: 'The "toIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (fromIndex > slides.items.length || toIndex > slides.items.length) {
      fail('INVALID_ARGUMENT',
        `Slide index out of range. Presentation has ${slides.items.length} slides.`,
      );
    }

    const slide = getSlideByIndex(slides, fromIndex);
    slide.moveTo(toIndex - 1); // 0-based target index
    await context.sync();

    return { success: true, from: fromIndex, to: toIndex };
  });
}

/**
 * add_text_box — Add a text box to a slide.
 * Params:
 *   slideIndex (number, required) — 1-based
 *   text       (string, required)
 *   position   (object, required) — { left, top, width, height } in points
 *   formatting (object, optional) — fontFamily, fontSize, fontColor, bold, italic, alignment
 */
async function addTextBox(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return { success: false, error: 'The "slideIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const text = params['text'];
  if (typeof text !== 'string') {
    return { success: false, error: 'The "text" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const position = params['position'] as { left?: number; top?: number; width?: number; height?: number } | undefined;
  if (!position || typeof position.left !== 'number' || typeof position.top !== 'number') {
    return { success: false, error: 'The "position" parameter with left and top is required.', code: 'INVALID_ARGUMENT' };
  }

  const formatting = params['formatting'] as Record<string, unknown> | undefined;

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT', `Slide index ${slideIndex} out of range.`);
    }

    const slide = getSlideByIndex(slides, slideIndex);
    if (formatting && Object.keys(formatting).length > 0) requireShapeFormatting();
    const shape = slide.shapes.addTextBox(text as string, {
      left: position.left!,
      top: position.top!,
      width: position.width ?? 300,
      height: position.height ?? 50,
    });

    // Apply formatting if specified
    if (formatting) {
      const textRange = shape.textFrame.textRange;
      const font = textRange.font;
      if (typeof formatting['fontFamily'] === 'string') font.name = formatting['fontFamily'];
      if (typeof formatting['fontSize'] === 'number') font.size = formatting['fontSize'];
      if (typeof formatting['fontColor'] === 'string') font.color = formatting['fontColor'];
      if (typeof formatting['bold'] === 'boolean') font.bold = formatting['bold'];
      if (typeof formatting['italic'] === 'boolean') font.italic = formatting['italic'];
      if (typeof formatting['alignment'] === 'string') {
        const alignments = { left: 'Left', center: 'Center', right: 'Right', justified: 'Justify' } as const;
        textRange.paragraphFormat.horizontalAlignment = alignments[formatting['alignment'] as keyof typeof alignments];
      }
    }

    shape.load('id');
    await context.sync();

    return { success: true, shapeId: shape.id };
  });
}

/**
 * add_image — Add an image to a slide from base64 data.
 * Params:
 *   slideIndex (number, required) — 1-based
 *   source     (object, required) — { type, filePath?, base64?, mimeType? }
 *   position   (object, required) — { left, top, width, height } in points
 */
async function addImage(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return { success: false, error: 'The "slideIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const source = params['source'] as { type: string; base64?: string; mimeType?: string } | undefined;
  if (!source || typeof source.type !== 'string') {
    return { success: false, error: 'The "source" parameter with a "type" field is required.', code: 'INVALID_ARGUMENT' };
  }

  let base64Data: string;
  if (source.type === 'base64') {
    if (typeof source.base64 !== 'string' || source.base64.length === 0) {
      return { success: false, error: 'The "base64" field is required when source type is "base64".', code: 'INVALID_ARGUMENT' };
    }
    base64Data = source.base64;
  } else if (source.type === 'filePath') {
    // File paths must be converted to base64 by the sidecar before reaching the add-in
    if (typeof source.base64 !== 'string' || source.base64.length === 0) {
      return { success: false, error: 'File path images must be converted to base64 by the sidecar before reaching the add-in.', code: 'INVALID_ARGUMENT' };
    }
    base64Data = source.base64;
  } else {
    return { success: false, error: `Unsupported source type: "${source.type}".`, code: 'INVALID_ARGUMENT' };
  }

  const position = params['position'] as { left?: number; top?: number; width?: number; height?: number } | undefined;
  if (!position || typeof position.left !== 'number' || typeof position.top !== 'number') {
    return { success: false, error: 'The "position" parameter with left and top is required.', code: 'INVALID_ARGUMENT' };
  }

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT', `Slide index ${slideIndex} out of range.`);
    }

    const slide = getSlideByIndex(slides, slideIndex);

    // PowerPoint addImage requires PowerPointApi 1.4+ but isn't in all @types/office-js versions.
    // Runtime-check for availability and provide a clear upgrade message if missing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shapesAny = slide.shapes as any;
    if (typeof shapesAny.addImage !== 'function') {
      return {
        success: false,
        error: 'Adding images to slides requires PowerPointApi 1.4+. Update Office to the latest version for this feature.',
        code: 'UNSUPPORTED_OPERATION',
      };
    }

    const contentType = source.mimeType ?? 'image/png';
    const shape = shapesAny.addImage(base64Data, contentType, {
      left: position.left!,
      top: position.top!,
      width: position.width ?? 200,
      height: position.height ?? 200,
    }) as PowerPoint.Shape;

    shape.load('id');
    await context.sync();

    return { success: true, shapeId: shape.id };
  });
}

/**
 * add_shape — Add a geometric shape to a slide.
 * Params:
 *   slideIndex (number, required) — 1-based
 *   shapeType  (string, required) — e.g., "rectangle", "ellipse", "rightArrow"
 *   position   (object, required) — { left, top, width, height } in points
 *   text       (string, optional) — text inside the shape
 *   fillColor  (string, optional) — hex fill color
 *   lineColor  (string, optional) — hex line color
 *   lineWidth  (number, optional) — line width in points
 */
async function addShape(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return { success: false, error: 'The "slideIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const shapeType = params['shapeType'];
  if (typeof shapeType !== 'string') {
    return { success: false, error: 'The "shapeType" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const position = params['position'] as { left?: number; top?: number; width?: number; height?: number } | undefined;
  if (!position || typeof position.left !== 'number' || typeof position.top !== 'number') {
    return { success: false, error: 'The "position" parameter with left and top is required.', code: 'INVALID_ARGUMENT' };
  }

  const shapeTypeMap: Record<string, PowerPoint.GeometricShapeType> = {
    rectangle: PowerPoint.GeometricShapeType.rectangle,
    ellipse: PowerPoint.GeometricShapeType.ellipse,
    roundedRectangle: PowerPoint.GeometricShapeType.roundRectangle,
    triangle: PowerPoint.GeometricShapeType.triangle,
    rightArrow: PowerPoint.GeometricShapeType.rightArrow,
    star5: PowerPoint.GeometricShapeType.star5,
    diamond: PowerPoint.GeometricShapeType.diamond,
    hexagon: PowerPoint.GeometricShapeType.hexagon,
    pentagon: PowerPoint.GeometricShapeType.pentagon,
    octagon: PowerPoint.GeometricShapeType.octagon,
    heart: PowerPoint.GeometricShapeType.heart,
    cloud: PowerPoint.GeometricShapeType.cloud,
    lightningBolt: PowerPoint.GeometricShapeType.lightningBolt,
  };

  return executePowerpointCommand(async (context) => {
    if (!Object.prototype.hasOwnProperty.call(shapeTypeMap, shapeType)) {
      fail('INVALID_ARGUMENT', `Unknown shape type "${shapeType}". Supported types: ${Object.keys(shapeTypeMap).join(', ')}.`);
    }
    const geometricType = shapeTypeMap[shapeType]!;
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT', `Slide index ${slideIndex} out of range.`);
    }

    const slide = getSlideByIndex(slides, slideIndex);
    if (['text', 'fillColor', 'lineColor', 'lineWidth'].some((key) => params[key] !== undefined)) requireShapeFormatting();
    const shape = slide.shapes.addGeometricShape(geometricType, {
      left: position.left!,
      top: position.top!,
      width: position.width ?? 100,
      height: position.height ?? 100,
    });

    // Set text if provided
    const text = params['text'];
    if (typeof text === 'string' && text.length > 0) {
      shape.textFrame.textRange.text = text;
    }

    // Set fill color
    const fillColor = params['fillColor'];
    if (typeof fillColor === 'string') {
      shape.fill.setSolidColor(fillColor);
    }

    // Set line properties
    const lineColor = params['lineColor'];
    if (typeof lineColor === 'string') {
      shape.lineFormat.color = lineColor;
    }

    const lineWidth = params['lineWidth'];
    if (typeof lineWidth === 'number') {
      shape.lineFormat.weight = lineWidth;
    }

    shape.load('id');
    await context.sync();

    return { success: true, shapeId: shape.id };
  });
}

/**
 * update_text — Update text in an existing shape or placeholder.
 * Params:
 *   slideIndex (number, required) — 1-based
 *   target     (object, required) — { type: "shapeId" | "placeholder", shapeId?, placeholder? }
 *   text       (string, required)
 *   formatting (object, optional)
 */
async function updateText(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return { success: false, error: 'The "slideIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const target = params['target'] as { type: string; shapeId?: string; placeholder?: string } | undefined;
  if (!target || typeof target.type !== 'string') {
    return { success: false, error: 'The "target" parameter with a "type" field is required.', code: 'INVALID_ARGUMENT' };
  }

  const text = params['text'];
  if (typeof text !== 'string') {
    return { success: false, error: 'The "text" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const formatting = params['formatting'] as Record<string, unknown> | undefined;

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT', `Slide index ${slideIndex} out of range.`);
    }

    const slide = getSlideByIndex(slides, slideIndex);
    const shapes = slide.shapes;
    shapes.load(['id', 'name']);
    await context.sync();

    let targetShape: PowerPoint.Shape | null = null;

    if (target.type === 'shapeId') {
      if (typeof target.shapeId !== 'string') {
        fail('INVALID_ARGUMENT', 'The "shapeId" field is required for target type "shapeId".');
      }
      targetShape = shapes.items.find((s) => s.id === target.shapeId) ?? null;
      if (!targetShape) {
        fail('ITEM_NOT_FOUND', `Shape with ID "${target.shapeId}" not found on slide ${slideIndex}.`);
      }
    } else if (target.type === 'placeholder') {
      if (typeof target.placeholder !== 'string') {
        fail('INVALID_ARGUMENT', 'The "placeholder" field is required for target type "placeholder".');
      }
      const placeholderLower = target.placeholder.toLowerCase();
      targetShape = shapes.items.find((s) => s.name.toLowerCase().includes(placeholderLower)) ?? null;
      if (!targetShape) {
        fail('ITEM_NOT_FOUND', `Placeholder "${target.placeholder}" not found on slide ${slideIndex}.`);
      }
    } else {
      fail('INVALID_ARGUMENT', `Unsupported target type: "${target.type}".`);
    }

    targetShape.textFrame.load('textRange/text');
    await context.sync();
    const previousText = targetShape.textFrame.textRange.text;
    targetShape.textFrame.textRange.text = text as string;

    // Apply formatting if specified
    if (formatting) {
      const font = targetShape.textFrame.textRange.font;
      if (typeof formatting['fontFamily'] === 'string') font.name = formatting['fontFamily'];
      if (typeof formatting['fontSize'] === 'number') font.size = formatting['fontSize'];
      if (typeof formatting['fontColor'] === 'string') font.color = formatting['fontColor'];
      if (typeof formatting['bold'] === 'boolean') font.bold = formatting['bold'];
      if (typeof formatting['italic'] === 'boolean') font.italic = formatting['italic'];
      if (typeof formatting['alignment'] === 'string') {
        const alignments = { left: 'Left', center: 'Center', right: 'Right', justified: 'Justify' } as const;
        targetShape.textFrame.textRange.paragraphFormat.horizontalAlignment = alignments[formatting['alignment'] as keyof typeof alignments];
      }
    }

    await context.sync();
    return { success: true, shapeId: targetShape.id, previousText };
  });
}

type NotesSlide = { load: (property: string) => void; shapes: PowerPoint.ShapeCollection };

function getNotesSlide(slide: PowerPoint.Slide): NotesSlide {
  let notesSlide: NotesSlide | undefined;
  try {
    notesSlide = (slide as PowerPoint.Slide & { notesSlide?: NotesSlide }).notesSlide;
  } catch {
    fail('UNSUPPORTED_OPERATION', 'Speaker notes require a newer version of PowerPoint.');
  }
  if (!notesSlide) fail('UNSUPPORTED_OPERATION', 'Speaker notes require a newer version of PowerPoint.');
  return notesSlide;
}

/**
 * get_speaker_notes — Read speaker notes for one or all slides.
 *
 * Uses the Office.js `Slide.notesSlide` API which requires PowerPointApi 1.11+.
 * When unavailable, returns a coded unsupported-operation failure.
 *
 * Params:
 *   slideIndex (number, optional) — 1-based; omit for all slides
 */
async function getSpeakerNotes(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = typeof params['slideIndex'] === 'number' ? params['slideIndex'] : undefined;

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex !== undefined && (!Number.isInteger(slideIndex) || slideIndex < 1 || slideIndex > slides.items.length)) {
      fail('INVALID_ARGUMENT', `Slide index ${slideIndex} out of range. Presentation has ${slides.items.length} slides.`);
    }

    const result: Array<{ slideNumber: number; notes: string }> = [];

    const startIdx = slideIndex ? slideIndex - 1 : 0;
    const endIdx = slideIndex ? slideIndex : slides.items.length;

    for (let i = startIdx; i < endIdx; i++) {
      const notesSlide = getNotesSlide(slides.items[i]!);
      notesSlide.load('shapes');
      await context.sync();
      const shapes = notesSlide.shapes;
      shapes.load(['name', 'type']);
      await context.sync();

      let notesText = '';
      for (const shape of shapes.items) {
        const textFrame = shape.textFrame;
        if (!textFrame) continue;
        try {
          textFrame.load('textRange/text');
          await context.sync();
        } catch {
          // Notes pages also contain shapes without text, such as the slide image.
          continue;
        }
        if (textFrame.textRange.text.trim().length > 0) {
          notesText += (notesText ? '\n' : '') + textFrame.textRange.text;
        }
      }

      result.push({ slideNumber: i + 1, notes: notesText });
    }

    return { notes: result, apiSupported: true };
  });
}

/**
 * set_speaker_notes — Set or update speaker notes for a slide.
 *
 * Uses the Office.js `Slide.notesSlide` API which requires PowerPointApi 1.11+.
 * Returns a clear error with upgrade guidance when the API is unavailable.
 *
 * Params:
 *   slideIndex (number, required) — 1-based
 *   notes      (string, required)
 */
async function setSpeakerNotes(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return { success: false, error: 'The "slideIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const notes = params['notes'];
  if (typeof notes !== 'string') {
    return { success: false, error: 'The "notes" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT', `Slide index ${slideIndex} out of range.`);
    }

    const slide = getSlideByIndex(slides, slideIndex);

    const notesSlide = getNotesSlide(slide);
    notesSlide.load('shapes');
    await context.sync();
    const shapes = notesSlide.shapes;
    shapes.load(['name', 'type']);
    await context.sync();

    const shape = shapes.items.find((item) =>
      item.name.toLowerCase().includes('notes') || item.name.toLowerCase().includes('body'),
    );
    if (!shape) fail('ITEM_NOT_FOUND', 'Could not find a notes placeholder on the slide.');
    shape.textFrame.load('textRange/text');
    await context.sync();
    const previousNotes = shape.textFrame.textRange.text;
    shape.textFrame.textRange.text = notes;
    await context.sync();
    return { success: true, slideNumber: slideIndex, previousNotes };
  });
}

/**
 * get_presentation_properties — Get presentation metadata.
 */
async function getPresentationProperties(_params: Record<string, unknown>): Promise<CommandResult> {
  return executePowerpointCommand(async (context) => {
    const presentation = context.presentation;
    const slides = presentation.slides;
    slides.load('items');
    await context.sync();

    const layoutNames: string[] = [];
    const slideMasters = presentation.slideMasters;
    if (!slideMasters) fail('UNSUPPORTED_OPERATION', 'Presentation layouts require a newer version of PowerPoint.');
    slideMasters.load('items');
    await context.sync();

    for (const master of slideMasters.items) {
      const layouts = master.layouts;
      layouts.load('name');
      await context.sync();

      for (const layout of layouts.items) {
        if (!layoutNames.includes(layout.name)) {
          layoutNames.push(layout.name);
        }
      }
    }

    return {
      slideCount: slides.items.length,
      availableLayouts: layoutNames,
    };
  });
}

/**
 * Resolve a slide layout by name (case-insensitive) across all slide masters.
 * Returns the matching layout (or null) plus the available layout names for
 * error messages. Throws when the layout API is not supported by this
 * PowerPoint version.
 */
async function findLayoutByName(
  context: PowerPoint.RequestContext,
  layoutName: string,
): Promise<{ layout: PowerPoint.SlideLayout | null; available: string[] }> {
  const available: string[] = [];
  let match: PowerPoint.SlideLayout | null = null;

  try {
    const slideMasters = context.presentation.slideMasters;
    slideMasters.load('items');
    await context.sync();

    for (const master of slideMasters.items) {
      const layouts = master.layouts;
      layouts.load(['id', 'name']);
      await context.sync();

      for (const layout of layouts.items) {
        if (!available.includes(layout.name)) {
          available.push(layout.name);
        }
        if (!match && layout.name.toLowerCase() === layoutName.toLowerCase()) {
          match = layout;
        }
      }
    }
  } catch (error) {
    fail('UNSUPPORTED_OPERATION',
      `Slide layouts are not supported by this version of PowerPoint (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  return { layout: match, available };
}

/**
 * Find a shape on a slide by target — `{ type: 'shapeId', shapeId }` or
 * `{ type: 'placeholder', placeholder }` (name contains, case-insensitive;
 * mirrors update_text targeting). Throws when the shape is not found.
 */
async function findShape(
  context: PowerPoint.RequestContext,
  slide: PowerPoint.Slide,
  target: { type: string; shapeId?: string; placeholder?: string },
): Promise<PowerPoint.Shape> {
  const shapes = slide.shapes;
  shapes.load(['id', 'name']);
  await context.sync();

  if (target.type === 'shapeId') {
    if (typeof target.shapeId !== 'string') {
      fail('INVALID_ARGUMENT', 'The "shapeId" field is required for target type "shapeId".');
    }
    const shape = shapes.items.find((s) => s.id === target.shapeId);
    if (!shape) {
      fail('ITEM_NOT_FOUND', `Shape with ID "${target.shapeId}" not found on this slide.`);
    }
    return shape;
  }

  if (target.type === 'placeholder') {
    if (typeof target.placeholder !== 'string') {
      fail('INVALID_ARGUMENT', 'The "placeholder" field is required for target type "placeholder".');
    }
    const placeholderLower = target.placeholder.toLowerCase();
    const shape = shapes.items.find((s) => s.name.toLowerCase().includes(placeholderLower));
    if (!shape) {
      fail('ITEM_NOT_FOUND', `Placeholder "${target.placeholder}" not found on this slide.`);
    }
    return shape;
  }

  fail('INVALID_ARGUMENT', `Unsupported target type: "${target.type}". Use "shapeId" or "placeholder".`);
}

/**
 * apply_layout — Change the layout of an existing slide.
 * Params:
 *   slideIndex (number, required) — 1-based
 *   layout     (string, required) — layout name, e.g. "Title and Content"
 */
async function applyLayout(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return { success: false, error: 'The "slideIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const layoutName = params['layout'];
  if (typeof layoutName !== 'string' || layoutName.trim().length === 0) {
    return {
      success: false,
      error: 'The "layout" parameter is required and must be a layout name (e.g. "Title and Content").',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT',
        `Slide index ${slideIndex} out of range. Presentation has ${slides.items.length} slides.`,
      );
    }

    const { layout, available } = await findLayoutByName(context, layoutName as string);
    if (!layout) {
      fail('ITEM_NOT_FOUND',
        `Layout "${layoutName}" not found. Available layouts: ${available.join(', ') || '(none found)'}.`,
      );
    }

    const slide = getSlideByIndex(slides, slideIndex);
    slide.applyLayout(layout);
    await context.sync();

    return { success: true, slideIndex, layout: layout.name };
  });
}

/**
 * delete_shape — Delete a shape from a slide.
 * Params:
 *   slideIndex (number, required) — 1-based
 *   target     (object, required) — { type: 'shapeId', shapeId } or
 *                                   { type: 'placeholder', placeholder }
 */
async function deleteShape(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return { success: false, error: 'The "slideIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const target = params['target'] as { type: string; shapeId?: string; placeholder?: string } | undefined;
  if (!target || typeof target.type !== 'string') {
    return {
      success: false,
      error: 'The "target" parameter with a "type" field ("shapeId" or "placeholder") is required.',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT',
        `Slide index ${slideIndex} out of range. Presentation has ${slides.items.length} slides.`,
      );
    }

    const slide = getSlideByIndex(slides, slideIndex);
    const shape = await findShape(context, slide, target);
    shape.delete();
    await context.sync();

    return { success: true, slideIndex, deletedShapeId: shape.id };
  });
}

/**
 * format_shape — Format a shape's fill, line, position, size, or name.
 * Params:
 *   slideIndex (number, required) — 1-based
 *   target     (object, required) — { type: 'shapeId', shapeId } or
 *                                   { type: 'placeholder', placeholder }
 *   formatting (object, required) — any of:
 *     fillColor  (string) — HTML color, e.g. "#4472C4"
 *     lineColor  (string) — HTML color
 *     lineWidth  (number) — line weight in points
 *     left / top / width / height (number) — position and size in points
 *     name       (string) — rename the shape
 */
async function formatShape(params: Record<string, unknown>): Promise<CommandResult> {
  const slideIndex = params['slideIndex'];
  if (typeof slideIndex !== 'number' || slideIndex < 1) {
    return { success: false, error: 'The "slideIndex" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const target = params['target'] as { type: string; shapeId?: string; placeholder?: string } | undefined;
  if (!target || typeof target.type !== 'string') {
    return {
      success: false,
      error: 'The "target" parameter with a "type" field ("shapeId" or "placeholder") is required.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const formatting = params['formatting'] as Record<string, unknown> | undefined;
  if (!formatting || typeof formatting !== 'object' || Object.keys(formatting).length === 0) {
    return {
      success: false,
      error: 'The "formatting" parameter is required and must set at least one property.',
      code: 'INVALID_ARGUMENT',
    };
  }

  return executePowerpointCommand(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();

    if (slideIndex > slides.items.length) {
      fail('INVALID_ARGUMENT',
        `Slide index ${slideIndex} out of range. Presentation has ${slides.items.length} slides.`,
      );
    }

    const slide = getSlideByIndex(slides, slideIndex);
    const shape = await findShape(context, slide, target);

    const properties = {
      fillColor: 'fill/foregroundColor', lineColor: 'lineFormat/color', lineWidth: 'lineFormat/weight',
      left: 'left', top: 'top', width: 'width', height: 'height', name: 'name',
    };
    const changed = Object.keys(properties).filter(key => Object.prototype.hasOwnProperty.call(formatting, key));
    shape.load(changed.map(key => properties[key as keyof typeof properties]));
    if (changed.includes('fillColor')) shape.fill.load('type');
    await context.sync();
    const previous: Record<string, unknown> = {};
    for (const key of changed) {
      previous[key] = key === 'fillColor' ? shape.fill.foregroundColor
        : key === 'lineColor' ? shape.lineFormat.color
        : key === 'lineWidth' ? shape.lineFormat.weight
        : shape[key as 'left' | 'top' | 'width' | 'height' | 'name'];
    }
    // A color alone cannot represent gradients, picture fills, or no fill.
    const previousFillType = changed.includes('fillColor') ? String(shape.fill.type) : undefined;

    if (typeof formatting['fillColor'] === 'string') {
      shape.fill.setSolidColor(formatting['fillColor']);
    }
    if (typeof formatting['lineColor'] === 'string') {
      shape.lineFormat.color = formatting['lineColor'];
    }
    if (typeof formatting['lineWidth'] === 'number') {
      shape.lineFormat.weight = formatting['lineWidth'];
    }
    if (typeof formatting['left'] === 'number') shape.left = formatting['left'];
    if (typeof formatting['top'] === 'number') shape.top = formatting['top'];
    if (typeof formatting['width'] === 'number') shape.width = formatting['width'];
    if (typeof formatting['height'] === 'number') shape.height = formatting['height'];
    if (typeof formatting['name'] === 'string') shape.name = formatting['name'];

    await context.sync();
    return { success: true, slideIndex, shapeId: shape.id, previous, ...(previousFillType === undefined ? {} : { previousFillType }) };
  });
}
