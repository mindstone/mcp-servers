# Office connector architecture

How `@mindstone/mcp-server-office` is wired together end-to-end, and which files in `connectors/office/src/shared/` are byte-compatible copies of code that lives in the Mindstone Rebel monorepo.

This is the canonical reference for anyone debugging the Office sidecar handshake, the WebSocket bridge to the task pane, or planning a release that touches the vendored sidecar / App-Bridge / embedded-chat code.

## Sidecar lifecycle, port allocation, and manifest sideloading

1. The host (e.g. Mindstone Rebel) spawns the stdio MCP server (`dist/index.js`).
2. The MCP server expects a running Office sidecar — it discovers it via the
   state file path in `MCP_OFFICE_SIDECAR_STATE` (the parent directory of that
   file is the sidecar's state directory: certs, per-app manifests, etc.).
3. If no sidecar is running, the MCP server lazy-spawns one from
   `dist/sidecar/cli.js`.
4. On first start, the sidecar:
   - Generates a trusted localhost HTTPS certificate via
     `office-addin-dev-certs`.
   - Binds to port `52100` (with a small fallback window if the port is busy).
   - Writes `manifest.word.xml` / `manifest.excel.xml` /
     `manifest.powerpoint.xml` into each Office app's WEF folder so the host
     Office app sideloads the add-in at launch.
   - Writes a state file containing its `port` + auth `token`. The MCP server
     parses this state file via `ReadySignalSchema` (see vendored
     `src/shared/sidecar/readySignal.ts`).
5. Office detects the sideloaded manifests at launch and shows a Rebel ribbon
   button. Clicking it opens the add-in task pane, which connects back to the
   sidecar over authenticated WebSocket.
6. Tool calls on the MCP server are forwarded via HTTPS to the sidecar, then
   routed over WebSocket to the task pane, which calls the Office.js APIs in
   the Word / Excel / PowerPoint context.
7. Embedded chat (taskpane chat UI) calls flow over the sidecar's `/intent/*`
   HTTPS proxy, which mints a paired App-Bridge token, forwards to Rebel's
   App-Bridge service, and streams the response back as Server-Sent Events.
   Diagnostic taps (`/diag/ping`, `/diag/log`, `/diag/tail`) are unauthenticated
   loopback-only routes used by the in-WebView debugging surface.

## Known drift risk: vendored code from the Mindstone Rebel monorepo

Some files in this package are **byte-compatible copies** of code that also
lives in the Mindstone Rebel monorepo (`github.com/mindstone/MindstoneRebel`).
They have to stay in sync on both sides; there is no automation today.

**Vendored from Rebel's `src/shared/sidecar/`** (wire-format contract between
Rebel's main process and this sidecar CLI):

- `src/shared/sidecar/stateFile.ts`
- `src/shared/sidecar/readySignal.ts`
- `src/shared/sidecar/constantTime.ts`
- `src/shared/sidecar/errorMessages.ts`

**Vendored from Rebel's `src/core/appBridge/`** (minimum slice needed for the
sidecar bundle; ~1,444 LOC across four files plus the intent wire schema):

- `src/shared/appBridge/server/commandRouter.ts`
- `src/shared/appBridge/server/connectionManager.ts`
- `src/shared/appBridge/shared/errors.ts`
- `src/shared/appBridge/shared/protocol.ts`
- `src/shared/appBridge/shared/intentProtocol.ts`

**Vendored from Rebel's shared embedded-chat layers** (`packages/shared/src/`):

- `src/shared/intentClient/{client,clientTypes,diagnosticBuffer,diagnostics,errors,index,intentTransportAdapter,persistence,safeEmit,sse,types}.ts`
- `src/shared/chatController/{controller,index,offlineProbe,reconnect,types}.ts` (React adapters intentionally omitted: `react.ts`, `useChatController.ts`)
- `src/shared/chatUI/{copy,format,index,safeText,viewModels}.ts`

### Intentional browser-only drift retained in the vendored appBridge slice

The Office connector deliberately drops browser-extension-only surface to keep
the sidecar bundle tight. These omissions are not accidental drift; they are
contracts that should be preserved on every sync:

- `src/shared/appBridge/shared/protocol.ts` omits browser-extension host capability keys (`prepare_install`, `extract_extension`, `reveal_extension_folder`, `open_extensions_page`, `diagnose`) and extension-only event/session frames.
- `src/shared/appBridge/shared/errors.ts` omits browser-extension-only `INJECTION_REFUSED` mappings/copy and related origin-detail parsing helpers.
- `src/shared/appBridge/server/commandRouter.ts` omits Rebel-core-only `pino` / `@core/errorReporter` / `installEvent` logging hooks.
- `src/shared/appBridge/server/connectionManager.ts` drift is docs/comment + import-specifier style only (no Office wire/runtime delta).

### Risk

**If the Rebel-side files change, this package's copies will drift silently.**
The state-file / ready-signal schemas in particular are a wire-format contract
— the Rebel main process parses what the sidecar writes — and a silent drift
will surface as runtime `ReadySignalSchema.safeParse()` failures or sidecar
startup regressions. The chat layers' wire schemas (`intentProtocol.ts`) play
the same role for the `/intent/*` proxy: any drift in `IntentKind`,
`StreamEvent`, or related types will break end-to-end chat.

### TODO — future work

Extract these into their own published package(s) — e.g.
`@mindstone/app-bridge-core` plus a shared sidecar-protocol package and a
shared embedded-chat package — so they become versioned contracts rather than
vendored code. Until that ships, the embedded-chat layers in particular are a
recurring drift hotspot because they evolve faster than the App-Bridge wire
schema.

**Until then:** anyone touching either side must manually keep both copies in
sync. When editing here, diff against the corresponding file in the Rebel
monorepo (`src/shared/sidecar/*`, `src/core/appBridge/*`, and
`packages/shared/src/{intentClient,chatController,chatUI}/*`) and copy the
change across before landing. Both sides are covered by their own test suites
but neither proves the other's copy is byte-current.
