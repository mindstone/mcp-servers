# npm Publish Pipeline — Zendesk MCP Connector

**Date**: 2026-04-08
**Status**: Planning
**Confidence**: 92%
**Complexity**: Medium-High

## Task Description

Get the Zendesk MCP connector live on npm under `@mindstone-engineering/mcp-server-zendesk` with:
1. Package rename from `@harryjbloom18/mcp-server-zendesk`
2. FSL-1.1-MIT licence (replacing placeholder)
3. Full mock test harness (becomes template for future connectors)
4. CI pipeline (PR build + tag publish)
5. CONTRIBUTING.md
6. First npm publish

## Research Notes

### Files Examined

| File | Key Observations |
|------|-----------------|
| `package.json` | Currently `@harryjbloom18/mcp-server-zendesk@0.2.0`, MIT licence field, `"type": "module"`, bin at `dist/index.js`, `"files": ["dist"]`, deps: `@modelcontextprotocol/sdk@^1.26.0`, `zod@^3.23.0` |
| `tsconfig.json` | `ES2022` target, `NodeNext` module/resolution, `declaration: true`, `sourceMap: true`, `outDir: ./dist`, `rootDir: ./src` |
| `LICENSE` | Placeholder text: "License type to be determined" |
| `src/index.ts` | Entry point: `#!/usr/bin/env node`, imports `StdioServerTransport` + `createServer`, runs `server.connect(transport)` |
| `src/server.ts` | `createServer()` returns `McpServer`, registers 6 tool domains. Hardcoded `version: '0.2.0'` |
| `src/auth.ts` | **Import-time side effects**: `CONFIG_PATH` and `BRIDGE_STATE_PATH` computed at module scope from `process.env`. `loadAccounts()` called at module end. Module-level mutable state: `accountsConfig`, `accounts` Map |
| `src/client.ts` | `zendeskFetch<T>()` — all HTTP via global `fetch`. 429 retry with jitter (max 2 retries, GET only). `AbortSignal.timeout(30s)`. `fetchAllTicketComments()` for pagination |
| `src/bridge.ts` | `bridgeRequest()` — HTTP POST to `127.0.0.1:${port}` with bearer token. Reads bridge state from file |
| `src/utils.ts` | `resolveTempOutputPath()` — enforces `os.tmpdir()` prefix. `withErrorHandling()` — tool wrapper producing `CallToolResult` |
| `src/types.ts` | All interfaces/types + `ZendeskError` class + `assertValidSubdomain()` + constants |
| `src/formatters.ts` | Pure formatting functions for tickets, users, groups, fields, macros |
| `src/tools/*.ts` | 6 domain files registering 20 tools total via `server.registerTool()` with Zod schemas |
| `.gitignore` | `node_modules/`, `build/`, `dist/`, `*.tgz`, `.DS_Store` |

### SDK Test Infrastructure

The `@modelcontextprotocol/sdk` (v1.26.0 installed) includes:
- **`InMemoryTransport`** at `@modelcontextprotocol/sdk/inMemory.js` — `createLinkedPair()` returns `[clientTransport, serverTransport]`
- **`Client`** at `@modelcontextprotocol/sdk/client` — full MCP client for JSON-RPC tool calls
- This allows calling tools via the real MCP JSON-RPC protocol in-process, no network needed

### Module Isolation Challenge (auth.ts)

`auth.ts` has these import-time side effects:
1. `CONFIG_PATH = process.env.ZENDESK_CONFIG_PATH || path.join(os.homedir(), '.mcp', 'zendesk')` — computed at import
2. `BRIDGE_STATE_PATH = process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE` — computed at import
3. `loadAccounts()` — called at module end, reads filesystem

**Strategy**: Use `vi.stubEnv()` to set env vars _before_ dynamic `import()`, plus `vi.resetModules()` between tests. Each test suite gets a fresh temp config dir via `ZENDESK_CONFIG_PATH`.

### HTTP Mocking Strategy

Two HTTP surfaces to mock:
1. **Zendesk API** (`https://{subdomain}.zendesk.com/api/v2/*`) — all via global `fetch`
2. **Bridge** (`http://127.0.0.1:{port}/*`) — also via global `fetch`

**Options evaluated**:
- **`msw` (Mock Service Worker)**: Industry standard, intercepts `fetch` at network level. Excellent for HTTP mocking, supports request matching, response sequences, error simulation. Well-maintained, 15M+ weekly npm downloads.
- **`vi.spyOn(globalThis, 'fetch')`**: Simple, zero-dep. But harder to match URLs precisely, no middleware-style chaining, no request inspection.
- **Custom fetch interceptor**: Maximum control but reinvents msw poorly.

