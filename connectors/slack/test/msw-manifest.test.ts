/**
 * MSW request-manifest test — closes the retell-ai 0.1.2 class of bug where
 * MSW handlers and production HTTP call sites silently drift, causing tests
 * to pass against stale mocks while production is actually broken.
 *
 * Strategy:
 *   1. Walk every `.ts` file under `src/` and find production usages of
 *      `client.<group>.<method>(` and `userClient.<group>.<method>(` —
 *      e.g., `client.chat.postMessage({...})`. The `@slack/web-api`
 *      WebClient builds the URL dynamically from the method name, so
 *      capturing literal URLs is not enough — we have to walk the call
 *      sites instead.
 *   2. Map each call-site pair to its Slack API URL
 *      (`group.method` → `https://slack.com/api/group.method`).
 *   3. Capture every `https://slack.com/api/...` literal too (catches the
 *      single oauth.v2.access raw fetch in tokenProvider.ts).
 *   4. Compare the union to the MSW manifest in
 *      `SLACK_PRODUCTION_API_URLS`. The test FAILS in either direction:
 *        - production uses a method without an MSW handler → tests would
 *          pass against missing mocks (silent drift).
 *        - manifest declares a URL not used by production → dead handler,
 *          symptom of stale code paths or accidental orphans.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLACK_API_BASE, SLACK_PRODUCTION_API_URLS } from './fixtures/slack-mock-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src');

// `<client>.<group>.<method>(` — captures e.g.
//   client.chat.postMessage(
//   userClient.conversations.history(
//   reader.users.info(
//   verifyClient.conversations.info(
//   botClient.users.info(
//   userClient.search.messages(
const CLIENT_CALL_PATTERN =
  /\b(?:client|userClient|botClient|reader|userClientNoNull|verifyClient|tokenProvider|tp)\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g;

// Slack URLs sometimes appear as raw literals (e.g. oauth.v2.access). Catch them too.
const RAW_URL_PATTERN = /https:\/\/slack\.com\/api\/([a-zA-Z0-9._]+)/g;

// Slack groups that are part of @slack/web-api but NOT inferred from client.x.y(...)
// because they are paginate(...) usages where the group/method are passed as
// a string. Add them here when we adopt them.
const PAGINATE_PATTERN = /\bpaginate\(\s*['"`]([a-zA-Z]+)\.([a-zA-Z]+)['"`]/g;

// Untyped WebClient calls — `apiCall('group.method', ...)` (used for methods
// with no typed SDK wrapper, e.g. assistant.search.context). The full dotted
// method name maps straight onto the URL path.
const API_CALL_PATTERN = /\.apiCall\(\s*['"`]([a-zA-Z0-9.]+)['"`]/g;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function urlFor(group: string, method: string): string {
  return `${SLACK_API_BASE}/${group}.${method}`;
}

function collectProductionUrls(): Set<string> {
  const files = walk(SRC_DIR);
  const found = new Set<string>();

  // Slack WebClient method groups we expect to see. Anything else is
  // probably an unrelated client (e.g., test-fetch adapter helpers, MCP
  // server methods like server.registerTool) — filter aggressively to
  // avoid false positives.
  const SLACK_GROUPS = new Set([
    'assistant',
    'auth',
    'bookmarks',
    'chat',
    'conversations',
    'emoji',
    'files',
    'pins',
    'reactions',
    'reminders',
    'search',
    'users',
  ]);

  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf-8');

    // 1. Capture client.<group>.<method>(...) call sites.
    for (const m of contents.matchAll(CLIENT_CALL_PATTERN)) {
      const [, group, method] = m;
      if (!SLACK_GROUPS.has(group)) continue;
      // `users.lookupByEmail` is a single method, but our generated URL
      // builder is correct: `users.lookupByEmail` → /users.lookupByEmail.
      found.add(urlFor(group, method));
    }

    // 2. Capture client.paginate('group.method', ...) usages.
    for (const m of contents.matchAll(PAGINATE_PATTERN)) {
      const [, group, method] = m;
      if (!SLACK_GROUPS.has(group)) continue;
      found.add(urlFor(group, method));
    }

    // 3. Capture apiCall('group.method', ...) usages (full dotted method).
    for (const m of contents.matchAll(API_CALL_PATTERN)) {
      const method = m[1];
      const group = method.split('.')[0];
      if (!SLACK_GROUPS.has(group)) continue;
      found.add(`${SLACK_API_BASE}/${method}`);
    }

    // 4. Capture raw URL literals (oauth.v2.access in tokenProvider).
    for (const m of contents.matchAll(RAW_URL_PATTERN)) {
      found.add(`${SLACK_API_BASE}/${m[1]}`);
    }
  }
  return found;
}

describe('MSW handler / production URL parity', () => {
  it('every Slack WebClient method used in src/ has a matching MSW handler', () => {
    const productionUrls = collectProductionUrls();
    const manifestSet = new Set(SLACK_PRODUCTION_API_URLS);
    const missingFromManifest = [...productionUrls]
      .filter((u) => !manifestSet.has(u))
      .sort();
    expect(
      missingFromManifest,
      `Production code uses Slack methods with no MSW handler:\n` +
        missingFromManifest.map((u) => `  - ${u}`).join('\n') +
        `\n\nAdd handlers in test/fixtures/slack-mock-api.ts AND add the URLs to ` +
        `SLACK_PRODUCTION_API_URLS, or remove the unused production call.`,
    ).toEqual([]);
  });

  it('every MSW handler URL is referenced by production code (no dead handlers)', () => {
    const productionUrls = collectProductionUrls();
    const deadHandlers = SLACK_PRODUCTION_API_URLS.filter((u) => !productionUrls.has(u)).sort();
    expect(
      deadHandlers,
      `MSW manifest declares URLs no longer used by production:\n` +
        deadHandlers.map((u) => `  - ${u}`).join('\n') +
        `\n\nRemove the dead entry from SLACK_PRODUCTION_API_URLS / its handler ` +
        `in test/fixtures/slack-mock-api.ts, or restore the production call site.`,
    ).toEqual([]);
  });
});
