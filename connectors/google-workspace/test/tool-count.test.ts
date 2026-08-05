import { describe, expect, it, vi } from 'vitest';

async function loadToolNames(envValue?: string): Promise<string[]> {
  vi.resetModules();
  if (envValue === undefined) {
    vi.stubEnv('ENABLE_GOOGLE_TASKS_FORMS', '');
  } else {
    vi.stubEnv('ENABLE_GOOGLE_TASKS_FORMS', envValue);
  }
  const { allTools } = await import('../src/tools/definitions/index.js');
  return allTools.map(tool => tool.name);
}

describe('Google Workspace tool registration count', () => {
  it('registers 99 tools by default', async () => {
    const names = await loadToolNames();
    expect(names).toHaveLength(99);
    expect(names).not.toContain('list_task_lists');
    expect(names).not.toContain('list_forms');
  });

  it('registers 109 tools with Tasks and Forms enabled', async () => {
    const names = await loadToolNames('true');
    expect(names).toHaveLength(109);
    expect(names).toContain('list_task_lists');
    expect(names).toContain('list_forms');
  });
});