**Decision: `msw@2.x`** — Best match for this use case. Provides `setupServer()` for Node.js, precise URL pattern matching, built-in support for sequences (useful for 429 retry testing), clean per-test isolation via `server.resetHandlers()`. Already used across the MCP ecosystem and will serve as template for future connectors.

### CI Pipeline Design

The repo is at `nspr-io/mcp-servers` on GitHub. No existing `.github/` directory.

Two workflows needed:
1. **PR Check** (`ci.yml`): On push/PR → install, build, lint, test. Runs for all connectors.
2. **Publish** (`publish.yml`): On tag push (`zendesk-v*`) → build, test, publish to npm. Uses `NPM_TOKEN` secret.

### FSL-1.1-MIT Licence

The FSL-1.1-MIT is a source-available licence from Sentry that converts to MIT after 2 years. SPDX identifier: `FSL-1.1-MIT`. The template requires:
- Licensor name (Mindstone Engineering)
- Software name (Zendesk MCP Server)
- Change date (2 years from first publish date: 2028-04-08)
- A "Use Limitation" clause (typically: competing SaaS products)

`package.json` `"license"` field should be `"FSL-1.1-MIT"`.

## Key Decisions & Principles

1. **Test via MCP protocol, not direct function calls** — Use `Client` + `InMemoryTransport` from the SDK. This tests the full JSON-RPC round-trip (serialisation, schema validation, error handling). Higher realism, catches protocol bugs.
2. **`msw` for HTTP mocking** — Intercepts both Zendesk API and bridge requests at the fetch level. Allows precise response control for 429, 401, pagination, error scenarios.
3. **Temp dirs for all file I/O** — Every test suite creates a fresh temp dir for `ZENDESK_CONFIG_PATH`. Cleaned up in `afterAll`.
4. **Vitest** — Matches Rebel ecosystem conventions. ESM-native, fast, good mocking.
5. **Tag-based publishing** — `zendesk-v*` tags trigger npm publish. PRs only run build+test.
6. **Template pattern** — Test harness structure (helpers, fixtures, patterns) designed to be copied verbatim for future connectors.

## Staged Breakdown

### Stage 1: Package Identity & Licence

**Goal**: Rename package, update licence, ensure `npm pack` produces correct artefact.

**Files changed** (3):
- `connectors/zendesk/package.json` — rename to `@mindstone-engineering/mcp-server-zendesk`, update `"license": "FSL-1.1-MIT"`, add `"repository"` and `"homepage"` fields, sync version in bin name
- `connectors/zendesk/LICENSE` — replace placeholder with full FSL-1.1-MIT text
- `connectors/zendesk/README.md` — update package name references, npx command

**Also update**:
- `connectors/zendesk/src/server.ts` — ensure `name` field matches new package name (currently `zendesk-mcp-server`, which is fine — this is the MCP server name, not the npm package name; leave as-is)

**Verification**:
- `npm pack --dry-run` shows correct package name and included files
- `"license"` field matches SPDX identifier
- LICENSE file contains complete FSL-1.1-MIT text with correct Licensor/Change Date

**Rationale**: Must be correct before first publish. Non-reversible once on npm (unpublish is time-limited).

---

### Stage 2: Test Infrastructure Foundation

**Goal**: Set up vitest, msw, test helpers, and fixture data. No actual test files yet — just the skeleton.

**Files created** (6-8):
- `connectors/zendesk/vitest.config.ts` — vitest config with ESM, test globals, coverage settings
- `connectors/zendesk/src/__tests__/helpers/setup.ts` — global test setup (msw server start/stop, env stubs)
- `connectors/zendesk/src/__tests__/helpers/mcp-test-client.ts` — reusable helper: creates `McpServer` via `createServer()`, connects `Client` + `InMemoryTransport`, provides `callTool(name, args)` convenience method
- `connectors/zendesk/src/__tests__/helpers/zendesk-mock-server.ts` — msw request handlers factory: `createZendeskHandlers(subdomain, options)` returning `HttpHandler[]` for all Zendesk API endpoints
- `connectors/zendesk/src/__tests__/helpers/bridge-mock.ts` — msw handlers for bridge HTTP requests
- `connectors/zendesk/src/__tests__/helpers/temp-config.ts` — creates temp dir with `accounts.json` and optional credential files; returns cleanup function
- `connectors/zendesk/src/__tests__/fixtures/zendesk-data.ts` — factory functions: `makeTicket()`, `makeUser()`, `makeGroup()`, `makeComment()`, `makeMacro()`, etc. with sensible defaults + overrides
- `connectors/zendesk/src/__tests__/fixtures/accounts.ts` — test account configs (API token + OAuth variants)

**Dependencies added** (devDependencies):
- `vitest` — test runner
- `msw` — HTTP mocking
- `@vitest/coverage-v8` — coverage reporting

