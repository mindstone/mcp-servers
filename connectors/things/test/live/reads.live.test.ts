/**
 * Live reads against the real Things on this Mac: `npm run test:live`. Reads only; safe any time.
 * Every read tool, over the protocol, on real data: no errors, enveloped data, and results small
 * enough for any host (Claude Code warns above about 10k tokens).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../../src/server.js';
import { parse } from '../helpers.js';

const live = process.env.THINGS_LIVE === '1';

describe.runIf(live)('live reads', () => {
  let client: McpTestClient;
  beforeAll(async () => {
    client = await createInMemoryTestClient({ createServer });
  });
  afterAll(async () => client?.close());

  const calls: [string, Record<string, unknown>][] = [
    ['things_get_overview', {}],
    ...['today', 'inbox', 'upcoming', 'anytime', 'someday', 'deadlines', 'logbook'].map((list): [string, Record<string, unknown>] => ['things_get_list', { list }]),
    ['things_search', { query: 'email' }],
  ];

  it.each(calls)('%s %j', async (name, args) => {
    const started = Date.now();
    const r = await client.callTool(name, args);
    expect(r.isError, r.text).toBeFalsy();
    const { meta } = parse(r.text);
    expect(meta.warning).toBeUndefined();
    expect(r.text.length).toBeLessThan(40_000);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it('opens the first project and its first item', async () => {
    const overview = parse((await client.callTool('things_get_overview', {})).text).data;
    const project = [...overview.areas.flatMap((a: { projects: unknown[] }) => a.projects), ...overview.projects_without_area][0] as { id: string } | undefined;
    if (!project) return;
    const p = await client.callTool('things_get_project', { project: project.id });
    expect(p.isError, p.text).toBeFalsy();
    const item = await client.callTool('things_get_item', { id: project.id });
    expect(parse(item.text).data.link).toBe(`things:///show?id=${project.id}`);
  });
});
