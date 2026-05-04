import { describe, expect, it } from 'vitest';
import {
  allTools,
  DESTRUCTIVE_TOOL_NAME_PATTERN,
  FORCE_DESTRUCTIVE_TOOL_NAMES,
  LOCAL_ONLY_TOOL_NAMES,
} from '../src/tools/definitions.js';

const localOnlyToolSet = new Set<string>(LOCAL_ONLY_TOOL_NAMES);
const forceDestructiveToolSet = new Set<string>(FORCE_DESTRUCTIVE_TOOL_NAMES);

describe('HubSpot tool annotation sweep', () => {
  it('sets destructiveHint=true on mutator and auth-state tools', () => {
    const toolsRequiringDestructiveHint = allTools.filter(
      tool =>
        DESTRUCTIVE_TOOL_NAME_PATTERN.test(tool.name) ||
        forceDestructiveToolSet.has(tool.name)
    );

    expect(toolsRequiringDestructiveHint.length).toBeGreaterThan(0);

    for (const tool of toolsRequiringDestructiveHint) {
      expect(tool.annotations?.destructiveHint).toBe(
        true,
        `Expected destructiveHint=true for ${tool.name}`
      );
    }
  });

  it('sets openWorldHint=true for non-local tools and false for local diagnostics', () => {
    for (const tool of allTools) {
      const expectedOpenWorld = !localOnlyToolSet.has(tool.name);
      expect(tool.annotations?.openWorldHint).toBe(
        expectedOpenWorld,
        `Expected openWorldHint=${expectedOpenWorld} for ${tool.name}`
      );
    }
  });
});