**package.json script additions**:
- `"test": "vitest run"`
- `"test:watch": "vitest"`
- `"test:coverage": "vitest run --coverage"`

**MCP Test Client Design**:
```typescript
// src/__tests__/helpers/mcp-test-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';

export interface McpTestClient {
  client: Client;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

export async function createTestClient(): Promise<McpTestClient> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
```

**Zendesk Mock Server Design**:
```typescript
// src/__tests__/helpers/zendesk-mock-server.ts
import { http, HttpResponse } from 'msw';

export function createZendeskHandlers(subdomain: string, options?: MockOptions): HttpHandler[] {
  const base = `https://${subdomain}.zendesk.com/api/v2`;
  return [
    // Search
    http.get(`${base}/search.json`, ({ request }) => { /* return mock results */ }),
    http.get(`${base}/search/export.json`, ({ request }) => { /* cursor pagination */ }),
    // Tickets
    http.get(`${base}/tickets/:id`, ({ params }) => { /* single ticket */ }),
    http.get(`${base}/tickets/show_many.json`, ({ request }) => { /* batch */ }),
    http.post(`${base}/tickets.json`, async ({ request }) => { /* create */ }),
    http.put(`${base}/tickets/:id`, async ({ request }) => { /* update */ }),
    // Comments, Users, Discovery, Macros — similar pattern
    // ...
  ];
}
```

**Module Isolation Strategy for auth.ts**:
```typescript
// In test setup:
// 1. Set env vars BEFORE importing anything from the connector
// 2. Use vi.resetModules() between test suites that need different env
// 3. Use dynamic import() to get fresh module instances

