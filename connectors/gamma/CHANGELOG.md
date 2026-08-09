# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Fixed

- Re-synced the vendored `<untrusted-content>` envelope helper with the canonical hardened reference: attribute-bearing close-tag variants (`</untrusted-content foo>`) and spoofed open tags inside wrapped content are now escaped, closing an envelope-breakout gap an LLM parser could read as an envelope boundary.

## [0.4.0] - 2026-08-06

### Changed

- Canonical envelopes on all external text; fail-closed Zod responses; download URL allow-list with redirect revalidation; generationId schema; polling observability

### Security
- `gamma_list_themes` and `gamma_list_folders` now return workspace-authored theme and folder names inside `<untrusted-content>` envelopes with close-tag breakout escaping (repo security invariant #6). Theme `colorKeywords`/`toneKeywords` are enveloped too; IDs, cursors, and the theme type stay raw, and response fields are enumerated explicitly so vendor-added unknown fields cannot pass through.
- Re-vendored the canonical strong `<untrusted-content>` envelope helper: close-tag breakout escaping now neutralises every case/whitespace variant (including newline, carriage-return, and form-feed before `>`), not just space/tab.
- `gamma_get_status` now envelopes the vendor-authored failure text (`error`) and the `gamma_url` / `pdf_url` / `pptx_url` values before they reach the model; the export download path continues to use the raw internal URL.
- All Gamma API responses are validated fail-closed with Zod before use. A malformed JSON body or unexpected response shape surfaces as a generic `INVALID_RESPONSE` error — raw parser messages (which can embed a fragment of the vendor response) and unexpected internal errors no longer reach model-visible output; details remain in the connector logs.
- Vendor error bodies are no longer written to the logs; only the HTTP status code is logged.
- The `Retry-After` header on 429 responses is treated as structured data: only a bounded delay-seconds value or a valid future HTTP-date is honoured, and the parsed number — never the raw header — is used in the rate-limit error. A hostile or malformed header degrades to connector-authored phrasing instead of reaching model-visible output.
- `generationId` values in Gamma API responses are validated against a strict identifier schema (URL-safe characters only, bounded length). A response carrying anything else fails closed as `INVALID_RESPONSE` rather than being interpolated into trusted prose or request paths.
- Export downloads now validate the URL before fetching: HTTPS only, no userinfo, private/loopback/reserved hosts rejected, and hosts restricted to `gamma.app` and its subdomains (mirrors napkin's `validateDownloadUrl`). A rejected URL degrades gracefully in `gamma_get_status` — the generation result is returned and the refusal is surfaced in the message. Redirects are followed manually with every hop re-validated against the same checks (max 5 hops), so an allowed export URL cannot bounce the download to an arbitrary or private host.
- Export temp files are created atomically: unpredictable filename, `O_CREAT|O_EXCL|O_NOFOLLOW` open, fstat-verified regular file, written through the open descriptor with mode `0600`, and unlinked on failure — a pre-planted or raced symlink at the temp path is refused instead of written through.
- Bridge state loading opens the state file once, fstat-verifies it through the descriptor (regular file, size-capped), reads through the same descriptor, and validates the `{ port, token }` shape before use; every rejection logs a specific stderr warning instead of failing silently.

### Fixed
- `gamma_generate` and `gamma_create_from_template` now declare `destructiveHint: true` — they create workspace content and may consume credits (repo security invariant #7).
- `num_cards` is now validated as an integer in the documented 1–75 range before any outbound request.
- Export-URL polling failures are no longer silently skipped: when polling exhausts, the response reports how many status checks failed (`export_polling_failures`) instead of presenting it as a plain export timeout.
- Removed a duplicated `### Changed` heading in the 0.3.3 entry.

## [0.3.3] - 2026-07-01

### Changed

- Reworked `README.md` to explain when to choose this local Gamma connector, what creation/export workflows it helps with, and the main setup and safety notes.

## [0.3.2] - 2026-05-14
### Added
- **registry**: backfill Gamma server.json and bake into _template + CI. New connectors inherit a working server.json from the template with mcpName placeholder; CI gate enforces cross-file consistency and runs mcp-publisher validate on every connector with a server.json.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.3.1] - 2026-04-29

### Fixed
- **gamma**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.3.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.3.0] - 2026-04-21

### Added
- **connectors**: Harden request timeouts across 4 long-running generation connectors. Follows nano-banana-v0.3.0 (139d488) — same hard-coded 30s timeout class of bug applies to polling-style generation APIs.

## [0.2.0] - 2026-04-11

### Fixed
- **bridge**: clean brand references from batch2 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys
- **ci**: standardize remaining mock API key fixtures to mcp-test-* pattern

## [0.1.0] - 2026-04-09

### Added
- **gamma**: externalize Gamma MCP connector to standalone package
