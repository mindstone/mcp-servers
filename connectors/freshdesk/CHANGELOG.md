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
### Security
- Vendor-supplied numeric fields are now rendered through a finite-number guard in every output path: ticket/contact/company/agent/group/article/field/conversation ids, `requester_id`/`responder_id`/`group_id`/`company_id`/`folder_id`/`category_id`, ticket URLs, and search-result `total` values can no longer interpolate an API-shape-violation value (e.g. a string carrying a spoofed close tag) into model-visible output raw — they render a connector-authored `(unknown id)` placeholder or `null` instead.
- `create_freshdesk_ticket` / `update_freshdesk_ticket` now echo `id`, `status`, and `priority` only when they really are finite numbers (`null` otherwise), closing the raw vendor echo in the structured response.
- The host-bridge state file is validated before use: a non-integer `port` (e.g. `"80@attacker.example"`, which WHATWG URL parsing would redirect off-host along with the plaintext API key and bridge bearer token) or empty `token` now fails closed to "Bridge not available".
- Bridge responses no longer leak bridge-controlled bytes: a non-JSON body becomes a fixed connector-authored error instead of a native parse error quoting body fragments, and bridge-authored `warning`/`error` strings are enveloped as untrusted content before reaching model-visible output.
- `accounts.json` writes no longer follow symlinks (`O_NOFOLLOW` where available) and are chmodded `0o600` through the file descriptor whether or not the file pre-existed — the `mode` argument alone only applies at creation.
- A failed `accounts.json` read no longer turns into silent multi-account credential destruction: `upsertAccount`/`removeAccount` distinguish a legitimately absent file (ENOENT) from an unreadable or corrupt one and refuse the write with `ACCOUNTS_UNREADABLE` on the latter, instead of truncating the file down to a single account while reporting `ok: true`.

### Fixed
- 429 retries now share one wall-clock budget (90s) across all attempts and backoff sleeps instead of a fresh 30s timeout per attempt — a hostile endpoint could previously hold a single tool call open for ~2.5 minutes; exceeding the budget surfaces `RATE_LIMITED`/`TIMEOUT`.
- Caller-supplied fetch headers are now spread before the injected `Authorization`/`Content-Type`/`Accept` headers, so the credential always wins (latent — no call site passes custom headers today).

## [0.3.0] - 2026-08-08

### Changed

- Freshdesk connector: canonical result envelopes, agents/groups + knowledge-base tools, 429 backoff; contact/company custom_fields key-enveloping.

### Added
- `list_freshdesk_agents` and `list_freshdesk_groups` tools — discover valid agent and group IDs for the existing `responder_id`/`group_id` assignment parameters on ticket create/update. Names and descriptions are returned inside untrusted-content envelopes.
- Contact and company read tools: `list_freshdesk_contacts` (email/company filters), `search_freshdesk_contacts` (Freshdesk query syntax), `get_freshdesk_contact`, `list_freshdesk_companies`, `get_freshdesk_company`. Names, job titles, addresses, descriptions, and notes are returned inside untrusted-content envelopes.
- Knowledge base read tools: `search_freshdesk_solutions` (keyword search via `/search/solutions`) and `get_freshdesk_solution_article` (full article body). Titles and bodies are returned inside untrusted-content envelopes.

### Changed
- GET requests now retry in place on HTTP 429 (max 2 retries, honouring `Retry-After` capped at 30 seconds, with jitter) instead of failing immediately — plan-capped per-minute rate limits previously hard-failed under load. Writes are never retried automatically, so a retried POST cannot create duplicate tickets or replies.
- Ticket subjects are now wrapped in untrusted-content envelopes in every output path (previously only search results wrapped them), and the envelope implementation now delegates to the canonical shared `wrapUntrusted` helper instead of a hand-rolled copy.
- `reply_to_freshdesk_ticket` and `add_freshdesk_note` now declare `destructiveHint: true` — both write to production tickets (public replies are customer-facing).

### Security
- Every Freshdesk-authored string is now enveloped in all output paths — not just names/descriptions/bodies: ticket type, requester email, tags, string-valued `custom_fields` (keys included), contact email/phone/mobile/tags, company domains/industry/tier/health score, agent contact fields, group type, ticket-field label/name/type/choices, article tags, and vendor-echoed subjects in create/update responses were previously returned raw.
- Vendor-authored timestamp strings (`created_at`, `updated_at`, `due_by`) are now enveloped in text output for tickets, conversations, contacts, companies, and KB articles, matching the detailed-JSON mode which already enveloped them.
- Responses that violate the declared Freshdesk API shape now fail closed instead of leaking unenveloped text: a non-string ticket `subject` renders a connector-authored placeholder rather than stringifying the raw value, and string-typed `status`/`priority`/`source` values render `Unknown` rather than being interpolated into the mapped-label fallbacks.
- Error handling no longer exposes vendor-controlled bytes: error response bodies are never logged or surfaced, the `Retry-After` header is reduced to a parsed non-negative integer before it reaches the rate-limit message, a non-JSON success body becomes a fixed connector-authored error, and unexpected exceptions return a generic `INTERNAL_ERROR` (the underlying detail is still logged locally on stderr).
- Request logging now records method and path only; query strings carrying contact-email filters and search terms are no longer written to logs.
- Invalid `status`/`priority` values on ticket create/update are rejected with `INVALID_STATUS`/`INVALID_PRIORITY` before any request is made, instead of being silently omitted while the write still went through. IDs and pagination inputs are validated as bounded positive integers (`page` ≥ 1, `per_page` within the documented cap, IDs positive integers).

### Fixed
- `search_freshdesk_solutions` gains a `page` parameter and reports `hasMore` (plus a "more results may be available" hint in concise output) on full pages, instead of presenting a truncated first page as the complete result set.
- `accounts.json` is now read open-once through a file descriptor (open + fstat + read), closing the check-then-use window between the old existence check and the read; a missing, deleted, or non-regular file fails closed to "no accounts".
- Hot-reload now drops previously loaded accounts when `accounts.json` becomes a non-regular file (e.g. replaced by a directory) instead of serving stale in-memory credentials, and the config-file open is non-blocking so a FIFO at the config path cannot stall tool invocations waiting for a writer.

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **freshdesk**: wrap returned ticket bodies in untrusted-content envelopes (M3.5a)
- **freshdesk**: neutralise untrusted-content close-tag breakout (M3-fix-B)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **freshdesk**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Fixed
- **freshdesk**: add strict subdomain validation to prevent API key exfiltration
- **bridge**: clean brand references from template and batch1 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys

## [0.1.0] - 2026-04-09

### Added
- **freshdesk**: externalize Freshdesk MCP connector to standalone package