async function setupTestEnvironment(configDir: string) {
  vi.stubEnv('ZENDESK_CONFIG_PATH', configDir);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');  // disable bridge
  vi.resetModules();
  // Dynamic import gets a fresh module with the new env vars
  const { createServer } = await import('../../server.js');
  return createServer;
}
```

**Verification**:
- `npm test` runs (even with 0 test files — vitest exits cleanly)
- `npx tsc --noEmit` passes (test files compile)
- Helper modules import correctly in ESM context

**Rationale**: Foundation must be solid before writing tests. The helper abstractions (MCP test client, mock factories, temp config) will be reused by all test files and copied to future connectors.

---

### Stage 3: Core Test Suite — Auth, Client, Accounts

**Goal**: Test the auth layer, HTTP client, and account management tools. These are the highest-risk areas (file I/O, import-time side effects, retry logic, token refresh).

**Files created** (3):
- `connectors/zendesk/src/__tests__/auth.test.ts` — tests for:
  - `loadAccounts()` from accounts.json (valid, missing, malformed)
  - `loadAccounts()` from credential files (OAuth tokens)
  - `getAccount()` default resolution
  - `saveToken()` file permissions (0o600)
  - `removeAccount()` cleanup
  - `assertValidSubdomain()` validation (good + evil inputs)
  - Token refresh flow (mocked Zendesk OAuth endpoint)
  - `CONFIG_PATH` respects env var
  - `BRIDGE_STATE_PATH` respects env var and alias

- `connectors/zendesk/src/__tests__/client.test.ts` — tests for:
  - Successful GET/POST/PUT requests
  - 401 → token refresh → retry (OAuth flow)
  - 401 → immediate fail (API token)
  - 429 → retry with Retry-After header (GET only)
  - 429 → no retry for POST/PUT
  - 429 → max retries exhausted
  - 404 → ZendeskError NOT_FOUND
  - 500 → ZendeskError API_ERROR
  - Request timeout (AbortSignal)
  - URL construction with params
  - `fetchAllTicketComments()` pagination + truncation

- `connectors/zendesk/src/__tests__/accounts.test.ts` — MCP protocol-level tests for:
  - `list_zendesk_accounts` — returns configured accounts with status
  - `list_zendesk_accounts` — empty state message
  - `remove_zendesk_account` — removes and persists
  - `authenticate_zendesk_account` — bridge request flow (mocked)
  - `authenticate_zendesk_account` — invalid subdomain rejection

**Approximate test count**: 25-30 tests

**Verification**:
- All tests pass: `npm test`
- Coverage ≥80% for `auth.ts`, `client.ts`
- No real HTTP requests made (msw catches all)
- Temp dirs cleaned up (no leaked files)

**Rationale**: Auth and client are the foundation everything else builds on. Testing retry, refresh, and error handling catches the highest-risk bugs. The 429 retry logic is particularly important — it has jitter and conditional retry behavior.

---

### Stage 4: Tool Domain Tests

**Goal**: Test all 20 tools via MCP protocol. Focuses on request→response mapping, error handling, and edge cases.

**Files created** (5):
- `connectors/zendesk/src/__tests__/tools/tickets.test.ts` — tests for all 6 ticket tools:
  - `search_zendesk_tickets` — basic search, pagination, auto_paginate, empty results
  - `export_zendesk_tickets` — cursor pagination, file output, path restriction enforcement
  - `get_zendesk_ticket` — found, not found, with comments
  - `get_zendesk_tickets_by_ids` — batch fetch, ID limit, with comments
  - `create_zendesk_ticket` — creates and returns
  - `update_zendesk_ticket` — updates fields, adds comment

- `connectors/zendesk/src/__tests__/tools/users.test.ts` — tests for 2 user tools:
  - `search_zendesk_users` — search by name/email, role filter, pagination
  - `get_zendesk_user` — found, not found

- `connectors/zendesk/src/__tests__/tools/comments.test.ts` — tests for 2 comment tools:
  - `list_zendesk_ticket_comments` — with author resolution, pagination
  - `add_zendesk_ticket_comment` — public reply, internal note

- `connectors/zendesk/src/__tests__/tools/discovery.test.ts` — tests for 4 discovery tools:
  - `list_zendesk_groups`, `list_zendesk_ticket_fields`, `list_zendesk_views`, `list_zendesk_organizations` — basic happy path + empty results

- `connectors/zendesk/src/__tests__/tools/macros.test.ts` — tests for 3 macro tools:
  - `list_zendesk_macros` — list, search, pagination
  - `get_zendesk_macro` — found, not found
  - `apply_zendesk_macro` — apply result, preview result

**Approximate test count**: 35-45 tests

**Verification**:
- All tests pass: `npm test`
- Every tool has at least: happy path + error/edge case
- All tests use MCP protocol (via `callTool`), not direct function imports
- Coverage report shows all tool files touched

**Rationale**: Protocol-level tests catch serialisation bugs, schema validation issues, and error wrapping that unit tests of individual functions would miss. Organizing by domain mirrors the source structure and keeps test files manageable.

---

### Stage 5: Security & Edge Case Tests

**Goal**: Dedicated test file for security-critical behaviors that span multiple modules.

**File created** (1):
- `connectors/zendesk/src/__tests__/security.test.ts` — tests for:
  - Subdomain validation: rejects `../etc/passwd`, `foo.bar`, `foo bar`, empty, special chars
  - Path sanitisation: `resolveTempOutputPath()` rejects paths outside tmpdir
  - File permissions: token files written with 0o600, credential dirs with 0o700
  - Config file parsing: handles malformed JSON gracefully (no crash)
  - No credentials in error messages: `ZendeskError` messages don't contain tokens/keys
  - Request timeout: requests abort after `REQUEST_TIMEOUT_MS`
  - Bridge auth: bearer token included in bridge requests

**Approximate test count**: 10-12 tests

**Verification**:
- All tests pass
- Security tests cannot be weakened without explicit approval (marked in test descriptions)

**Rationale**: Security behaviors are specified in the task requirements. Centralised security tests serve as a regression suite and documentation of security properties.

---

### Stage 6: CI Pipeline

**Goal**: GitHub Actions workflows for PR checks and npm publishing.

**Files created** (2):
- `.github/workflows/ci.yml` — PR check workflow:
  ```yaml
  name: CI
  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]
  jobs:
    build-and-test:
      runs-on: ubuntu-latest
      strategy:
        matrix:
          node-version: [18, 20, 22]
      defaults:
        run:
          working-directory: connectors/zendesk
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: ${{ matrix.node-version }} }
        - run: npm ci
        - run: npm run build
        - run: npm test
  ```

- `.github/workflows/publish.yml` — tag-triggered npm publish:
  ```yaml
  name: Publish
  on:
    push:
      tags: ['zendesk-v*']
  jobs:
    publish:
      runs-on: ubuntu-latest
      permissions:
        contents: read
        id-token: write    # npm provenance
      defaults:
        run:
          working-directory: connectors/zendesk
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
            registry-url: https://registry.npmjs.org
        - run: npm ci
        - run: npm run build
        - run: npm test
        - run: npm publish --provenance --access public
          env:
            NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  ```

**Repository secrets needed**:
- `NPM_TOKEN` — npm automation token for `mindstone-engineering` org

**Tag convention**: `zendesk-v0.2.0`, `zendesk-v0.3.0`, etc. Prefixed with `zendesk-` to support multiple connectors in the monorepo.

**Verification**:
- CI YAML validates (use `actionlint` or manual review)
- Dry-run: create a test tag to verify workflow triggers
- `NPM_TOKEN` secret is configured in repo settings

**Rationale**: Tag-based publishing is standard for monorepos with multiple publishable packages. Matrix testing on Node 18/20/22 catches compatibility issues early (connector requires Node ≥18).

---

### Stage 7: CONTRIBUTING.md & Documentation Polish

**Goal**: Create CONTRIBUTING.md, final README polish, ensure everything is publish-ready.

**Files created/updated** (3):
- `connectors/zendesk/CONTRIBUTING.md` — covers:
  - Getting started (clone, install, build)
  - Running tests (`npm test`, `npm run test:watch`, `npm run test:coverage`)
  - Adding new tools (pattern: create tool file, register in server.ts, add tests)
  - Code style (ESM, TypeScript strict, Zod schemas)
  - Submitting PRs (branch naming, test requirements)
  - Release process (tag-based, npm publish)
  - Licence (FSL-1.1-MIT explanation)

- `connectors/zendesk/README.md` — final updates:
  - Badge: CI status, npm version, licence
  - Updated npx command with new package name
  - Link to CONTRIBUTING.md
  - Licence section with FSL-1.1-MIT summary

- `README.md` (repo root) — update package name reference

**Verification**:
- All links in README/CONTRIBUTING resolve
- npx command matches published package name
- Licence badge displays correctly

**Rationale**: CONTRIBUTING.md is required for the task. README badges and polish signal professionalism for the first npm publish.

---

### Stage 8: First Publish Verification

**Goal**: Perform the first npm publish and verify it works end-to-end.

**Steps** (manual + automated):
1. Final pre-flight checks:
   - `npm run build` — clean build
   - `npm test` — all tests pass
   - `npm pack --dry-run` — verify package contents (only `dist/`, `LICENSE`, `README.md`, `package.json`)
   - `npm pack` — create tarball, inspect contents
   - Verify no credentials, test files, or source maps leak into package
2. Publish:
   - `git tag zendesk-v0.2.0`
   - `git push origin zendesk-v0.2.0`
   - CI runs build+test+publish
   - **OR** manual: `npm publish --provenance --access public`
3. Post-publish verification:
   - `npm info @mindstone-engineering/mcp-server-zendesk` — package exists
   - `npx -y @mindstone-engineering/mcp-server-zendesk` — binary starts (expect stdio MCP handshake)
   - Verify licence on npmjs.com page shows FSL-1.1-MIT
   - Test in Claude Desktop / Cursor config with npx command

**Verification**:
- Package is live on npm
- `npx` invocation works
- Licence displays correctly
- No source code leaks (only `dist/`)

**Rationale**: First publish is non-reversible after 72h. Must be verified thoroughly.

## Test File Structure (Final)

```
connectors/zendesk/
├── src/
│   ├── __tests__/
│   │   ├── helpers/
│   │   │   ├── setup.ts              # Global setup (msw, env)
│   │   │   ├── mcp-test-client.ts    # MCP Client + InMemoryTransport wrapper
│   │   │   ├── zendesk-mock-server.ts # msw handlers for Zendesk API
│   │   │   ├── bridge-mock.ts        # msw handlers for bridge HTTP
│   │   │   └── temp-config.ts        # Temp dir management for config files
│   │   ├── fixtures/
│   │   │   ├── zendesk-data.ts       # Factory functions for test data
│   │   │   └── accounts.ts           # Test account configurations
│   │   ├── auth.test.ts              # Auth layer tests
│   │   ├── client.test.ts            # HTTP client tests
│   │   ├── accounts.test.ts          # Account tool tests (MCP protocol)
│   │   ├── security.test.ts          # Security property tests
│   │   └── tools/
│   │       ├── tickets.test.ts       # Ticket tool tests
│   │       ├── users.test.ts         # User tool tests
│   │       ├── comments.test.ts      # Comment tool tests
│   │       ├── discovery.test.ts     # Discovery tool tests
│   │       └── macros.test.ts        # Macro tool tests
│   ├── auth.ts
│   ├── bridge.ts
│   ├── client.ts
│   ├── formatters.ts
│   ├── index.ts
│   ├── server.ts
│   ├── types.ts
│   ├── utils.ts
│   └── tools/
│       ├── index.ts
│       ├── accounts.ts
│       ├── tickets.ts
│       ├── users.ts
│       ├── comments.ts
│       ├── discovery.ts
│       └── macros.ts
├── docs/plans/
│   └── 260408_npm_publish_pipeline.md  # This file
├── vitest.config.ts
├── package.json
├── tsconfig.json
├── LICENSE
├── README.md
└── CONTRIBUTING.md
```

## Failure Mode Matrix

| Failure Mode | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **ESM module isolation fails** — `vi.resetModules()` doesn't fully reset `auth.ts` import-time side effects | Medium | High — tests pollute each other | Use `vi.resetModules()` + dynamic `import()` in a helper function. If that fails, fall back to separate vitest workspace configs per test group with `--pool=forks` and `--poolOptions.forks.singleFork` |
| **msw v2 doesn't intercept Node.js fetch** — msw v2 uses `interceptors` package which may not support all Node.js fetch implementations | Low | High — all HTTP tests fail | msw v2.x supports native Node.js fetch (≥18). Fallback: `undici.MockAgent` as interceptor. Verify in Stage 2 before writing tests |
| **InMemoryTransport doesn't work with McpServer** — `McpServer` vs `Server` class compatibility | Low | High — test client doesn't work | `McpServer` inherits from `Server`; `connect(transport)` is on the `Server` base class. Verified in SDK source. If issues arise, use low-level `Server` class directly |
| **npm publish fails on name conflict** — `@mindstone-engineering/mcp-server-zendesk` already taken | Very Low | High — need different name | Check `npm info @mindstone-engineering/mcp-server-zendesk` before starting. Org-scoped packages under own org are always available |
| **`npm pack` includes test files** — vitest config/test files leak into published package | Low | Medium — bloated package, source leak | `"files": ["dist"]` in package.json already restricts this. Verify with `npm pack --dry-run`. Add `.npmignore` if needed |
| **CI workflow doesn't trigger** — tag pattern mismatch or permissions issue | Low | Medium — manual publish needed | Test with a `zendesk-v0.0.0-test.1` pre-release tag first. Verify workflow YAML syntax |
| **429 retry tests are flaky** — timing-dependent retry logic with jitter | Medium | Low — flaky tests | Use `vi.useFakeTimers()` to control `setTimeout`. Mock `Math.random()` for deterministic jitter. Use msw `delay()` for controlled timing |
| **Bridge tests fail without bridge running** — `bridgeRequest` tries real HTTP | Low | Low — tests crash | msw intercepts `http://127.0.0.1:*` requests. Alternatively, mock `BRIDGE_STATE_PATH` to non-existent file so `loadBridgeState()` returns null |
| **FSL-1.1-MIT licence rejected by npm** — npm doesn't recognise SPDX identifier | Very Low | Medium — publish blocked | FSL-1.1-MIT is a registered SPDX identifier since 2024. npm supports custom SPDX expressions. Fallback: use `"license": "SEE LICENSE IN LICENSE"` |
| **`createServer()` re-import creates duplicate tool registrations** — multiple imports register tools multiple times | Low | Medium — tests fail with duplicate tool errors | `createServer()` creates a _new_ `McpServer` each time — no global registration. Each test gets a fresh server. Verified in server.ts source |

