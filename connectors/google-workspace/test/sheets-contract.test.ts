import { describe, expect, it } from 'vitest';

import {
  formatOperationResult,
  formatShapedReadResponse,
} from '../src/modules/sheets/formatters.js';
import type { ShapedReadResponse } from '../src/modules/sheets/types.js';
import { sheetsTools } from '../src/tools/definitions/sheets.js';

describe('Sheets contract for downstream readers', () => {
  // Regenerate with: npx vitest run test/sheets-contract.test.ts -u
  it('matches the committed tool definitions and formatted result samples', async () => {
    const tools = [
      'read_workspace_spreadsheet_values',
      'update_workspace_spreadsheet_values',
    ].map((name) => {
      const matches = sheetsTools.filter((tool) => tool.name === name);
      expect(matches, `Expected exactly one Sheets tool named ${name}`).toHaveLength(1);
      const tool = matches[0];
      return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
    });

    const shapedReads = [18, 19.25].map((value) => {
      const input: ShapedReadResponse = {
        range: 'Targets!B2',
        rowCount: 1,
        columnCount: 1,
        formulaCellCount: 0,
        columnTypes: ['number'],
        cells: [[{ value, unformattedValue: value }]],
      };
      return { input, text: formatShapedReadResponse(input) };
    });

    const updateInput = {
      operation: 'Update',
      spreadsheetId: 'progress-sheet',
      details: { updatedCells: 1, updatedRows: 1 },
    };
    const contract = {
      tools,
      results: {
        shapedReads,
        update: {
          input: updateInput,
          text: formatOperationResult(
            updateInput.operation,
            updateInput.spreadsheetId,
            updateInput.details,
          ),
        },
      },
    };

    await expect(`${JSON.stringify(contract, null, 2)}\n`).toMatchFileSnapshot('./sheets-contract.json');
  });
});
