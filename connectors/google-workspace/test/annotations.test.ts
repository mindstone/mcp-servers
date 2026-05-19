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
});