## Assumptions

1. npm org `mindstone-engineering` exists and `NPM_TOKEN` is available as a repo secret
2. GitHub repo `nspr-io/mcp-servers` has Actions enabled
3. FSL-1.1-MIT is acceptable with Change Date of 2028-04-08 (2 years from first publish)
4. No existing `@mindstone-engineering/mcp-server-zendesk` package on npm
5. The connector's `@modelcontextprotocol/sdk@^1.26.0` dependency is compatible with InMemoryTransport and Client (verified — both exist in installed version)
6. `vitest` can handle ESM with `NodeNext` module resolution without special transforms

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| **Jest instead of Vitest** | Jest's ESM support is still experimental and requires `--experimental-vm-modules`. Vitest is ESM-native and matches Rebel ecosystem |
| **Direct function testing instead of MCP protocol** | Misses serialisation bugs, schema validation, error wrapping. Protocol-level tests catch more real-world issues |
| **`vi.spyOn(globalThis, 'fetch')` instead of msw** | Harder to match URL patterns, no middleware chaining, no built-in sequence support. msw is the industry standard for a reason |
| **Separate test runner process (spawn + stdio)** | Maximum realism but extremely slow, hard to debug, flaky. InMemoryTransport gives protocol-level realism at unit-test speed |
| **npm workspace (monorepo tooling)** | Overkill for 1-2 packages. Each connector is independent with its own deps. Can add workspaces later when there are 3+ connectors |
| **Changesets for versioning** | Overkill for initial setup. Manual tag-based publishing is simpler. Can add changesets when the team grows |

