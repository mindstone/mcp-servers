# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Security

- Text from the service that contains an untrusted-content tag is now escaped the same way as in every other connector, open and close tags alike, keeping the original spelling, so the assistant still reads that text as outside content.

### Fixed

- Word inserts split Windows (CRLF) and Word (lone CR) line breaks into separate paragraphs, so a markdown heading on its own line is styled as a heading.
- Excel `add_worksheet` returns the new sheet's final position when it is placed at the start or after another sheet.
- An add-in that does not know a command, or a command that fails inside Office, now returns its own error code (`UNKNOWN_COMMAND` or `ADDIN_EXECUTION_ERROR`) with matching recovery guidance instead of `UNKNOWN_ERROR`.
- Install and uninstall wording: the trusted local certificate may need approval when it is first created or renewed, and every platform's uninstall summary says to turn off the Office connector to keep the add-in removed.

## [0.4.0] - 2026-11-10

### Changed

- Reliable Windows setup, structured AI feedback and clear undo guidance.

### Changed

- Successful edits and their tool descriptions share undo guidance for the local Office app and platform, including native undo exceptions and PowerPoint for Mac reversal limits. PowerPoint text, notes and shape-format edits return the previous values.
- Every Office tool, including setup, status and validation failures, now returns JSON with `ok`, `app`, `action`, and either `data` or an error with a stable code, message, fix and retry guidance. External text remains inside untrusted-content envelopes.
- Unsupported results returned inside an Office command now report failure; missing Office APIs advise updating Office. Timeout guidance asks callers to read the current state before repeating an edit.
- Word `get_properties` returns custom properties as an array of `{ name, value }` entries so all document-authored names are enclosed in untrusted-content envelopes.

### Fixed

- Word markdown inserts retain paragraph-style formatting, apply inline bold and italic without clearing style formatting or carrying marks into adjacent parts, and style each line at every insertion location in one writing batch. Stray asterisks no longer stall insertion. PowerPoint adds and moves a slide in one batch, with a second batch only for placeholder text; unavailable slide movement fails before creation. Excel adds and positions a worksheet after another sheet in one writing batch.
- Excel condition filters translate named operators and reject unknown ones before writing. Sorting rejects unknown headers and resolves multi-letter columns relative to the range; unsupported shape types fail before creation.
- Formatted PowerPoint shapes check API support before creation. Speaker-notes and layout failures retain coded errors; notes reads skip only the no-text-frame `InvalidArgument` from loading a shape's text. Word alignment covers every targeted paragraph, and pairing and partial-slide recovery guidance identify the next step.
- Setup and status validation failures use the same `app: "all"` value as their other results.
- Exceptions thrown by tool handlers report `INTERNAL_ERROR` unless they are invalid-argument errors. An installation-disabled Office connection reports non-retryable `CONNECTION_DISABLED` with guidance to contact whoever manages the installation.
- Excel JSON row keys derived from spreadsheet headers and non-identifier keys anywhere in Office result data are enclosed in untrusted-content envelopes, with closing tags escaped. Columns and Word custom properties named `__proto__` retain their values.
- Office actions report missing targets, empty selections and unsupported requested options as coded failures. Relative insertions, paragraph ranges and specific tracked-change targets reject missing target fields before writing. Specific tracked-change targets also list unmatched IDs as `ITEM_NOT_FOUND` before accepting or rejecting anything. PowerPoint text alignment and Excel range filter criteria are applied; unknown filter columns fail before writing.
- A slide created before a later step fails returns `PARTIAL` with its id and inspect-or-delete recovery. Word edit results describe what changed.

### Security

- `ws` now requires 8.22.0 or later (a memory-exhaustion fix in the WebSocket parser the sidecar uses) and `@modelcontextprotocol/sdk` 1.32.2 or later; locked transitive dependencies are updated to releases with security fixes.
- `office-addin-dev-certs` moves to 3.0.1, which no longer bundles Application Insights and its Azure and OpenTelemetry dependencies; the certificate location, names and the API the sidecar uses are unchanged.
- Setup and status explain which apps are connected and how to open Rebel; the task pane asks you to open Rebel when waiting for a connection.
- On Windows the add-in now appears in Word, Excel and PowerPoint: it is registered where Office looks for sideloaded add-ins instead of copied into Office's cache folder.

## [0.3.0] - 2026-08-08

### Changed

- Office connector: canonical result envelopes via the toMcpResult chokepoint, untrusted-content fencing; expanded Word/Excel/PowerPoint actions.

