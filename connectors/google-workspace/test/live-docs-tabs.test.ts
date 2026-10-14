/**
 * Live probe for Docs tabs: tab tree, tab-scoped reads and edits, tab
 * management, tab copy and the anchored insert, run in-process against a real
 * test Doc. Skipped unless MCP_GW_LIVE_DOCS_TABS=1.
 *
 * Environment (values are never committed):
 * - MCP_GW_LIVE_INSTANCE_ROOT   directory with accounts.json and credentials/<account>.token.json.
 *                               It is copied to a temp directory first, so a token refresh never
 *                               rewrites the original.
 * - MCP_GW_LIVE_ACCOUNT_EMAIL   the account in that accounts.json.
 * - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   OAuth client for token refresh. When unset they are
 *                               read from the host repo at MCP_GW_LIVE_HOST_ROOT.
 * - MCP_GW_LIVE_DOC_ID          a dedicated test Doc (many tabs, some nested).
 * - MCP_GW_LIVE_SOURCE_TAB_ID   a filled tab in that Doc to copy (only ever read).
 * - MCP_GW_LIVE_MIN_TABS        optional; minimum tab count expected (default 41).
 * - MCP_GW_LIVE_SHEET_ID        optional test Sheet for the Sheets section.
 *
 * Rules: every tab the probe creates is titled "ZZ probe <run-id> …" and the whole
 * sandbox is deleted again (in the last test, and in afterAll if a test failed
 * first). Tabs that existed before the run must keep a byte-identical
 * documentTab. Nothing the probe prints or asserts on contains tokens, document
 * text or titles: assertions compare booleans and counts with messages that name
 * tab ids, paragraph indices and kinds only. An error the probe did not write
 * (from the API or the connector) is reported only as its class, HTTP status and
 * error code, never its message, since that can quote document text.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The connector's logger would print the account email and progress lines; the
// probe reports through its own summary instead.
vi.mock('../src/utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const LIVE_ENABLED = process.env.MCP_GW_LIVE_DOCS_TABS === '1';
const liveDescribe = LIVE_ENABLED ? describe : describe.skip;
const PROBE_TIMEOUT_MS = 300_000;

const RUN_ID = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const PREFIX = `ZZ probe ${RUN_ID}`;
const INVALID_PARAMS = -32602;
const PARAGRAPH_FIELDS = [
  'alignment',
  'indentStart',
  'indentEnd',
  'indentFirstLine',
  'spaceAbove',
  'spaceBelow',
  'lineSpacing',
] as const;
type ParagraphField = (typeof PARAGRAPH_FIELDS)[number];
const TEXT_STYLE_KEYS = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'smallCaps',
  'fontSize',
  'foregroundColor',
  'backgroundColor',
  'weightedFontFamily',
  'baselineOffset',
  'link',
] as const;

type Tab = docs_v1.Schema$Tab;
type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type FlatTabView = {
  tabId: string;
  title: string;
  parentTabId: string | null;
  index: number;
  nestingLevel: number;
  childCount: number;
  tab: Tab;
};
type Mismatch = { paragraph?: number; table?: number; kind: string };

// ---------------------------------------------------------------------------
// Probe state (filled in beforeAll / by earlier steps)
// ---------------------------------------------------------------------------

const env = {
  instanceRoot: process.env.MCP_GW_LIVE_INSTANCE_ROOT ?? '',
  email: process.env.MCP_GW_LIVE_ACCOUNT_EMAIL ?? '',
  documentId: process.env.MCP_GW_LIVE_DOC_ID ?? '',
  sourceTabId: process.env.MCP_GW_LIVE_SOURCE_TAB_ID ?? '',
  minTabs: Number(process.env.MCP_GW_LIVE_MIN_TABS ?? '41'),
};

let tempRoot: string | undefined;
let originalCredentialStats: Array<{ file: string; mtimeMs: number; size: number }> = [];
let handlers: Record<string, Handler> = {};
let docsClient: (() => Promise<docs_v1.Docs>) | undefined;
let flattenTabsFn: ((tabs: Tab[] | undefined) => FlatTabView[]) | undefined;
let flatParagraphsFn:
  | ((body: docs_v1.Schema$Body | undefined) => Array<{ paragraph: docs_v1.Schema$Paragraph; container: unknown }>)
  | undefined;
let extractBodyTextFn: ((body: docs_v1.Schema$Body | undefined, opts?: object) => string) | undefined;
let tabReadTextOptions: object = {};
let tabTreeFields = '';

/** contentHash of each pre-existing tab's documentTab, keyed by tab id. */
const beforeSnapshot = new Map<string, string>();
/** Ids of tabs created by the probe, by role. */
const ids: Record<string, string> = {};
/** Safe findings (ids, counts, booleans) printed once at the end. */
const notes: Record<string, unknown> = { runId: RUN_ID };
let sandboxCleaned = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function check(condition: boolean, message: string): void {
  expect(condition, message).toBe(true);
}

function need(role: string): string {
  const id = ids[role];
  if (!id) throw new ProbeError(`needs the "${role}" sandbox tab from an earlier step, which did not complete`);
  return id;
}

/** An error the probe wrote itself: its message names ids, counts, roles and kinds only. */
class ProbeError extends Error {}

function httpStatus(error: unknown): number | undefined {
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  for (const value of [e?.response?.status, e?.status, e?.code]) {
    const status = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

function statusCategory(status: number): string {
  if (status === 401 || status === 403) return 'auth or permission';
  if (status === 404) return 'not found';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'server error';
  return status >= 400 ? 'request rejected' : 'unexpected';
}

/**
 * A failure summary built only from allowlisted fields: the error class, the
 * numeric HTTP status with its category, and a numeric (MCP) or Node system
 * error code. A message the probe did not write is never included.
 */
function safeError(error: unknown): string {
  if (error instanceof ProbeError) return error.message;
  const className = error instanceof Error ? error.constructor.name : typeof error;
  const parts = [/^[A-Za-z_$][\w$]{0,60}$/.test(className) ? className : 'Error'];
  const status = httpStatus(error);
  if (status !== undefined) parts.push(`HTTP ${status} (${statusCategory(status)})`);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number' && code !== status) parts.push(`code ${code}`);
  else if (typeof code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(code)) parts.push(`code ${code}`);
  return parts.join(', ');
}

/** Run one step; on failure rethrow a new error (no cause) with an allowlisted summary. */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new ProbeError(`${label} failed — ${safeError(error)}`);
  }
}

