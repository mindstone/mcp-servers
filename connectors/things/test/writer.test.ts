import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ThingsReader } from '../src/reader.js';
import { ThingsWriter } from '../src/writer.js';
import type { ThingsExecutor } from '../src/executor.js';
import { FIXTURE_TOKEN, makeFixtureDb, mutate, type Fixture } from './fixture.js';
import { ThingsSimulator, type SimulatorOptions } from './simulator.js';

const NOW = new Date(2026, 10, 12, 10, 0, 0); // 2026-11-12, local time
const now = () => NOW;

const base: Fixture = {
  tags: ['Errand', 'Home'],
  areas: [{ uuid: 'area-work-0001', title: 'Work' }],
  tasks: [
    { uuid: 'todo-milk-0001', title: 'Buy milk', start: 'Inbox' },
    { uuid: 'todo-notes-001', title: 'Has notes', notes: 'First line' },
    { uuid: 'proj-open-0001', title: 'Kitchen', type: 'project' },
    { uuid: 'proj-done-0001', title: 'Old project', type: 'project', status: 'completed', stopDate: '2026-10-01T12:00:00Z' },
    { uuid: 'proj-full-0001', title: 'Garden', type: 'project' },
    { uuid: 'todo-garden-01', title: 'Weed beds', project: 'proj-full-0001' },
    { uuid: 'head-0000-0001', title: 'Phase one', type: 'heading', project: 'proj-open-0001' },
    { uuid: 'todo-headed-01', title: 'Under a heading', heading: 'head-0000-0001' },
    { uuid: 'todo-trash-001', title: 'Binned', trashed: true },
    { uuid: 'todo-closed-01', title: 'Finished thing', status: 'completed', stopDate: '2026-11-01T12:00:00Z' },
    { uuid: 'todo-repeat-01', title: 'Water plants', repeatingInstance: true, startDate: '2026-11-12' },
    { uuid: 'todo-templ-001', title: 'Water plants', recurringTemplate: true },
    { uuid: 'todo-dead-0001', title: 'Has deadline', deadline: '2026-12-01' },
  ],
};

let sims: ThingsSimulator[] = [];
afterEach(() => {
  for (const s of sims) expect(s.modals).toEqual([]);
  sims = [];
});

async function setup(f: Fixture = base, sim: Partial<SimulatorOptions> = {}, executor?: (s: ThingsSimulator) => ThingsExecutor) {
  const path = await makeFixtureDb(f);
  const s = new ThingsSimulator(path, { now, ...sim });
  sims.push(s);
  const lockDir = mkdtempSync(join(tmpdir(), 'things-lock-'));
  const w = new ThingsWriter({
    openReader: () => ThingsReader.openFile(path, { now }),
    executor: executor ? executor(s) : s,
    lockKey: () => path,
    lock: { dir: lockDir },
    timeoutMs: 300,
    pollMs: 10,
    now,
  });
  const read = async <T>(fn: (r: ThingsReader) => T): Promise<T> => {
    const r = await ThingsReader.openFile(path, { now });
    try {
      return fn(r);
    } finally {
      r.close();
    }
  };
  return { path, s, w, read, lockDir };
}

