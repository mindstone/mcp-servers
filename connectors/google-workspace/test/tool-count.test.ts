import { describe, expect, it } from 'vitest';

import { allTools } from '../src/tools/definitions/index.js';

describe('Google Workspace tool registration count', () => {
  it('registers 121 tools, including Tasks and Forms', () => {
    const names = allTools.map(tool => tool.name);
    expect(names).toHaveLength(121);
    expect(names).toContain('list_task_lists');
    expect(names).toContain('list_forms');
  });
});