/** Call a tool handler; returns its text and whether it is an error result. */
async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const handler = handlers[name];
  if (!handler) throw new ProbeError(`handler ${name} not loaded`);
  const result = await step(name, () => handler({ email: env.email, document_id: env.documentId, ...args }));
  if (typeof result === 'string') return { text: result, isError: false };
  const response = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  return {
    text: response.content?.find((block) => block.type === 'text')?.text ?? '',
    isError: response.isError === true,
  };
}

/** True when the handler refuses the call with InvalidParams. */
async function refused(name: string, args: Record<string, unknown>): Promise<boolean> {
  const handler = handlers[name];
  if (!handler) throw new ProbeError(`handler ${name} not loaded`);
  try {
    await handler({ email: env.email, document_id: env.documentId, ...args });
    return false;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === INVALID_PARAMS;
  }
}

async function client(): Promise<docs_v1.Docs> {
  if (!docsClient) throw new ProbeError('Docs client not loaded');
  return docsClient();
}

async function readFull(suggestionsViewMode?: string): Promise<docs_v1.Schema$Document> {
  const docs = await client();
  const response = await step('documents.get (full)', () =>
    docs.documents.get({
      documentId: env.documentId,
      includeTabsContent: true,
      ...(suggestionsViewMode ? { suggestionsViewMode } : {}),
    })
  );
  return response.data;
}

async function readTree(): Promise<FlatTabView[]> {
  const docs = await client();
  const response = await step('documents.get (tree)', () =>
    docs.documents.get({ documentId: env.documentId, includeTabsContent: true, fields: tabTreeFields })
  );
  return flatten(response.data.tabs);
}

function flatten(tabs: Tab[] | undefined): FlatTabView[] {
  if (!flattenTabsFn) throw new ProbeError('tabs module not loaded');
  return flattenTabsFn(tabs);
}

function findTab(flat: FlatTabView[], tabId: string): FlatTabView | undefined {
  return flat.find((tab) => tab.tabId === tabId);
}

async function fullTab(tabId: string, suggestionsViewMode?: string): Promise<Tab> {
  const tab = findTab(flatten((await readFull(suggestionsViewMode)).tabs), tabId)?.tab;
  if (!tab) throw new ProbeError(`tab ${tabId} not found`);
  return tab;
}

async function batchUpdate(label: string, requests: object[]): Promise<void> {
  const docs = await client();
  await step(label, () =>
    docs.documents.batchUpdate({
      documentId: env.documentId,
      requestBody: { requests: requests as docs_v1.Schema$Request[] },
    })
  );
}

/** Add a sandbox tab through the tool; returns its id from the re-read tree. */
async function addSandboxTab(role: string, args: Record<string, unknown> = {}): Promise<string> {
  const title = `${PREFIX} ${role}`;
  await tool('handleAddDocumentTab', { title, ...args });
  const created = (await readTree()).find((tab) => tab.title === title);
  if (!created) throw new ProbeError(`sandbox tab "${role}" not found after add`);
  ids[role] = created.tabId;
  return created.tabId;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/** Copy of `value` with every `contentUri` key removed, at any depth. */
function withoutContentUris(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutContentUris);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'contentUri').map(([key, child]) => [key, withoutContentUris(child)])
  );
}

/** Hash for the pre-existing-tab equality check. Ignores contentUri: image URLs are signed and Google rotates them on every read. */
function contentHash(documentTab: unknown): string {
  return hash(withoutContentUris(documentTab));
}

function tabIdsIn(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(/\[tabId: ([^\]]+)\]/g)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

function paragraphText(paragraph: docs_v1.Schema$Paragraph): string {
  return (paragraph.elements ?? []).map((element) => element.textRun?.content ?? '').join('');
}

function tabParagraphs(tab: Tab): docs_v1.Schema$Paragraph[] {
  if (!flatParagraphsFn) throw new ProbeError('tabs module not loaded');
  return flatParagraphsFn(tab.documentTab?.body).map((entry) => entry.paragraph);
}

function tabText(tab: Tab): string {
  return tabParagraphs(tab).map(paragraphText).join('');
}

function namedStyle(tab: Tab, type: string | null | undefined): docs_v1.Schema$NamedStyle | undefined {
  return (tab.documentTab?.namedStyles?.styles ?? []).find((style) => style.namedStyleType === (type ?? 'NORMAL_TEXT'));
}

function normaliseField(field: ParagraphField, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (field === 'alignment' || field === 'lineSpacing') return value;
  return (value as docs_v1.Schema$Dimension).magnitude ?? 0;
}

const FIELD_DEFAULTS: Record<ParagraphField, unknown> = {
  alignment: 'START',
  indentStart: 0,
  indentEnd: 0,
  indentFirstLine: 0,
  spaceAbove: 0,
  spaceBelow: 0,
  lineSpacing: 100,
};

/** A paragraph's value for a field: its own, else its named style's, else NORMAL_TEXT's, else the default. */
function effectiveField(tab: Tab, paragraph: docs_v1.Schema$Paragraph, field: ParagraphField): unknown {
  const own = paragraph.paragraphStyle as Record<string, unknown> | undefined;
  const fromNamed = namedStyle(tab, paragraph.paragraphStyle?.namedStyleType)?.paragraphStyle as
    | Record<string, unknown>
    | undefined;
  const fromNormal = namedStyle(tab, 'NORMAL_TEXT')?.paragraphStyle as Record<string, unknown> | undefined;
  return (
    normaliseField(field, own?.[field]) ??
    normaliseField(field, fromNamed?.[field]) ??
    normaliseField(field, fromNormal?.[field]) ??
    FIELD_DEFAULTS[field]
  );
}