### Added
- **Word tables are no longer write-only**: new `rebel_office_word_read_table` (read a table's cell values as a 2D array) and `rebel_office_word_update_table_cell` (replace the text of a single cell by 0-based row/column) tools.
- **Word named styles**: new `rebel_office_word_apply_style` tool applies a paragraph style (built-in like "Heading 1"/"Quote", or a document-defined custom style) to existing paragraphs — targeted by selection, paragraph range, or search text.
- **Excel pivot tables**: new `rebel_office_excel_get_pivot_tables`, `rebel_office_excel_create_pivot_table`, and `rebel_office_excel_refresh_pivot_table` tools. Creation places the pivot on a new worksheet (or a named existing one) and requires an Excel version with pivot table API support (ExcelApi 1.8+); field arrangement stays in Excel — the pivot table API cannot arrange fields.
- **PowerPoint layouts and shapes**: `rebel_office_powerpoint_add_slide`'s `layout` parameter now actually resolves the named layout against the slide masters (it was previously accepted but ignored), new `rebel_office_powerpoint_apply_layout` changes an existing slide's layout (PowerPointApi 1.8+), and new `rebel_office_powerpoint_delete_shape` / `rebel_office_powerpoint_format_shape` cover shape deletion and fill/line/position/size formatting (shapes addressed by ID or placeholder name, mirroring `update_text` targeting). Tables/charts on slides remain beyond the PowerPoint JavaScript API's reach — a platform limitation, not a connector gap.

### Fixed
- The MCP server now reports the real `package.json` version instead of a hardcoded literal that had drifted a full release behind (reported `0.1.1` while the package was `0.2.0`).
- Tighten tool input validation so malformed conditional arguments are rejected before anything is relayed to the Office sidecar: `rebel_office_word_apply_style` now requires `searchText` for `searchText` targets and `startParagraph` for `paragraphRange` targets, the PowerPoint shape tools require `shapeId`/`placeholder` matching their target type, and `rebel_office_powerpoint_format_shape` requires `formatting` to set at least one property. Previously these were only rejected inside the add-in, after the relay.
- The six new content-mutating tools (`rebel_office_word_update_table_cell`, `rebel_office_word_apply_style`, `rebel_office_excel_create_pivot_table`, `rebel_office_excel_refresh_pivot_table`, `rebel_office_powerpoint_apply_layout`, `rebel_office_powerpoint_format_shape`) now advertise `destructiveHint: true`, matching both their README descriptions and the existing `rebel_office_powerpoint_delete_shape`.

### Security
- Wrap all add-in-returned document/spreadsheet/slide content in `<untrusted-content source="microsoft-office-{app}">` envelopes at the `toMcpResult` boundary, and envelope add-in-relayed error messages (FOX-3490 remediation). Content authored inside Office files is attacker-influenced whenever the file came from somewhere else; the envelope marks it as data, not instructions. Locally generated guidance (sidecar unreachable, setup hints) is not enveloped.
- Envelope non-2xx sidecar error bodies the same way: a failed sidecar/add-in response's `error` field or raw body is external, attacker-influenced text, and previously reached the model verbatim — including any embedded `</untrusted-content>` breakout payload.
- Close-tag breakout escaping now neutralises every whitespace variant of `</untrusted-content>` (newline/CR/tab, not just spaces/tabs), so a wrapped payload cannot terminate its envelope early with e.g. `</untrusted-content\n>`.
- Pin `@grpc/grpc-js` to `^1.14.4` via `overrides` to clear high-severity advisories GHSA-5375-pq7m-f5r2 / GHSA-99f4-grh7-6pcq (malformed-request crash) in the transitive OpenTelemetry OTLP-gRPC exporter chain (was 1.14.3).

## [0.2.0] - 2026-05-19

### Added
- **office (chat)**: Restore parity between the Office taskpane and Rebel's browser side panel by porting the unified embedded chat UI from MindstoneRebel commit `cfaaba4f5` (Stages 7–12 of the shared embedded-chat unification work, which were deleted from the OSS package before being ported during the original `@mindstone-engineering` → `@mindstone` scope migration). Word, Excel, and PowerPoint now show "What can I help you with?" instead of the pre-chat "Connected to Rebel" / "Recent Commands — No commands yet" status panel.
- **office (sidecar)**: Mount the App-Bridge `/intent/*` proxy on the sidecar (with token caching, 401 invalidation, and SSE `revoked`-event invalidation), plus the `/diag/{ping,tail,log}` debug-surface routes mandated by `EMBEDDED_CHAT_ARCHITECTURE.md`.
- **office (addin)**: Document-scoped chat persistence (different Word documents get independent chat histories), `bridgeReady` injection into the taskpane HTML (taskpane gates chat-UI mount on this flag), and `window.__rebelDiag` in-WebView diagnostics surface.
- **office (vendoring)**: Vendor the shared embedded-chat layers (`intentClient`, `chatController`, `chatUI`) and the App-Bridge intent wire schema (`intentProtocol.ts`) under `src/shared/`. See [`docs/connectors/office-architecture.md`](../../docs/connectors/office-architecture.md) for the manual-sync contract until the planned `@mindstone/app-bridge-core` extraction.
- **office (tests)**: 66 new tests covering the chat surface (chatClient diagnostics, chatState document-scope persistence + corrupted-record recovery, chatUI controller + header status, sidecar intent-proxy contract + reconnect + bridge-auth, taskpane-html structural contract). Total test count: 88 → 153 passing + 1 skipped (F8 follow-up).

### Changed
- **office (env)**: Several browser-leaning bits of the shared chat layers ship vendored byte-current with their MindstoneRebel sources; see [`docs/connectors/office-architecture.md`](../../docs/connectors/office-architecture.md) for the parameterisation follow-up.
- **office (build)**: `dist/addin/taskpane.html` now mounts `<div id="chat-root">` as the user-visible default; the legacy `Recent Commands` panel remains in the markup behind a collapsed "Connection details" debug accordion (`data-open="false"`, `hidden`).

### Security
- **sidecar**: Reject unauthenticated requests to `/taskpane.html`, `/taskpane.js`, and `/assets/*` whose `Host` header does not name a loopback host (`localhost`, `127.0.0.1`, or `::1`) on the bound port. The page embeds the WebSocket auth token, so this closes a DNS-rebinding path where a browser tab tricked into resolving an attacker-controlled hostname to 127.0.0.1 could fetch the page cross-origin and exfiltrate the token. Office's manifest only ever uses `localhost:<port>`, so legitimate add-in loads are unaffected.

### Notes
- Skips `0.1.5` per `mindstone/MindstoneRebel/docs/plans/260519_office_chat_unification_revendor.md` decision D1 (bundle chat unification + the unreleased `0.1.4` scope-rename into a single `0.2.0` minor).
- Published only under the `@mindstone/` scope. The legacy `@mindstone-engineering/mcp-server-office@0.1.3` install path continues to resolve via the consuming host's `OFFICE_MCP_PACKAGE_SPECS_TO_TRY` fallback until telemetry confirms ≤0.1% legacy-spec hits for ≥30 days; at that point the legacy slot will be removed in `0.2.1`.

## [0.1.4] - 2026-05-14
### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.
- **office**: Clear pre-existing high-severity npm audit failure on main.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.3] - 2026-05-05

