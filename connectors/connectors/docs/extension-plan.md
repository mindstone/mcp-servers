---
title: "Extension Plan: humaans_hello_world tool"
created: 2026-04-15
status: ready-for-implementation
confidence: 98%
---

# Extension Plan: `humaans_hello_world` Tool

## User Intent

Add a single `humaans_hello_world` tool to the Humaans MCP connector as a learning/demonstration exercise for the extend-mcp-server workflow.

- **Tool name:** `humaans_hello_world`
- **Auth required:** None — must work without `HUMAANS_API_KEY` configured
- **Return value:** A greeting string (JSON `{ ok: true, message: "Hello from Humaans MCP!" }`)
- **Out of scope:** Any Humaans API calls, any auth logic
- **Success criteria:** Tool appears in tool list, returns greeting, existing 11 tools still pass, `npm run build && npm test` succeeds

---

## Current State

| Item | Detail |
|---|---|
| Connector path | `connectors/humaans/` |
| Build system | TypeScript → `dist/`, via `tsc` (`npm run build`) |
| Module format | ESM (`"type": "module"`, `NodeNext` resolution) |
| Test framework | Vitest (`npm test` = `vitest run`) |
| Registered tools | 11 tools across 5 `register*Tools` functions |
| Smoke test | `test/smoke.test.ts` asserts exactly 11 tools by name |

---

## Source Inventory

### Files to create
| File | Purpose |
|---|---|
| `src/tools/hello.ts` | New tool file — `registerHelloTools(server)` |
| `test/hello.test.ts` | Dedicated test for the hello world tool |

### Files to modify
| File | Change |
|---|---|
| `src/tools/index.ts` | Add `export { registerHelloTools } from './hello.js'` |
| `src/server.ts` | Import + call `registerHelloTools(server)` |
| `test/smoke.test.ts` | Count 11→12; add `'humaans_hello_world'` to sorted name list |

### Files read (unchanged)
- `src/utils.ts` — `withErrorHandling` wrapper (used as-is)
- `src/tools/configure.ts` — registration pattern reference
- `test/company.test.ts` — test pattern reference
- `test/helpers/mcp-test-client.ts` — `createTestClient` API reference
- `package.json` — build/test scripts confirmed
- `tsconfig.json` — `NodeNext` module resolution (`.js` imports required)

---

## Approach (Staged)

### Stage 1 — Implementation (3 file changes + 1 new file)

#### 1a. Create `src/tools/hello.ts`

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withErrorHandling } from '../utils.js';