function stripForCompare(text: string, bulleted: boolean): string {
  let out = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (bulleted) out = out.replace(/^\t+/, '');
  return out;
}

/**
 * Independent re-check of a copy (written apart from the tool's own verifier):
 * paragraph text, named style, paragraph formatting, bullets and list grouping,
 * table shapes. Non-bullet paragraphs compare effective values of every
 * PARAGRAPH_FIELDS entry (so a leftover from a cleared target shows up);
 * bullet paragraphs compare only the fields set on the source paragraph (their
 * indents otherwise come from the list preset).
 */
function compareCopy(source: Tab, target: Tab): { paragraphs: number; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  const src = tabParagraphs(source);
  const tgt = tabParagraphs(target);
  if (src.length !== tgt.length) {
    mismatches.push({ kind: `paragraphCount ${src.length}→${tgt.length}` });
    return { paragraphs: src.length, mismatches };
  }

  const listMap = new Map<string, string>();
  const reverseListMap = new Map<string, string>();
  src.forEach((sp, i) => {
    const tp = tgt[i];
    const bulleted = Boolean(sp.bullet);

    // Text: plain paragraphs must match exactly; paragraphs with chips, people,
    // dates or other elements must contain the source's text runs in order.
    const plainOnly = (sp.elements ?? []).every((element) => element.textRun);
    const targetText = stripForCompare(paragraphText(tp), Boolean(tp.bullet));
    if (plainOnly) {
      if (stripForCompare(paragraphText(sp), bulleted) !== targetText) mismatches.push({ paragraph: i, kind: 'text' });
    } else {
      let cursor = 0;
      for (const element of sp.elements ?? []) {
        const segment = (element.textRun?.content ?? '').replace(/\n$/, '').replace(bulleted ? /^\t+/ : /^$/, '');
        if (!segment) continue;
        const found = targetText.indexOf(segment, cursor);
        if (found < 0) {
          mismatches.push({ paragraph: i, kind: 'text (run missing)' });
          break;
        }
        cursor = found + segment.length;
      }
    }

    if ((sp.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT') !== (tp.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT')) {
      mismatches.push({ paragraph: i, kind: 'namedStyle' });
    }

    if (bulleted !== Boolean(tp.bullet)) {
      mismatches.push({ paragraph: i, kind: 'bullet' });
    } else if (sp.bullet && tp.bullet) {
      if ((sp.bullet.nestingLevel ?? 0) !== (tp.bullet.nestingLevel ?? 0)) mismatches.push({ paragraph: i, kind: 'nestingLevel' });
      const s = sp.bullet.listId ?? '';
      const t = tp.bullet.listId ?? '';
      if ((listMap.has(s) && listMap.get(s) !== t) || (reverseListMap.has(t) && reverseListMap.get(t) !== s)) {
        mismatches.push({ paragraph: i, kind: 'listGrouping' });
      }
      listMap.set(s, t);
      reverseListMap.set(t, s);
    }

    for (const field of PARAGRAPH_FIELDS) {
      if (bulleted) {
        const own = (sp.paragraphStyle as Record<string, unknown> | undefined)?.[field];
        if (own === undefined || own === null) continue;
        const targetOwn = (tp.paragraphStyle as Record<string, unknown> | undefined)?.[field];
        if (JSON.stringify(normaliseField(field, own)) !== JSON.stringify(normaliseField(field, targetOwn) ?? FIELD_DEFAULTS[field])) {
          mismatches.push({ paragraph: i, kind: `paragraphStyle.${field} (bullet)` });
        }
      } else if (JSON.stringify(effectiveField(source, sp, field)) !== JSON.stringify(effectiveField(target, tp, field))) {
        mismatches.push({ paragraph: i, kind: `paragraphStyle.${field}` });
      }
    }
  });

  const tables = (tab: Tab) =>
    (tab.documentTab?.body?.content ?? []).filter((element) => element.table).map((element) => element.table!);
  const srcTables = tables(source);
  const tgtTables = tables(target);
  if (srcTables.length !== tgtTables.length) {
    mismatches.push({ kind: `tableCount ${srcTables.length}→${tgtTables.length}` });
  } else {
    srcTables.forEach((table, t) => {
      if (table.rows !== tgtTables[t].rows || table.columns !== tgtTables[t].columns) {
        mismatches.push({ table: t, kind: 'tableShape' });
      }
    });
  }
  return { paragraphs: src.length, mismatches };
}

function describeMismatches(mismatches: Mismatch[]): string {
  const counts = new Map<string, number>();
  for (const m of mismatches) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const summary = [...counts].map(([kind, n]) => `${kind} ×${n}`).join(', ');
  const first = mismatches
    .slice(0, 5)
    .map((m) => (m.paragraph !== undefined ? `p${m.paragraph} ${m.kind}` : m.table !== undefined ? `t${m.table} ${m.kind}` : m.kind))
    .join('; ');
  return `${mismatches.length} differences (${summary}); first: ${first}`;
}

/** The verification part of a copy result, which names indices and kinds only. */
function verificationSummary(text: string): string {
  return text.match(/Verification: (passed|FAILED — \d+ differences? \(first: [^)]*\))/)?.[0] ?? 'no Verification line';
}

/** Counts reported by a copy result (numbers only). */
function copyCounts(text: string): Record<string, number> {
  const num = (re: RegExp) => Number(text.match(re)?.[1] ?? 0);
  return {
    paragraphsChecked: num(/Verification: passed — (\d+) paragraph/),
    chipsCopied: num(/(\d+) smart chips? copied/),
    chipFallbacks: num(/; (\d+) replaced by titled links/),
    people: num(/(\d+) people and \d+ dates copied as text/),
    dates: num(/\d+ people and (\d+) dates copied as text/),
    namedStylesCopied: num(/Named styles copied: (\d+)/),
    placeholders: num(/(\d+) placeholder\(s\)/),
    requests: num(/Requests: (\d+) in/),
    rounds: num(/Requests: \d+ in (\d+) rounds/),
  };
}

