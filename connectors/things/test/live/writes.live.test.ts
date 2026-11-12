/**
 * Live writes against the real Things on this Mac: `npm run test:live-writes`.
 *
 * It touches one to-do only, which it creates itself with a unique title, and leaves it in the
 * Trash. Every change names that to-do's id. Before and after, it records every other item's
 * modification time and checks that none changed, so a run is evidence that nothing else was
 * touched (an edit synced in from another device during the run would fail that check: re-run).
 *
 * Needs "Enable Things URLs" on, and the first trash asks for Automation permission.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { ThingsReader } from '../../src/reader.js';
import { createServer } from '../../src/server.js';
import { parse } from '../helpers.js';

const live = process.env.THINGS_LIVE_WRITES === '1';

async function modifiedTimes(): Promise<Map<string, string>> {
  const r = await ThingsReader.open();
  try {
    const all = r.tasks({ status: null, trashed: null, contextTrashed: null });
    return new Map(all.map((t) => [t.uuid, `${t.modified}|${t.status}|${t.trashed ?? false}`]));
  } finally {
    r.close();
  }
}

describe.runIf(live)('live writes: one to-do of its own, nothing else', () => {
  let client: McpTestClient;
  const marker = Math.random().toString(36).slice(2, 10);
  const title = `MCP test hello world ${marker}`;
  let id = '';
  let current = title;
  let before: Map<string, string>;

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool(name, args);
    if (r.isError) return { error: r.text };
    return parse(r.text);
  };
  const mine = (args: Record<string, unknown>) => {
    // Every change names our to-do, and only ours.
    expect(id).toMatch(/^[A-Za-z0-9-]{10,40}$/);
    return { id, current_title: current, ...args };
  };

  beforeAll(async () => {
    before = await modifiedTimes();
    client = await createInMemoryTestClient({ createServer, env: { THINGS_ALLOW_WRITES: '1', THINGS_ALLOW_TRASH: '1' } });
  });

  afterAll(async () => {
    // If a step failed part-way, still put our to-do in the Trash.
    if (id) await client.callTool('things_trash', { id, current_title: current });
    await client?.close();
  });

  it('adds it to the Inbox, and returns it confirmed', async () => {
    const r = await call('things_add_todo', { title, notes: 'Made by the Things MCP server live test. Safe to delete.' });
    expect(r).toMatchObject({ meta: { outcome: 'confirmed' } });
    id = (r as { data: { item: { id: string } } }).data.item.id;
    expect((r as any).data.item).toMatchObject({ title, when: 'inbox' });
    expect(before.has(id)).toBe(false);
  }, 60_000);

  it('does not add it twice', async () => {
    const r = await call('things_add_todo', { title });
    expect(r).toMatchObject({ meta: { outcome: 'existing' }, data: { item: { id } } });
  }, 60_000);

  it('refuses a change under the wrong title, sending nothing', async () => {
    const r = await call('things_update_todo', { id, current_title: 'Not its title', when: 'today' });
    expect((r as { error: string }).error).toMatch(/Nothing was changed/);
  }, 60_000);

  it('refuses an unknown tag before sending', async () => {
    const r = await call('things_update_todo', mine({ add_tags: [`no-such-tag-${marker}`] }));
    expect((r as { error: string }).error).toMatch(/No such tag/);
  }, 60_000);

  it('reschedules it, sets and clears a deadline, appends notes and a checklist, renames it', async () => {
    let r = await call('things_update_todo', mine({ when: 'tomorrow', deadline: '2047-01-31' }));
    expect(r).toMatchObject({ meta: { outcome: 'confirmed' }, data: { item: { deadline: '2047-01-31' }, before: { when: 'inbox' } } });
    r = await call('things_update_todo', mine({ deadline: null, append_notes: 'Appended line.', append_checklist: ['First step', 'Second step'] }));
    expect(r).toMatchObject({ meta: { outcome: 'confirmed' } });
    expect((r as any).data.item.deadline).toBeUndefined();
    const renamed = `${title} (renamed)`;
    r = await call('things_update_todo', mine({ title: renamed }));
    expect(r).toMatchObject({ meta: { outcome: 'confirmed' }, data: { item: { title: renamed } } });
    current = renamed;
    const item = await call('things_get_item', { id });
    expect((item as any).data).toMatchObject({ title: renamed, checklist: ['[ ] First step', '[ ] Second step'] });
    expect((item as any).data.notes).toMatch(/Safe to delete\.\nAppended line\.$/);
  }, 120_000);

  it('completes it, says so again without changing anything, and reopens it', async () => {
    let r = await call('things_set_status', mine({ status: 'completed' }));
    expect(r).toMatchObject({ meta: { outcome: 'confirmed' }, data: { item: { status: 'completed' } } });
    r = await call('things_set_status', mine({ status: 'completed' }));
    expect((r as any).meta.note).toMatch(/already/);
    r = await call('things_set_status', mine({ status: 'incomplete' }));
    expect(r).toMatchObject({ meta: { outcome: 'confirmed' } });
    expect((r as any).data.item.status).toBeUndefined();
  }, 120_000);

  it('moves it to the Trash', async () => {
    const r = await call('things_trash', mine({}));
    expect(r).toMatchObject({ meta: { outcome: 'confirmed' }, data: { item: { in_trash: true } } });
    const again = await call('things_trash', mine({}));
    expect((again as any).meta.note).toMatch(/already/);
  }, 120_000);

  it('changed nothing else', async () => {
    const after = await modifiedTimes();
    const changed = [...before].filter(([uuid, state]) => after.get(uuid) !== state).map(([uuid]) => uuid);
    expect(changed).toEqual([]);
  }, 60_000);
});