export function registerHelloTools(server: McpServer): void {
  server.registerTool(
    'humaans_hello_world',
    {
      description:
        'Returns a hello world greeting. No authentication required. ' +
        'Use this to verify the Humaans MCP connector is installed and responding correctly.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async () => {
      return JSON.stringify({ ok: true, message: 'Hello from Humaans MCP!' });
    }),
  );
}
```

Key decisions:
- Uses `withErrorHandling` — consistent with all other tools, even though no errors are expected
- `inputSchema: z.object({})` — no inputs, same pattern as `get_humaans_me`
- `annotations: { readOnlyHint: true }` — read-only, no side effects
- No import of `auth.ts`, `client.ts`, or `types.ts` — auth-free by design
- Handler ignores `args` entirely (typed as `Record<string, never>` via empty z.object)

#### 1b. Update `src/tools/index.ts`

Add one export line (insert after existing exports, maintaining alphabetical order by module name):

```ts
export { registerHelloTools } from './hello.js';
```

Insertion point: after `export { registerCompanyTools }`, before `export { registerTimeAwayTools }` — or simply append. Alphabetical: `configure`, `company`, `hello`, `job-roles`, `people`, `time-away`. Insert after `company.js`.

#### 1c. Update `src/server.ts`

Two changes:
1. Add `registerHelloTools` to the named import from `'./tools/index.js'`
2. Call `registerHelloTools(server)` — insert after `registerCompanyTools(server)` for locality

```ts
import {
  registerConfigureTools,
  registerPeopleTools,
  registerJobRoleTools,
  registerCompanyTools,
  registerHelloTools,      // ← add
  registerTimeAwayTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'humaans-mcp-server', version: '0.1.0' });

  registerConfigureTools(server);
  registerPeopleTools(server);
  registerJobRoleTools(server);
  registerCompanyTools(server);
  registerHelloTools(server);   // ← add
  registerTimeAwayTools(server);

  return server;
}
```

---

### Stage 2 — Tests (1 file update + 1 new file)

#### 2a. Update `test/smoke.test.ts`

Two targeted changes:
1. `toHaveLength(11)` → `toHaveLength(12)`
2. Insert `'humaans_hello_world'` into the sorted name array — it sorts between `'get_humaans_person'` and `'list_humaans_job_roles'`

Sorted position verification:
```
get_humaans_me
get_humaans_person
humaans_hello_world       ← 'h' < 'l', so after all 'get_' entries, before 'list_'
list_humaans_job_roles
...
```

Updated array:
```ts
expect(toolNames).toEqual([
  'configure_humaans_api_key',
  'create_humaans_time_away',
  'get_humaans_company',
  'get_humaans_job_role',
  'get_humaans_me',
  'get_humaans_person',
  'humaans_hello_world',          // ← insert here
  'list_humaans_job_roles',
  'list_humaans_locations',
  'list_humaans_people',
  'list_humaans_time_away',
  'list_humaans_time_away_types',
]);
```

#### 2b. Create `test/hello.test.ts`

Pattern mirrors `test/company.test.ts`. Key difference: no MSW handlers needed (no HTTP calls), and no `HUMAANS_API_KEY` in env (validating auth-free behaviour).

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Humaans hello world tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup() {
    // No API key — hello world must work without auth
    testClient = await createTestClient({
      env: {
        HUMAANS_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('returns a greeting without requiring authentication', async () => {
    await setup();
    const result = await testClient.callTool('humaans_hello_world', {});
    const json = result.json as { ok: boolean; message: string };

    expect(result.isError).toBeFalsy();
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Hello from Humaans MCP!');
  });

  it('appears in the tool list', async () => {
    await setup();
    const toolsResult = await testClient.client.listTools();
    const names = toolsResult.tools.map((t) => t.name);
    expect(names).toContain('humaans_hello_world');
  });
});
```

Notes:
- No `mswServer.use(...)` — no network calls to intercept
- `HUMAANS_API_KEY: ''` explicitly validates auth-free requirement (matches smoke test pattern)
- Two tests: behaviour (greeting content) + registration (visible in list)

---

## Assumptions

| # | Assumption | Risk if wrong |
|---|---|---|
| 1 | `withErrorHandling` return type satisfies `server.registerTool`'s handler signature | Low — verified by reading SDK types used in all existing tools |
| 2 | Empty `z.object({})` inputSchema compiles cleanly with strict TS | Low — identical usage in `get_humaans_me` (people.ts) |
| 3 | `'humaans_hello_world'` sorts between `'get_humaans_person'` and `'list_humaans_job_roles'` | Very low — JS string sort confirmed: `'h' < 'l'`, `'humaans' > 'get_'` |
| 4 | `createTestClient` with empty `HUMAANS_API_KEY` still boots the server (auth checked at tool-call time, not server init) | Low — `configure.ts` + `auth.ts` pattern suggests auth is checked lazily per-call |
| 5 | No imports from `auth.ts` means no auth side-effects at module load | Confirmed by design — hello.ts will import only `utils.ts` and SDK types |

---

## Deliverables

| # | Deliverable | Stage |
|---|---|---|
| 1 | `src/tools/hello.ts` | 1 |
| 2 | `src/tools/index.ts` (updated) | 1 |
| 3 | `src/server.ts` (updated) | 1 |
| 4 | `test/smoke.test.ts` (updated) | 2 |
| 5 | `test/hello.test.ts` | 2 |

**Build gate:** `npm run build` must exit 0 before Stage 2 begins.
**Test gate:** `npm test` must report 0 failures at completion.

---

## Activity Log

| Date | Agent | Action |
|---|---|---|
| 2026-04-15 | Planner (knowledge-worker) | Read package.json, tsconfig.json, utils.ts, smoke.test.ts, company.test.ts, tools/index.ts, server.ts, configure.ts, test/helpers/mcp-test-client.ts. Wrote extension-plan.md. |