function isSandboxTitle(title: string): boolean {
  return title.toLowerCase().startsWith(PREFIX.toLowerCase());
}

/** Delete every sandbox subtree (never a tab whose subtree holds a non-sandbox tab). */
async function deleteSandbox(): Promise<{ deleted: number; refused: string[] }> {
  const flat = await readTree();
  const byId = new Map(flat.map((tab) => [tab.tabId, tab]));
  const roots = flat.filter(
    (tab) => isSandboxTitle(tab.title) && !(tab.parentTabId && isSandboxTitle(byId.get(tab.parentTabId)?.title ?? ''))
  );
  const refusedIds: string[] = [];
  let deleted = 0;
  for (const root of roots) {
    const subtree: FlatTabView[] = [];
    const collect = (id: string) => {
      for (const child of flat.filter((tab) => tab.parentTabId === id)) {
        subtree.push(child);
        collect(child.tabId);
      }
    };
    collect(root.tabId);
    if (subtree.some((tab) => !isSandboxTitle(tab.title))) {
      refusedIds.push(root.tabId);
      continue;
    }
    await batchUpdate(`delete sandbox tab ${root.tabId}`, [{ deleteTab: { tabId: root.tabId } }]);
    deleted += 1 + subtree.length;
  }
  return { deleted, refused: refusedIds };
}

function readEmbeddedGoogleOAuthCredentials(hostRoot: string): { clientId: string; clientSecret: string } {
  const source = fs.readFileSync(path.join(hostRoot, 'src/core/services/oauthCredentials.ts'), 'utf8');
  const googleBlock = source.match(/google:\s*{([\s\S]*?)}/)?.[1] ?? '';
  const clientId = googleBlock.match(/clientId:\s*'([^']+)'/)?.[1];
  const clientSecret = googleBlock.match(/clientSecret:\s*'([^']+)'/)?.[1];
  if (!clientId || !clientSecret) throw new ProbeError('Unable to locate embedded Google OAuth credentials in MCP_GW_LIVE_HOST_ROOT');
  return { clientId, clientSecret };
}

/** Copy one regular file, keeping its permission bits (0600 token files stay 0600). */
function copyFilePreservingMode(from: string, to: string): void {
  const stats = fs.lstatSync(from);
  if (!stats.isFile()) throw new ProbeError('instance directory entries must be regular files');
  fs.copyFileSync(from, to);
  fs.chmodSync(to, stats.mode & 0o777);
}