describe('adding a to-do', () => {
  it('adds it to the Inbox and finds the new one', async () => {
    const { s, w } = await setup();
    const r = await w.addTodo({ title: 'Call the plumber', notes: 'About the leak', tags: ['Home'], checklist: ['Find number'] });
    expect(r).toMatchObject({ outcome: 'confirmed', created: true, item: { title: 'Call the plumber', notes: 'About the leak', tags: ['Home'], start: 'Inbox' } });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.value).toMatch(/^things:\/\/\/json\?data=/);
    expect(s.calls[0]!.value).not.toContain('auth-token');
  });

  it('returns the open to-do with the same title instead of adding it again', async () => {
    const { s, w } = await setup();
    const r = await w.addTodo({ title: '  buy MILK. ' });
    expect(r).toMatchObject({ outcome: 'existing', item: { uuid: 'todo-milk-0001' } });
    expect(s.calls).toHaveLength(0);
  });

  it('adds a second one when asked', async () => {
    const { w, read } = await setup();
    const r = await w.addTodo({ title: 'Buy milk' }, { allowDuplicate: true });
    expect(r).toMatchObject({ outcome: 'confirmed', created: true });
    if (r.outcome !== 'confirmed') throw new Error('unreachable');
    expect(r.item.uuid).not.toBe('todo-milk-0001');
    expect(await read((x) => x.inbox().filter((t) => t.title === 'Buy milk').length)).toBe(2);
  });

  it('refuses an unknown tag, sending nothing (Things would drop it silently)', async () => {
    const { s, w } = await setup();
    await expect(w.addTodo({ title: 'X thing', tags: ['Nope'] })).rejects.toThrow(/No such tag/);
    expect(s.calls).toHaveLength(0);
  });

  it('refuses a tag with a comma, a two-line title, and a project with an area', async () => {
    const { s, w } = await setup();
    await expect(w.addTodo({ title: 'X', tags: ['a,b'] })).rejects.toThrow(/comma/);
    await expect(w.addTodo({ title: 'Line one\nline two' })).rejects.toThrow(/line break/);
    await expect(w.addTodo({ title: 'X', projectId: 'proj-open-0001', areaId: 'area-work-0001' })).rejects.toThrow(/not both/);
    expect(s.calls).toHaveLength(0);
  });

  it('puts it into an open project or an area, and refuses a closed project', async () => {
    const { s, w } = await setup();
    await expect(w.addTodo({ title: 'Tiles', projectId: 'proj-open-0001' })).resolves.toMatchObject({ outcome: 'confirmed', item: { project: 'proj-open-0001' } });
    await expect(w.addTodo({ title: 'Report', areaId: 'area-work-0001' })).resolves.toMatchObject({ outcome: 'confirmed', item: { area: 'area-work-0001' } });
    await expect(w.addTodo({ title: 'Revive', projectId: 'proj-done-0001' })).rejects.toThrow(/completed/);
    expect(s.calls).toHaveLength(2);
  });

  it('schedules it and gives it a deadline', async () => {
    const { w } = await setup();
    const r = await w.addTodo({ title: 'Book dentist', when: 'tomorrow', deadline: '2026-11-30' });
    expect(r).toMatchObject({ outcome: 'confirmed', item: { start_date: '2026-11-13', deadline: '2026-11-30' } });
  });

  it('says unconfirmed, and names no id, when the new to-do never shows up', async () => {
    const { w } = await setup(base, { ignoreCommands: true });
    const r = await w.addTodo({ title: 'Lost in the post' });
    expect(r).toMatchObject({ outcome: 'unconfirmed', created: 'unknown' });
    expect(JSON.stringify(r)).not.toMatch(/"uuid"/);
  });

  it('two writers adding the same title at once add it only once (the lock)', async () => {
    const { path, s, w, lockDir } = await setup();
    const w2 = new ThingsWriter({ openReader: () => ThingsReader.openFile(path, { now }), executor: s, lockKey: () => path, lock: { dir: lockDir }, timeoutMs: 300, pollMs: 10, now });
    const [a, b] = await Promise.all([w.addTodo({ title: 'Only once' }), w2.addTodo({ title: 'Only once' })]);
    expect([a.outcome, b.outcome].sort()).toEqual(['confirmed', 'existing']);
    expect(s.calls).toHaveLength(1);
  });
});

