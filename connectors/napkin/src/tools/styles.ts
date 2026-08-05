import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withErrorHandling } from '../utils.js';

export const NAPKIN_STYLES_DOC_URL = 'https://api.napkin.ai/docs/styles/index.html';

export interface NapkinStyle {
  id: string;
  name: string;
  description: string;
  category: string;
}

/**
 * Static catalog of Napkin's 15 built-in styles, mirrored from the official
 * docs (NAPKIN_STYLES_DOC_URL). The Napkin API exposes no styles endpoint, so
 * the catalog ships with the connector — refresh it when the vendor docs
 * change. The data is connector-authored static content, not external text.
 */
export const BUILT_IN_STYLES: readonly NapkinStyle[] = [
  // Colorful
  { id: 'CDQPRVVJCSTPRBBCD5Q6AWR', name: 'Vibrant Strokes', description: 'A flow of vivid lines for bold notes.', category: 'colorful' },
  { id: 'CDQPRVVJCSTPRBBKDXK78', name: 'Glowful Breeze', description: 'A swirl of cheerful color for laid-back planning.', category: 'colorful' },
  { id: 'CDQPRVVJCSTPRBB6DHGQ8', name: 'Bold Canvas', description: 'A vivid field of shapes for lively notes.', category: 'colorful' },
  { id: 'CDQPRVVJCSTPRBB6D5P6RSB4', name: 'Radiant Blocks', description: 'A bright spread of solid color for tasks.', category: 'colorful' },
  { id: 'CDQPRVVJCSTPRBB7E9GP8TB5DST0', name: 'Pragmatic Shades', description: 'A palette of blended hues for bold ideas.', category: 'colorful' },
  // Casual
  { id: 'CDGQ6XB1DGPQ6VV6EG', name: 'Carefree Mist', description: 'A wisp of calm tones for playful tasks.', category: 'casual' },
  { id: 'CDGQ6XB1DGPPCTBCDHJP8', name: 'Lively Layers', description: 'A breeze of soft color for bright ideas.', category: 'casual' },
  // Hand-drawn
  { id: 'D1GPWS1DCDQPRVVJCSTPR', name: 'Artistic Flair', description: 'A splash of hand-drawn color for creative thinking.', category: 'hand-drawn' },
  { id: 'D1GPWS1DDHMPWSBK', name: 'Sketch Notes', description: 'A hand-drawn style for free-flowing ideas.', category: 'hand-drawn' },
  // Formal
  { id: 'CSQQ4VB1DGPP4V31CDNJTVKFBXK6JV3C', name: 'Elegant Outline', description: 'A refined black outline for professional clarity.', category: 'formal' },
  { id: 'CSQQ4VB1DGPPRTB7D1T0', name: 'Subtle Accent', description: 'A light touch of color for professional documents.', category: 'formal' },
  { id: 'CSQQ4VB1DGPQ6TBECXP6ABB3DXP6YWG', name: 'Monochrome Pro', description: 'A single-color approach for focused presentations.', category: 'formal' },
  { id: 'CSQQ4VB1DGPPTVVEDXHPGWKFDNJJTSKCC5T0', name: 'Corporate Clean', description: 'A professional flat style for business diagrams.', category: 'formal' },
  // Monochrome
  { id: 'DNQPWVV3D1S6YVB55NK6RRBM', name: 'Minimal Contrast', description: 'A clean monochrome style for focused work.', category: 'monochrome' },
  { id: 'CXS62Y9DCSQP6XBK', name: 'Silver Beam', description: 'A spotlight of gray scale ease with striking focus.', category: 'monochrome' },
] as const;

export function registerStylesTools(server: McpServer): void {
  server.registerTool(
    'napkin_list_styles',
    {
      description:
        'List the 15 built-in Napkin visual styles with their style IDs, descriptions, and categories. ' +
        'Use this to pick a style_id for napkin_generate_visual instead of guessing. ' +
        'Custom styles created in the Napkin app also work — copy the brand ID from the app and pass it as style_id. ' +
        'Returns static catalog data; no API key required and no network call is made.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    withErrorHandling(async () => {
      return JSON.stringify(
        {
          styles: BUILT_IN_STYLES,
          custom_styles:
            'Custom styles created in the Napkin app (https://app.napkin.ai) can also be used — copy the brand ID from the app and pass it as style_id.',
          docs_url: NAPKIN_STYLES_DOC_URL,
          message:
            'Pass a style id as style_id to napkin_generate_visual. Omit style_id to use the default style.',
        },
        null,
        2,
      );
    }),
  );
}