/** Temp copy of accounts.json + credentials/, so the probe never writes the real credential files. */
function copyInstance(sourceRoot: string): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gw-live-docs-tabs-'));
  try {
    fs.chmodSync(root, 0o700);
    copyFilePreservingMode(path.join(sourceRoot, 'accounts.json'), path.join(root, 'accounts.json'));
    const credentialsSource = path.join(sourceRoot, 'credentials');
    const credentialsCopy = path.join(root, 'credentials');
    fs.mkdirSync(credentialsCopy, { mode: 0o700 });
    for (const name of fs.readdirSync(credentialsSource)) {
      const from = path.join(credentialsSource, name);
      if (!fs.lstatSync(from).isFile()) continue;
      const stats = fs.statSync(from);
      originalCredentialStats.push({ file: from, mtimeMs: stats.mtimeMs, size: stats.size });
      copyFilePreservingMode(from, path.join(credentialsCopy, name));
    }
    return root;
  } catch (error) {
    // The caller never receives the path, so remove any credential files copied so far here.
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Docs probe
// ---------------------------------------------------------------------------

liveDescribe('live: Docs tabs', { timeout: PROBE_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    const missing = Object.entries({
      MCP_GW_LIVE_INSTANCE_ROOT: env.instanceRoot,
      MCP_GW_LIVE_ACCOUNT_EMAIL: env.email,
      MCP_GW_LIVE_DOC_ID: env.documentId,
      MCP_GW_LIVE_SOURCE_TAB_ID: env.sourceTabId,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) throw new ProbeError(`Set ${missing.join(', ')} to run the live Docs tabs probe`);

    let clientId = process.env.GOOGLE_CLIENT_ID;
    let clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      const hostRoot = process.env.MCP_GW_LIVE_HOST_ROOT;
      if (!hostRoot) throw new ProbeError('Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or MCP_GW_LIVE_HOST_ROOT');
      ({ clientId, clientSecret } = readEmbeddedGoogleOAuthCredentials(hostRoot));
    }

    tempRoot = copyInstance(env.instanceRoot);
    vi.stubEnv('ACCOUNTS_PATH', path.join(tempRoot, 'accounts.json'));
    vi.stubEnv('CREDENTIALS_PATH', path.join(tempRoot, 'credentials'));
    vi.stubEnv('GOOGLE_CLIENT_ID', clientId);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', clientSecret);
    vi.stubEnv('MCP_WORKSPACE_PATH', tempRoot);

    const { initializeAllServices } = await import('../src/utils/service-initializer.js');
    await step('initialise services', () => initializeAllServices());
    const docsHandlers = await import('../src/tools/docs-handlers.js');
    const docsModule = await import('../src/modules/docs/index.js');
    const tabs = await import('../src/modules/docs/tabs.js');
    handlers = docsHandlers as unknown as Record<string, Handler>;
    flattenTabsFn = tabs.flattenTabs as unknown as typeof flattenTabsFn;
    flatParagraphsFn = tabs.flatParagraphs as unknown as typeof flatParagraphsFn;
    extractBodyTextFn = tabs.extractBodyText as unknown as typeof extractBodyTextFn;
    tabReadTextOptions = tabs.TAB_READ_TEXT_OPTIONS;
    tabTreeFields = tabs.TAB_TREE_FIELDS;
    // The service's own scope-checked client, so raw reads share the connector's auth.
    const service = docsModule.getDocsService() as unknown as { getWriteClient(email: string): Promise<docs_v1.Docs> };
    docsClient = () => service.getWriteClient(env.email);

    const doc = await readFull();
    for (const tab of flatten(doc.tabs)) {
      beforeSnapshot.set(tab.tabId, contentHash(tab.tab.documentTab));
    }
    if (flatten(doc.tabs).some((tab) => isSandboxTitle(tab.title))) {
      throw new ProbeError('a tab with this run id already exists; refusing to run');
    }
    if (!beforeSnapshot.has(env.sourceTabId)) throw new ProbeError('MCP_GW_LIVE_SOURCE_TAB_ID is not a tab of MCP_GW_LIVE_DOC_ID');
    notes.tabsBefore = beforeSnapshot.size;
  }, PROBE_TIMEOUT_MS);

  afterAll(async () => {
    try {
      if (docsClient && !sandboxCleaned) {
        try {
          const result = await deleteSandbox();
          notes.afterAllCleanup = result;
        } catch (error) {
          notes.afterAllCleanupError = safeError(error);
        }
      }
    } finally {
      if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
      console.log(`[live-docs-tabs] ${JSON.stringify(notes)}`);
    }
  }, PROBE_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // (1) Tab tree
  // -------------------------------------------------------------------------

  it('(1) tree: tab count, nesting and parent ids are consistent with a full fetch', async () => {
    const flat = flatten((await readFull()).tabs);
    notes.tabCount = flat.length;
    check(flat.length >= env.minTabs, `expected at least ${env.minTabs} tabs, found ${flat.length}`);
    for (const [i, tab] of flat.entries()) {
      const props = tab.tab.tabProperties;
      check((props?.parentTabId ?? null) === tab.parentTabId, `tab ${tab.tabId}: parentTabId differs from its place in the tree`);
      if (props?.nestingLevel !== undefined && props.nestingLevel !== null) {
        check(props.nestingLevel === tab.nestingLevel, `tab ${tab.tabId}: nestingLevel ${props.nestingLevel} vs depth ${tab.nestingLevel}`);
      }
      if (tab.parentTabId !== null) {
        const parentAt = flat.findIndex((t) => t.tabId === tab.parentTabId);
        check(parentAt >= 0 && parentAt < i, `tab ${tab.tabId}: parent missing or after the child`);
        check(flat[parentAt].nestingLevel + 1 === tab.nestingLevel, `tab ${tab.tabId}: depth is not parent depth + 1`);
      }
    }
    notes.maxNesting = Math.max(...flat.map((tab) => tab.nestingLevel));
  });

  it('(1) tree: the TAB_TREE_FIELDS read equals the full-fetch tree (PR merge gate)', async () => {
    const full = flatten((await readFull()).tabs);
    const masked = await readTree();
    check(masked.length === full.length, `masked read has ${masked.length} tabs, full read ${full.length}`);
    for (const [i, tab] of full.entries()) {
      const other = masked[i];
      const same =
        other !== undefined &&
        other.tabId === tab.tabId &&
        other.parentTabId === tab.parentTabId &&
        other.index === tab.index &&
        other.nestingLevel === tab.nestingLevel &&
        other.childCount === tab.childCount &&
        other.title === tab.title;
      check(same, `tab ${tab.tabId} (position ${i}) differs between the masked and the full read`);
    }
  });

  it('(1) tree: list_workspace_document_tabs lists every tab in tree order', async () => {
    const full = flatten((await readFull()).tabs);
    const { text } = await tool('handleListDocumentTabs', {});
    const topLevel = full.filter((tab) => tab.nestingLevel === 0).length;
    check(text.includes(`Tabs: ${full.length} (${topLevel} top-level)`), 'list header count is wrong');
    const listed = tabIdsIn(text);
    check(listed.length === full.length, `list shows ${listed.length} tab ids, document has ${full.length}`);
    check(listed.every((id, i) => id === full[i].tabId), 'list order differs from the tree order');
  });

  // -------------------------------------------------------------------------
  // (2) Tab-scoped reads
  // -------------------------------------------------------------------------

  it('(2) read: tab_id returns that tab', async () => {
    const { text } = await tool('handleReadDocument', { tab_id: env.sourceTabId });
    check(new RegExp(`\\nTab: .*\\[tabId: ${env.sourceTabId.replace(/\./g, '\\.')}\\]`).test(text), 'no "Tab:" line naming the source tab id');
    const source = await fullTab(env.sourceTabId);
    const expected = extractBodyTextFn!(source.documentTab?.body, tabReadTextOptions);
    const prefix = expected.slice(0, 500);
    check(prefix.length === 0 || prefix.includes('</untrusted-content') || text.includes(prefix), 'tab_id read does not contain the source tab text');
  });

  it('(2) read: "default" and no tab argument both mean the first tab', async () => {
    const full = flatten((await readFull()).tabs);
    const first = full.find((tab) => tab.nestingLevel === 0)!;
    const viaDefault = await tool('handleReadDocument', { tab_id: 'default', max_chars: 200 });
    check(viaDefault.text.includes(`[tabId: ${first.tabId}]`), '"default" did not resolve to the first top-level tab');
    const noArg = await tool('handleReadDocument', { max_chars: 200 });
    check(noArg.text.includes(`Tabs: ${full.length} — showing the first tab`), 'no-tab read lacks the tab-count line');
    check(noArg.text.includes(`[tabId: ${first.tabId}]`), 'no-tab read does not name the first tab id');
  });

  it('(2) read: all_tabs shares one max_chars budget and lists the rest', async () => {
    const full = flatten((await readFull()).tabs);
    const { text } = await tool('handleReadDocument', { all_tabs: true, max_chars: 2000 });
    check(text.includes('[Not shown in full — over the max_chars budget'), 'all_tabs read with a small budget has no "not shown" list');
    const mentioned = tabIdsIn(text);
    check(mentioned.length === full.length, `all_tabs read mentions ${mentioned.length} tab ids, document has ${full.length}`);
    check(mentioned.every((id, i) => id === full[i].tabId), 'all_tabs read is not in tree order');
  });

  // -------------------------------------------------------------------------
  // (3) Tab-scoped append and find/replace
  // -------------------------------------------------------------------------

  it('(3) edit: append and find/replace with tab_id touch only that tab', async () => {
    const one = await addSandboxTab('edit one');
    const two = await addSandboxTab('edit two');
    const token = `ZZTOKEN${RUN_ID}`;
    const appended = await tool('handleAppendDocument', { tab_id: one, text: `${token}\n` });
    check(appended.text.includes(`(tab ${one})`), 'append result does not name the tab');
    await tool('handleAppendDocument', { tab_id: two, text: `${token}\n` });

    const replaced = await tool('handleFindAndReplace', {
      tab_id: one,
      find_text: token,
      replace_text: `ZZDONE${RUN_ID}`,
      match_case: true,
    });
    check(replaced.text.includes('Replaced 1 occurrence '), 'scoped find/replace did not report exactly 1 occurrence');
    const doc = flatten((await readFull()).tabs);
    const textOne = tabText(findTab(doc, one)!.tab);
    const textTwo = tabText(findTab(doc, two)!.tab);
    check(!textOne.includes(token) && textOne.includes(`ZZDONE${RUN_ID}`), `tab ${one} was not changed as expected`);
    check(textTwo.includes(token), `tab ${two} was changed by a find/replace scoped to ${one}`);
  });

  // -------------------------------------------------------------------------
  // (4) Tab management
  // -------------------------------------------------------------------------

  function childrenOf(flat: FlatTabView[], parent: string | null): string[] {
    return flat.filter((tab) => tab.parentTabId === parent).sort((a, b) => a.index - b.index).map((tab) => tab.tabId);
  }

  it('(4) add: without a position the tab lands at the end of its siblings (A7)', async () => {
    const parent = await addSandboxTab('parent');
    const topLevel = childrenOf(await readTree(), null);
    const lastTop = topLevel[topLevel.length - 1] === parent;
    for (const role of ['c1', 'c2', 'c3']) await addSandboxTab(role, { parent_tab_id: parent });
    const kids = childrenOf(await readTree(), parent);
    const childrenInOrder = kids.join() === [ids.c1, ids.c2, ids.c3].join();
    notes.A7_addWithoutIndexAppendsAtEnd = lastTop && childrenInOrder;
    check(lastTop, `new top-level tab ${parent} is not last among top-level tabs`);
    check(childrenInOrder, `sub-tabs of ${parent} are not in creation order: ${kids.join(', ')}`);
  });

  it('(4) add: with a position the tab lands there', async () => {
    const parent = need('parent');
    await addSandboxTab('c0', { parent_tab_id: parent, position: 0 });
    const kids = childrenOf(await readTree(), parent);
    check(kids.join() === [ids.c0, ids.c1, ids.c2, ids.c3].join(), `expected c0 first, got ${kids.join(', ')}`);
  });

  it('(4) update: rename', async () => {
    const c1 = need('c1');
    const title = `${PREFIX} c1 renamed`;
    await tool('handleUpdateDocumentTab', { tab_id: c1, title });
    check(findTab(await readTree(), c1)?.title === title, `tab ${c1} title did not change`);
  });

  it('(4) update: same-parent forward move', async () => {
    const parent = need('parent');
    await tool('handleUpdateDocumentTab', { tab_id: need('c0'), position: 2 });
    const kids = childrenOf(await readTree(), parent);
    check(kids.join() === [ids.c1, ids.c2, ids.c0, ids.c3].join(), `forward move: got ${kids.join(', ')}`);
  });

  it('(4) update: same-parent backward move', async () => {
    const parent = need('parent');
    await tool('handleUpdateDocumentTab', { tab_id: need('c0'), position: 0 });
    const kids = childrenOf(await readTree(), parent);
    check(kids.join() === [ids.c0, ids.c1, ids.c2, ids.c3].join(), `backward move: got ${kids.join(', ')}`);
  });

  it('(4) update: re-parent under another tab', async () => {
    const other = await addSandboxTab('other');
    await tool('handleUpdateDocumentTab', { tab_id: need('c1'), parent_tab_id: other, position: 0 });
    await tool('handleUpdateDocumentTab', { tab_id: need('c3'), parent_tab_id: need('c2') });
    const flat = await readTree();
    check(findTab(flat, ids.c1)?.parentTabId === other, `tab ${ids.c1} is not under ${other}`);
    check(findTab(flat, ids.c3)?.parentTabId === ids.c2, `tab ${ids.c3} is not under ${ids.c2}`);
    check(childrenOf(flat, need('parent')).join() === [ids.c0, ids.c2].join(), 'old parent keeps the wrong children');
  });

  it('(4) add: a title differing only in case (A8, recorded either way)', async () => {
    const title = `${PREFIX} parent`.toUpperCase();
    let accepted = false;
    try {
      await tool('handleAddDocumentTab', { title });
      accepted = (await readTree()).some((tab) => tab.title === title);
    } catch {
      accepted = false;
    }
    notes.A8_caseVariantTitleAccepted = accepted;
  });

  it('(4) delete: a tab with sub-tabs is refused without delete_sub_tabs', async () => {
    const parent = need('parent');
    check(await refused('handleDeleteDocumentTab', { tab_id: parent }), 'delete without delete_sub_tabs was not refused');
    check(findTab(await readTree(), parent) !== undefined, `tab ${parent} was deleted despite the refusal`);
  });

  it('(4) delete: with delete_sub_tabs the whole subtree goes', async () => {
    const parent = need('parent');
    const before = await readTree();
    const descendants: string[] = [];
    const walk = (id: string) => {
      for (const child of before.filter((tab) => tab.parentTabId === id)) {
        descendants.push(child.tabId);
        walk(child.tabId);
      }
    };
    walk(parent);
    check(descendants.length > 0, `tab ${parent} has no sub-tabs left to delete with it`);
    const { text } = await tool('handleDeleteDocumentTab', { tab_id: parent, delete_sub_tabs: true });
    const after = await readTree();
    check(findTab(after, parent) === undefined, `tab ${parent} still exists`);
    check(descendants.every((id) => findTab(after, id) === undefined), 'a sub-tab survived the delete');
    check(after.length === before.length - 1 - descendants.length, 'the delete removed a different number of tabs');
    check(text.includes(`and ${descendants.length} sub-tab`), `delete result does not report ${descendants.length} sub-tabs`);
  });

  // -------------------------------------------------------------------------
  // (5) Copy
  // -------------------------------------------------------------------------

  it('(5) copy into a new tab reports Verification: passed', async () => {
    const title = `${PREFIX} copy A`;
    const result = await tool('handleCopyDocumentTab', { source_tab_id: env.sourceTabId, new_tab_title: title });
    const created = (await readTree()).find((tab) => tab.title === title);
    if (created) ids.copyA = created.tabId;
    notes.copyNew = { ...copyCounts(result.text), isError: result.isError, tabId: created?.tabId };
    check(!result.isError && result.text.includes('Verification: passed'), `copy into a new tab: ${verificationSummary(result.text)}`);
  });

  it('(5) copy into a new tab: independent re-check of text, styles, paragraph formatting, lists, tables', async () => {
    const source = await fullTab(env.sourceTabId, 'PREVIEW_WITHOUT_SUGGESTIONS');
    const plainSource = await fullTab(env.sourceTabId);
    notes.A9_sourceSuggestionsViewDiffers = hash(source.documentTab?.body) !== hash(plainSource.documentTab?.body);
    const { paragraphs, mismatches } = compareCopy(source, await fullTab(need('copyA')));
    notes.copyNewRecheck = { paragraphs, mismatches: mismatches.length };
    check(mismatches.length === 0, `copy A vs source: ${describeMismatches(mismatches)}`);
  });

  it('(5) copy into an existing tab (cleared first) reports Verification: passed', async () => {
    const target = await addSandboxTab('overwrite target');
    // A leftover candidate: the target's last paragraph is a nested, centred bullet.
    // createParagraphBullets takes each paragraph's nesting from its leading tabs (and
    // removes them), so the tab is in the text before the bullets; both lines are
    // bulleted so the nested item sits under a level-0 item. Alignment goes on after;
    // 12..21 lies inside "last line" whether or not the tab has been removed.
    await batchUpdate('prepare overwrite target', [
      { insertText: { location: { index: 1, tabId: target }, text: 'first line\n\tlast line' } },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 22, tabId: target },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
      {
        updateParagraphStyle: {
          range: { startIndex: 12, endIndex: 21, tabId: target },
          paragraphStyle: { alignment: 'CENTER' },
          fields: 'alignment',
        },
      },
    ]);
    const prepared = tabParagraphs(await fullTab(target));
    const last = prepared[prepared.length - 1];
    const lastIsNestedBullet = (last?.bullet?.nestingLevel ?? 0) >= 1;
    const lastIsCentred = last?.paragraphStyle?.alignment === 'CENTER';
    notes.overwriteTargetPrepared = { lastIsNestedBullet, lastIsCentred };
    // A setup that silently didn't take would make the A4 leftover check vacuous.
    check(lastIsNestedBullet === true, 'setup: the overwrite target\'s last paragraph is not a nested bullet');
    check(lastIsCentred === true, 'setup: the overwrite target\'s last paragraph is not centred');

    check(await refused('handleCopyDocumentTab', { source_tab_id: env.sourceTabId, target_tab_id: target }), 'copy into an existing tab without overwrite_existing was not refused');
    const result = await tool('handleCopyDocumentTab', {
      source_tab_id: env.sourceTabId,
      target_tab_id: target,
      overwrite_existing: true,
    });
    notes.copyOverwrite = { ...copyCounts(result.text), isError: result.isError, tabId: target };
    check(!result.isError && result.text.includes('Verification: passed'), `copy into an existing tab: ${verificationSummary(result.text)}`);
  });

  it('(5) copy into an existing tab: independent re-check', async () => {
    const source = await fullTab(env.sourceTabId, 'PREVIEW_WITHOUT_SUGGESTIONS');
    const { paragraphs, mismatches } = compareCopy(source, await fullTab(need('overwrite target')));
    notes.copyOverwriteRecheck = { paragraphs, mismatches: mismatches.length };
    check(mismatches.length === 0, `overwrite copy vs source: ${describeMismatches(mismatches)}`);
  });

  it('(5) copy into an existing tab leaves no paragraph-format leftover from the cleared target (A4)', async () => {
    const source = await fullTab(env.sourceTabId, 'PREVIEW_WITHOUT_SUGGESTIONS');
    const { mismatches } = compareCopy(source, await fullTab(need('overwrite target')));
    const leftovers = mismatches.filter((m) =>
      ['paragraphStyle.indentStart', 'paragraphStyle.alignment', 'paragraphStyle.spaceAbove'].includes(m.kind)
    );
    notes.A4_leftoverParagraphs = leftovers.length;
    check(leftovers.length === 0, `non-bullet paragraphs differ from the source's effective format: ${describeMismatches(leftovers)}`);
  });

  it('(5) a named-style difference is copied (A16)', async () => {
    const tabA = need('copyA');
    const heading = namedStyle(await fullTab(tabA), 'HEADING_1');
    check(heading !== undefined, `tab ${tabA} has no HEADING_1 named style`);
    const size = heading!.textStyle?.fontSize?.magnitude ?? 20;
    const changed: docs_v1.Schema$NamedStyle = {
      ...heading,
      textStyle: { ...heading!.textStyle, fontSize: { magnitude: size + 7, unit: 'PT' } },
    };
    try {
      await tool('handleBatchUpdateDocument', {
        requests: [{ updateNamedStyle: { tabId: tabA, namedStyle: changed, fields: 'namedStyleType,textStyle,paragraphStyle' } }],
      });
      notes.A16_updateNamedStyleAccepted = true;
    } catch (error) {
      notes.A16_updateNamedStyleAccepted = false;
      // Decision rule A16 applies: drop updateNamedStyle from the copy and report named styles as not copied.
      throw new ProbeError(`A16: the API rejected updateNamedStyle — ${safeError(error)}`);
    }
    const appliedSize = namedStyle(await fullTab(tabA), 'HEADING_1')?.textStyle?.fontSize?.magnitude;
    notes.A16_updateNamedStyleTookEffect = appliedSize === size + 7;
    check(appliedSize === size + 7, `updateNamedStyle was accepted but HEADING_1 in ${tabA} is unchanged`);

    const title = `${PREFIX} copy B`;
    const result = await tool('handleCopyDocumentTab', { source_tab_id: tabA, new_tab_title: title });
    const created = (await readTree()).find((tab) => tab.title === title);
    if (created) ids.copyB = created.tabId;
    const counts = copyCounts(result.text);
    notes.copyNamedStyle = { ...counts, isError: result.isError, tabId: created?.tabId };
    check(!result.isError && result.text.includes('Verification: passed'), `copy A→B: ${verificationSummary(result.text)}`);
    check(counts.namedStylesCopied >= 1, 'copy A→B reports no named style copied');
    const headingA = namedStyle(await fullTab(tabA), 'HEADING_1');
    const headingB = namedStyle(await fullTab(need('copyB')), 'HEADING_1');
    check(hash(headingA?.textStyle) === hash(headingB?.textStyle), 'HEADING_1 text style of B differs from A');
  });

  // -------------------------------------------------------------------------
  // (6) Anchored insert
  // -------------------------------------------------------------------------

  it('(6) insert: next_paragraph_start fills an empty bullet with two plain bullet lines', async () => {
    const tab = await addSandboxTab('insert');
    await tool('handleBatchUpdateDocument', {
      requests: [
        // Heading, one empty bullet, then a closing line (keeps the bullet off the tab's final newline).
        { insertText: { location: { index: 1, tabId: tab }, text: 'ZZ anchor\n\nZZ end' } },
        {
          updateParagraphStyle: {
            range: { startIndex: 1, endIndex: 11, tabId: tab },
            paragraphStyle: { namedStyleType: 'HEADING_2' },
            fields: 'namedStyleType',
          },
        },
        {
          updateParagraphStyle: {
            range: { startIndex: 11, endIndex: 12, tabId: tab },
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            fields: 'namedStyleType',
          },
        },
        {
          createParagraphBullets: {
            range: { startIndex: 11, endIndex: 12, tabId: tab },
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
          },
        },
      ],
    });

    const { text } = await tool('handleInsertDocumentText', {
      tab_id: tab,
      anchor_text: 'ZZ anchor',
      position: 'next_paragraph_start',
      text: 'line one\nline two',
    });
    check(text.includes('The paragraph there was empty, bulleted'), 'insert result does not report an empty bulleted target');

    const paragraphs = tabParagraphs(await fullTab(tab));
    const at = paragraphs.findIndex((p) => paragraphText(p) === 'ZZ anchor\n');
    check(at >= 0, 'anchor heading paragraph not found');
    const [first, second] = [paragraphs[at + 1], paragraphs[at + 2]];
    check(paragraphText(first ?? {}) === 'line one\n' && paragraphText(second ?? {}) === 'line two\n', 'the two inserted lines are not two paragraphs');
    check(Boolean(first?.bullet) && Boolean(second?.bullet), 'inserted lines are not both bulleted');
    check(first?.bullet?.listId === second?.bullet?.listId, 'inserted lines are in different lists');
    const runs = [first, second].flatMap((p) => p?.elements ?? []).filter((element) => element.textRun);
    const styled = runs.filter((element) =>
      TEXT_STYLE_KEYS.some((key) => (element.textRun?.textStyle as Record<string, unknown> | undefined)?.[key] !== undefined)
    );
    check(styled.length === 0, `${styled.length} inserted run(s) carry a character style`);
    notes.anchoredInsert = { paragraphsAfterAnchor: paragraphs.length - at - 1 };
  });

  // -------------------------------------------------------------------------
  // Cleanup and outside-sandbox equality (last)
  // -------------------------------------------------------------------------

  it('cleanup: sandbox deleted; every pre-existing tab is unchanged; credentials untouched', async () => {
    const { deleted, refused: refusedRoots } = await deleteSandbox();
    sandboxCleaned = true;
    notes.sandboxTabsDeleted = deleted;
    check(refusedRoots.length === 0, `sandbox tabs ${refusedRoots.join(', ')} hold non-sandbox sub-tabs and were not deleted`);

    const after = flatten((await readFull()).tabs);
    check(!after.some((tab) => isSandboxTitle(tab.title)), 'sandbox tabs remain after cleanup');
    const missing: string[] = [];
    const changed: string[] = [];
    for (const [tabId, digest] of beforeSnapshot) {
      const tab = findTab(after, tabId);
      if (!tab) missing.push(tabId);
      else if (contentHash(tab.tab.documentTab) !== digest) changed.push(tabId);
    }
    notes.preExistingTabsChanged = changed.length;
    check(missing.length === 0, `pre-existing tabs missing: ${missing.join(', ')}`);
    check(changed.length === 0, `pre-existing tabs whose content changed: ${changed.join(', ')}`);
    check(after.length === beforeSnapshot.size, `tab count ${after.length} differs from ${beforeSnapshot.size} before the run`);

    for (const original of originalCredentialStats) {
      const now = fs.statSync(original.file);
      check(now.mtimeMs === original.mtimeMs && now.size === original.size, 'an original credential file was modified');
    }
  });
});

// ---------------------------------------------------------------------------
// (7) Sheets — placeholder until the Sheets tab tools land. Then gate it on
// MCP_GW_LIVE_DOCS_TABS=1 and MCP_GW_LIVE_SHEET_ID, reuse the temp instance
// copy, and delete every "ZZ probe <run-id> …" sheet in afterAll.
// ---------------------------------------------------------------------------

describe.skip('live: Sheets tabs (needs MCP_GW_LIVE_SHEET_ID)', () => {
  it.todo('duplicate the template sheet into a ZZ probe sheet at the default position (source + 1)');
  it.todo('rename the probe sheet');
  it.todo('reorder the probe sheet forward and backward, checking the actual index');
  it.todo('insert a column after the last date column inheriting from before: currency and bold header carried over');
  it.todo('template sheet grid data and merges are byte-identical before and after');
});
