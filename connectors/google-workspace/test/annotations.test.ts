import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allTools,
  DESTRUCTIVE_OVERRIDES,
  OPEN_WORLD_OVERRIDES,
} from '../src/tools/definitions/index.js';

describe('tool annotations', () => {
  it('matches destructiveHint and openWorldHint override inventories', () => {
    for (const tool of allTools) {
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(
        DESTRUCTIVE_OVERRIDES[tool.name],
      );
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(
        OPEN_WORLD_OVERRIDES[tool.name],
      );
    }
  });

  it('records explicit cohort decisions', () => {
    const byName = new Map(allTools.map(tool => [tool.name, tool]));
    expect(byName.get('respond_to_workspace_calendar_event')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('mark_workspace_email_read')?.annotations?.destructiveHint).toBe(false);
    expect(byName.get('mark_workspace_email_unread')?.annotations?.destructiveHint).toBe(false);
    expect(byName.get('list_workspace_accounts')?.annotations?.openWorldHint).toBe(false);
    expect(byName.get('authenticate_workspace_account')?.annotations?.openWorldHint).toBe(false);
  });

  it('marks every new Docs tab write tool destructive and open-world, in source and in the built inventory', () => {
    const newWriteTools = [
      'add_workspace_document_tab',
      'update_workspace_document_tab',
      'delete_workspace_document_tab',
      'insert_workspace_document_text',
    ];
    const byName = new Map(allTools.map(tool => [tool.name, tool]));
    const inventoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools-inventory.json');
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as {
      tools: Array<{ name: string; annotations: { destructiveHint?: boolean; openWorldHint?: boolean } }>;
    };
    const inventoryByName = new Map(inventory.tools.map(tool => [tool.name, tool]));
    for (const name of newWriteTools) {
      expect(byName.get(name)?.annotations?.destructiveHint, `${name} destructiveHint`).toBe(true);
      expect(byName.get(name)?.annotations?.openWorldHint, `${name} openWorldHint`).toBe(true);
      expect(inventoryByName.get(name)?.annotations.destructiveHint, `${name} inventory destructiveHint`).toBe(true);
      expect(inventoryByName.get(name)?.annotations.openWorldHint, `${name} inventory openWorldHint`).toBe(true);
    }
  });
});