## Dependencies Summary

**New devDependencies** (Stage 2):
- `vitest@^3.x` — test runner
- `@vitest/coverage-v8@^3.x` — coverage
- `msw@^2.x` — HTTP mocking

**No new production dependencies.**

## Estimated Effort

| Stage | Estimated Effort |
|---|---|
| Stage 1: Package Identity & Licence | ~30 min |
| Stage 2: Test Infrastructure Foundation | ~2-3 hours |
| Stage 3: Core Tests (Auth, Client, Accounts) | ~2-3 hours |
| Stage 4: Tool Domain Tests | ~3-4 hours |
| Stage 5: Security & Edge Case Tests | ~1 hour |
| Stage 6: CI Pipeline | ~1 hour |
| Stage 7: CONTRIBUTING.md & Docs | ~30 min |
| Stage 8: First Publish | ~30 min |
| **Total** | **~10-14 hours** |

## Review Refinements (Phase 3 — Septuple Review + 4 Lenses)

All 7 reviewers returned REQUEST_CHANGES. Core architecture validated (MCP protocol testing, msw, vitest, tag publish). The following refinements are incorporated:

### CRITICAL Fixes Applied

1. **Test files moved to `test/` (outside `src/`)** — Prevents tests compiling into `dist/` and shipping in npm tarball. Requires `tsconfig.json` `rootDir` to stay as `./src` (production only). Vitest config points to `test/` directory.