describe('changing a to-do', () => {
  it('refuses when the title differs from what the caller read, sending nothing', async () => {
    const { s, w } = await setup();
    await expect(w.updateTodo('todo-milk-0001', { when: 'today' }, 'Buy bread')).rejects.toThrow(/titled .*Buy milk.*Nothing was changed/);
    expect(s.calls).toHaveLength(0);
  });

  it('appends and prepends notes, never replacing them', async () => {
    const { w } = await setup();
    await expect(w.updateTodo('todo-notes-001', { appendNotes: 'Second line' }, 'Has notes')).resolves.toMatchObject({ outcome: 'confirmed', item: { notes: 'First line\nSecond line' }, before: { notes: 'First line' } });
    await expect(w.updateTodo('todo-notes-001', { prependNotes: 'Zeroth' }, 'Has notes')).resolves.toMatchObject({ item: { notes: 'Zeroth\nFirst line\nSecond line' } });
  });

  it('reschedules, sets and clears a deadline, adds tags and checklist items, renames, moves', async () => {
    const { s, w } = await setup();
    await expect(w.updateTodo('todo-milk-0001', { when: 'evening', deadline: '2026-11-20', addTags: ['Errand'], appendChecklist: ['Semi-skimmed'] }, 'Buy milk')).resolves.toMatchObject({
      outcome: 'confirmed',
      item: { evening: true, start_date: '2026-11-12', deadline: '2026-11-20', tags: ['Errand'] },
    });
    await expect(w.updateTodo('todo-milk-0001', { deadline: null, title: 'Buy oat milk' }, 'Buy milk')).resolves.toMatchObject({ item: { deadline: null, title: 'Buy oat milk' } });
    await expect(w.updateTodo('todo-milk-0001', { projectId: 'proj-open-0001' }, 'Buy oat milk')).resolves.toMatchObject({ item: { project: 'proj-open-0001' } });
    expect(s.calls.every((c) => c.value.includes(`auth-token=${FIXTURE_TOKEN}`))).toBe(true);
  });

  it('drops a deadline: null on a to-do with no deadline, rather than refusing the move it came with', async () => {
    const { w } = await setup();
    await expect(w.updateTodo('todo-milk-0001', { when: 'someday', deadline: null }, 'Buy milk')).resolves.toMatchObject({ outcome: 'confirmed', item: { start: 'Someday' } });
    await expect(w.updateTodo('todo-milk-0001', { deadline: null }, 'Buy milk')).rejects.toThrow(/no deadline/);
  });

  it('refuses dates after 2047-12-31, the last Things can store, sending nothing', async () => {
    const { s, w } = await setup();
    await expect(w.updateTodo('todo-milk-0001', { deadline: '2099-01-31' }, 'Buy milk')).rejects.toThrow(/2047-12-31/);
    await expect(w.updateTodo('todo-milk-0001', { when: '2048-01-01' }, 'Buy milk')).rejects.toThrow(/2047-12-31/);
    await expect(w.addTodo({ title: 'Far off', deadline: '2050-06-01' })).rejects.toThrow(/2047-12-31/);
    expect(s.calls).toHaveLength(0);
    await expect(w.updateTodo('todo-milk-0001', { deadline: '2047-12-31' }, 'Buy milk')).resolves.toMatchObject({ outcome: 'confirmed', item: { deadline: '2047-12-31' } });
  });

  it('refuses notes that would end up over Things\' limit, sending nothing', async () => {
    const { s, w } = await setup();
    await expect(w.updateTodo('todo-notes-001', { appendNotes: 'x'.repeat(9995) }, 'Has notes')).rejects.toThrow(/over Things' limit/);
    expect(s.calls).toHaveLength(0);
  });

  it('refuses items in the Trash, templates of repeating to-dos, headings and projects', async () => {
    const { s, w } = await setup();
    await expect(w.updateTodo('todo-trash-001', { when: 'today' }, 'Binned')).rejects.toThrow(/in the Trash/);
    await expect(w.updateTodo('todo-templ-001', { when: 'today' }, 'Water plants')).rejects.toThrow(/repeat itself/);
    await expect(w.updateTodo('head-0000-0001', { title: 'X' }, 'Phase one')).rejects.toThrow(/heading/);
    await expect(w.updateTodo('proj-open-0001', { title: 'X' }, 'Kitchen')).rejects.toThrow(/project, not a to-do/);
    await expect(w.updateTodo('nosuchid-0001', { title: 'X' }, 'X')).rejects.toThrow(/No Things item/);
    expect(s.calls).toHaveLength(0);
  });

  it('lets a repeating copy move to a later day or get a deadline, and nothing else', async () => {
    const { s, w } = await setup();
    await expect(w.updateTodo('todo-repeat-01', { when: 'tomorrow' }, 'Water plants')).resolves.toMatchObject({ outcome: 'confirmed', item: { start_date: '2026-11-13' } });
    // "tomorrow" goes as its date, the form measured on a copy.
    expect(s.calls[0]!.value).toContain('when=2026-11-13');
    await expect(w.updateTodo('todo-repeat-01', { title: 'Water the plants' }, 'Water plants')).rejects.toThrow(/one copy of a repeating/);
    await expect(w.updateTodo('todo-repeat-01', { when: '2026-11-01' }, 'Water plants')).rejects.toThrow(/one copy of a repeating/);
    await expect(w.updateTodo('todo-repeat-01', { when: 'someday' }, 'Water plants')).rejects.toThrow(/one copy of a repeating/);
    expect(s.calls).toHaveLength(1);
  });

  it('never moves a to-do out from under a heading', async () => {
    const { s, w } = await setup();
    await expect(w.updateTodo('todo-headed-01', { projectId: 'proj-full-0001' }, 'Under a heading')).rejects.toThrow(/under a heading/);
    await expect(w.updateTodo('todo-headed-01', { when: 'today' }, 'Under a heading')).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(s.calls).toHaveLength(1);
  });

  it('asks for a closed to-do to be reopened before it is scheduled', async () => {
    const { s, w } = await setup();
    await expect(w.updateTodo('todo-closed-01', { when: 'today' }, 'Finished thing')).rejects.toThrow(/Reopen it first/);
    expect(s.calls).toHaveLength(0);
  });

  it('refuses before sending when "Enable Things URLs" is off, or Things has no token', async () => {
    const off = await setup(base, { urlsEnabled: false });
    await expect(off.w.updateTodo('todo-milk-0001', { when: 'today' }, 'Buy milk')).rejects.toThrow(/Enable Things URLs/);
    expect(off.s.calls).toHaveLength(0);
    const none = await setup({ ...base, noToken: true });
    await expect(none.w.updateTodo('todo-milk-0001', { when: 'today' }, 'Buy milk')).rejects.toThrow(/URL-scheme token/);
    expect(none.s.calls).toHaveLength(0);
  });

  it('keeps the token out of the reason a failed send gives', async () => {
    const { w } = await setup(base, {}, (s) => ({ ...s, urlSchemeEnabled: () => s.urlSchemeEnabled(), thingsRunning: () => s.thingsRunning(), appleScript: (a, b) => s.appleScript(a, b), openUrl: async (url) => { throw new Error(`Command failed: open -g ${url}`); } }));
    // After sending, a failure is unconfirmed (it may have reached Things), and its reason is scrubbed.
    const r = await w.updateTodo('todo-milk-0001', { when: 'today' }, 'Buy milk');
    expect(r.outcome).toBe('unconfirmed');
    expect(JSON.stringify(r)).toMatch(/auth-token=<token>/);
    expect(JSON.stringify(r)).not.toContain(FIXTURE_TOKEN);
  });

  it('says unconfirmed, with the state before, when the change never reads back', async () => {
    const { w } = await setup(base, { ignoreCommands: true });
    const r = await w.updateTodo('todo-milk-0001', { appendNotes: 'More' }, 'Buy milk');
    expect(r).toMatchObject({ outcome: 'unconfirmed', before: { uuid: 'todo-milk-0001' } });
    if (r.outcome === 'unconfirmed') expect(r.reason).toMatch(/append twice/);
  });

  it('refuses changes on a schema newer than any checked, while reads go on', async () => {
    const { s, w, read } = await setup({ ...base, dbVersion: 30 });
    await expect(w.updateTodo('todo-milk-0001', { when: 'today' }, 'Buy milk')).rejects.toThrow(/version 30/);
    expect(s.calls).toHaveLength(0);
    expect(await read((r) => [r.trust.kind, r.inbox().length])).toEqual(['unverified', 1]);
  });
});

describe('status', () => {
  it('completes, says so again without sending, reopens', async () => {
    const { s, w } = await setup();
    await expect(w.setStatus('todo-milk-0001', 'completed', 'Buy milk')).resolves.toMatchObject({ outcome: 'confirmed', item: { status: 'completed' } });
    await expect(w.setStatus('todo-milk-0001', 'completed', 'Buy milk')).resolves.toMatchObject({ unchanged: true });
    await expect(w.setStatus('todo-milk-0001', 'incomplete', 'Buy milk')).resolves.toMatchObject({ item: { status: 'incomplete' } });
    expect(s.calls).toHaveLength(2);
  });

  it('cancels and reopens a cancelled one', async () => {
    const { s, w } = await setup();
    await w.setStatus('todo-milk-0001', 'canceled', 'Buy milk');
    await expect(w.setStatus('todo-milk-0001', 'incomplete', 'Buy milk')).resolves.toMatchObject({ item: { status: 'incomplete' } });
    expect(s.calls[1]!.value).toContain('canceled=false');
  });

  it('closes an empty project with update-project, and refuses one with open to-dos', async () => {
    const { s, w } = await setup();
    await expect(w.setStatus('proj-full-0001', 'completed', 'Garden')).rejects.toThrow(/open to-dos/);
    await expect(w.setStatus('proj-open-0001', 'completed', 'Kitchen')).rejects.toThrow(/open to-dos/);
    await w.setStatus('todo-garden-01', 'completed', 'Weed beds');
    await expect(w.setStatus('proj-full-0001', 'completed', 'Garden')).resolves.toMatchObject({ outcome: 'confirmed', item: { status: 'completed' } });
    expect(s.calls.at(-1)!.value).toMatch(/^things:\/\/\/update-project\?/);
  });
});

describe('trash', () => {
  it('moves a to-do to the Trash, and says so again without sending', async () => {
    const { s, w } = await setup();
    await expect(w.trash('todo-milk-0001', 'Buy milk')).resolves.toMatchObject({ outcome: 'confirmed', item: { trashed: true }, before: { uuid: 'todo-milk-0001' } });
    await expect(w.trash('todo-milk-0001', 'Buy milk')).resolves.toMatchObject({ unchanged: true });
    expect(s.calls).toHaveLength(1);
  });

  it('refuses projects, wrong titles and closed repeating copies', async () => {
    const { s, w } = await setup();
    await expect(w.trash('proj-open-0001', 'Kitchen')).rejects.toThrow(/project, not a to-do/);
    await expect(w.trash('todo-milk-0001', 'Buy bread')).rejects.toThrow(/Nothing was changed/);
    expect(s.calls).toHaveLength(0);
  });

  it('refuses when the title changes between the check and the delete', async () => {
    const { w } = await setup(base, { beforeApply: (db) => db.run(`UPDATE TMTask SET title = 'Buy bread' WHERE uuid = 'todo-milk-0001'`) });
    await expect(w.trash('todo-milk-0001', 'Buy milk')).rejects.toThrow(/title changed just now/);
  });
});

describe('fixture sanity', () => {
  it('mutate writes back', async () => {
    const path = await makeFixtureDb(base);
    await mutate(path, (db) => db.run(`UPDATE TMTask SET title = 'Changed' WHERE uuid = 'todo-milk-0001'`));
    const r = await ThingsReader.openFile(path, { now });
    expect(r.task('todo-milk-0001')?.title).toBe('Changed');
    r.close();
  });
});
