import { describe, expect, it } from 'vitest';

import { allTools } from '../src/tools/definitions/index.js';

describe('Google Workspace tool registration count', () => {
  it('registers 124 tools, including Tasks and Forms', () => {
    const names = allTools.map(tool => tool.name);
    expect(names).toHaveLength(124);
    expect(names).toContain('list_task_lists');
    expect(names).toContain('list_forms');
  });
});