2. **No static imports from connector source in test helpers** — `mcp-test-client.ts` must use dynamic `import()` after `vi.stubEnv()` + `vi.resetModules()`. This is the only safe pattern for auth.ts import-time side effects.

### HIGH Fixes Applied

3. **Stdio smoke test added to Stage 4** — One test spawns `node dist/index.js`, sends MCP `initialize` JSON-RPC over stdin, verifies valid response. Catches broken shebangs, startup crashes, stdout noise.

4. **MSW handler URL patterns corrected** — Must match actual Zendesk `.json`-suffixed paths (e.g., `/tickets/:id.json`, `/search.json`). OAuth endpoint at `/oauth/tokens` (outside `/api/v2`).

5. **Version sync guard** — Add script/CI check: `package.json` version == `src/server.ts` version == tag version. Stage 1 includes syncing the hardcoded version.

6. **`resolveTempOutputPath()` security fix** — Use `path.relative(tmpdir, resolved)` and reject if result starts with `..`. Tests added for `/tmp-evil/` bypass and symlink escape.

7. **Source maps excluded from package** — Add `"files": ["dist", "!dist/**/*.map"]` or disable source maps in production build. Verify with `npm pack --json`.

8. **`publishConfig.access: "public"` added** — Required for scoped packages.

9. **`repository.directory: "connectors/zendesk"` added** — Required for monorepo npm packages.

### MEDIUM Fixes Applied

10. **CI lint step added** — Add `eslint` as devDep (or `biome`), add lint script, include in CI.
11. **Tag-to-version check in publish workflow** — CI step extracts version from tag, compares to `package.json`.
12. **FSL-1.1-MIT Change Date** — Derives from actual first publish date, not plan date.
13. **Downstream Rebel catalog** — Explicitly deferred. Will be updated after first successful npm publish (separate PR to Rebel monorepo).

### Test File Structure (Revised)

```
connectors/zendesk/
├── src/                         # Production source (compiles to dist/)
│   ├── auth.ts
│   ├── bridge.ts
│   ├── client.ts
│   ├── formatters.ts
│   ├── index.ts
│   ├── server.ts
│   ├── types.ts
│   ├── utils.ts
│   └── tools/
│       ├── accounts.ts
│       ├── tickets.ts
│       ├── users.ts
│       ├── comments.ts
│       ├── discovery.ts
│       └── macros.ts
├── test/                        # Tests (NOT compiled, NOT shipped)
│   ├── helpers/
│   │   ├── setup.ts
│   │   ├── mcp-test-client.ts   # Dynamic imports only!
│   │   ├── zendesk-mock-server.ts
│   │   ├── bridge-mock.ts
│   │   └── temp-config.ts
│   ├── fixtures/
│   │   ├── zendesk-data.ts
│   │   └── accounts.ts
│   ├── auth.test.ts
│   ├── client.test.ts
│   ├── accounts.test.ts
│   ├── security.test.ts
│   ├── smoke.test.ts            # Stdio spawn smoke test
│   └── tools/
│       ├── tickets.test.ts
│       ├── users.test.ts
│       ├── comments.test.ts
│       ├── discovery.test.ts
│       └── macros.test.ts
├── vitest.config.ts
├── package.json
├── tsconfig.json
├── LICENSE
├── README.md
└── CONTRIBUTING.md
```

### Additional Failure Modes (from reviews)

| Failure Mode | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **`/tmp-evil/` prefix bypass in `resolveTempOutputPath()`** | Medium | High — arbitrary file write | Fix with `path.relative()` check; add test |
| **Source maps shipped in npm package** | Medium | Medium — source leak | Exclude `.map` files from `files` field |
| **Version drift between package.json/server.ts/tag** | Medium | Medium — confusing releases | CI version-sync check |
| **Scoped package defaults to restricted** | Low | High — publish silently fails | Add `publishConfig.access: "public"` |

## Implementation Log

### Stage 1: Package Identity & Licence — Completed 2026-04-08

