import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docsTools } from '../src/tools/definitions/docs.js';
import { driveTools } from '../src/tools/definitions/drive.js';
import { wrapUntrustedJsonControls } from '../src/utils/untrusted-controls.js';

const contract = JSON.parse(readFileSync(
  new URL('./fixtures/outline-contract.json', import.meta.url), 'utf8',
)) as {
  tools: typeof docsTools;
  tabTrees: { plain: { documentId: string }; wrapped: unknown }[];
};

const outlineToolNames = [
  'read_workspace_document',
  'find_and_replace_workspace_document',
  'list_workspace_document_tabs',
  'batch_update_workspace_document',
  'update_workspace_document_tab',
  'list_drive_files',
  'move_drive_file',
];

describe('outline contract', () => {
  it('pins the complete ordered metadata of exactly seven canonical tools', () => {
    const canonical = [...docsTools, ...driveTools].filter(tool => outlineToolNames.includes(tool.name));
    expect(canonical.map(tool => tool.name)).toEqual(outlineToolNames);
    expect(contract.tools).toHaveLength(7);
    expect(canonical).toEqual(contract.tools);
  });

  it('keeps note matching optional, boolean and case-insensitive by default, scoped to one tab', () => {
    const tool = docsTools.find(tool => tool.name === 'find_and_replace_workspace_document')!;
    const schema = tool.inputSchema as { properties: Record<string, { type: string; description: string }>; required: string[] };
    expect(schema.properties.match_case).toMatchObject({ type: 'boolean', description: 'Case-sensitive matching (default: false)' });
    expect(schema.required).not.toContain('match_case');
    expect(tool.description).toContain('sub-tabs are\n    separate tabs and are not included');
    const service = readFileSync(new URL('../src/modules/docs/service.ts', import.meta.url), 'utf8');
    expect(service).toContain('matchCase: options.matchCase ?? false');
    expect(service).toContain('tabsCriteria: { tabIds: [target.tabId] }');
  });

  it('pins all four distinct full tab trees to the canonical control-path wrapper', () => {
    expect(contract.tabTrees).toHaveLength(4);
    expect(new Set(contract.tabTrees.map(pair => JSON.stringify(pair.plain))).size).toBe(4);
    for (const { plain, wrapped } of contract.tabTrees) {
      expect(wrapUntrustedJsonControls(
        plain, `google-workspace:docs:tabs/${plain.documentId}`,
        ['documentId'],
      )).toEqual(wrapped);
    }
  });
});