### Added
- **office**: v0.1.3 — security-review preconditions + kill-switch backward compat. Addresses three findings from the Pre-Publish Security Review of v0.1.2 (specialist-security + reviewer-opus4.7-thinking, both PASS_WITH_CONDITIONS) without architectural risk; bumped to 0.1.3 ahead of npm publish.

## [0.1.2] - 2026-05-04

### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **office**: vi.mock office-addin-dev-certs in test setup
- **office**: scope dev-cert TLS bypass to loopback agent (M3.1)

## [0.1.1] - 2026-04-30

### Fixed
- **office**: address Stage 1 review findings — SECURITY.md, CI matrix, README drift warning, stale paths, zod dep, tarball cleanup
- **office**: Regenerate package-lock.json with full esbuild platform binaries. CI 'npm ci' was failing because the lockfile was missing @esbuild/<platform>@0.28.0 entries for non-darwin platforms.
- **office**: Clarify post-setup instructions — Office desktop apps required + 'Add ons' ribbon location. The previous copy said only 'Home ribbon' which sent users hunting; on current Office builds the Rebel button lives under Home → Add ons.
- **office**: 0.1.1 — pre-create ~/.office-addin-dev-certs in test setup. Workaround for upstream office-addin-dev-certs@2.0.7 calling deleteCertificateFiles() without an ENOENT guard, which crashes the integration suite on fresh CI runners.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.1.0] - 2026-04-29

### Added
- **office**: Port Office MCP connector to OSS npm package. Initial 0.1.0 port — lift-and-shift of the stdio MCP server, sidecar, and Office add-in from Mindstone Rebel.