**Files changed (5):**
- `connectors/zendesk/package.json` — Renamed from `@harryjbloom18/mcp-server-zendesk` to `@mindstone-engineering/mcp-server-zendesk`. Updated licence to `FSL-1.1-MIT`. Added `publishConfig.access: "public"`, `repository` (with `directory`), `homepage`. Updated `files` to `["dist", "!dist/**/*.map"]` to exclude source maps. Version kept at `0.2.0`.
- `connectors/zendesk/LICENSE` — Replaced placeholder with full FSL-1.1-MIT text. Licensor: Mindstone Engineering. Software: Zendesk MCP Server. Change Date: 2030-04-08 (4 years from first publish). Change License: MIT.
- `connectors/zendesk/README.md` — Updated all package name references from `@harryjbloom18/...` to `@mindstone-engineering/...`. Added npm version badge and FSL-1.1-MIT licence badge (shields.io). Added licence section at bottom. Updated npx command.
- `connectors/zendesk/src/utils.ts` — Fixed `resolveTempOutputPath()` security issue: replaced `startsWith(tmpdir)` check with `path.relative()` + reject-if-starts-with-`..`-or-is-absolute. Prevents `/tmp-evil/` prefix bypass.
- `connectors/zendesk/src/server.ts` — No change needed; `version: '0.2.0'` already matches `package.json`.

**Repo root README** (`README.md`): No change needed — already referenced `@mindstone-engineering/mcp-server-zendesk`.

**Verification:**
- `npm run build` — succeeded (exit code 0)
- `npm pack --dry-run` — correct package name `@mindstone-engineering/mcp-server-zendesk@0.2.0`, 33 files, no `.map` files in tarball, LICENSE and README included

**Deviations from plan:** None. FSL-1.1-MIT Change Date set to 2030-04-08 (4 years from first publish per task instructions, not 2 years as originally in plan research notes).

### Stages 3-5: Test Suites (Auth, Client, Tools, Security) — Completed 2026-04-08

**Files created (9):**
- `test/auth.test.ts` — 12 tests: loadAccounts (valid, missing, malformed JSON, missing array), OAuth credential loading, getAccount resolution (explicit/default/undefined), CONFIG_PATH env var, token file permissions (0o600), credentials dir permissions (0o700), removeAccount with persistence
- `test/client.test.ts` — 10 tests: successful GET/POST, 401→AUTH_FAILED, 404→NOT_FOUND, 500→API_ERROR, 429 GET retry with Retry-After, 429 POST no-retry, query param construction, fetchAllTicketComments pagination, fetchAllTicketComments truncation
- `test/accounts.test.ts` — 4 tests (4 describe blocks): list_zendesk_accounts (configured), list_zendesk_accounts (empty), remove_zendesk_account, authenticate_zendesk_account (bridge mock)
- `test/tools/tickets.test.ts` — 8 tests: search (results + empty), get_zendesk_ticket (basic + with comments), create, update, export (in-context), get_by_ids (batch)
- `test/tools/users.test.ts` — 2 tests: search_zendesk_users, get_zendesk_user
- `test/tools/comments.test.ts` — 2 tests: list_zendesk_ticket_comments, add_zendesk_ticket_comment (with body capture verification)
- `test/tools/discovery.test.ts` — 4 tests: list_zendesk_groups, list_zendesk_ticket_fields, list_zendesk_views, list_zendesk_organizations
- `test/tools/macros.test.ts` — 3 tests: list_zendesk_macros, get_zendesk_macro, apply_zendesk_macro
- `test/security.test.ts` — 14 tests: assertValidSubdomain (valid, path traversal, dots, spaces, empty, special chars, hyphen edge cases), resolveTempOutputPath (valid, outside tmpdir, /tmp-evil bypass, ../ traversal), ZendeskError credential safety

**Total test count: 59 tests across 10 files** (including pre-existing smoke.test.ts with 1 test).

**Verification:**
- `npm test` — all 59 tests pass, duration ~388ms
- No source files modified
- No existing test helpers or fixtures modified

**Discoveries:**
1. MSW `afterEach → resetHandlers()` in setup.ts clears all runtime handlers. Tool test suites must re-register handlers in `beforeEach`, not just `beforeAll`.
2. The `:ticketId.json` wildcard handler in zendesk-mock-server.ts matches `show_many.json` — MSW uses path-to-regexp which treats `:ticketId` as a wildcard. Tests that use `show_many` need a per-test handler override prepended via `mswServer.use()`.
3. The shared `/search.json` mock endpoint returns ticket data by default. User search tests need per-test handler overrides that return user-shaped data.
4. Auth tests use `vi.stubEnv()` + `vi.resetModules()` + dynamic `import()` pattern successfully — module-level side effects in auth.ts are correctly re-evaluated with fresh env vars.
