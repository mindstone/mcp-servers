# Writing a connector README

This guide describes how to write the `README.md` for an MCP server in this repository. It is meant to be reusable: anyone adding a new connector — or rewriting an existing one — can follow it without knowing anything beyond the connector itself.

The same shape works for any source-available MCP server published elsewhere, but the guidance below assumes the connector lives in `connectors/<name>/` and ships under the `@mindstone/` npm scope.

## Goals of the README

A reader landing on the connector's README is usually trying to answer three questions, in this order:

1. **What is this?** A one-line description that tells me whether I'm in the right place.
2. **Why this one?** Especially when the vendor ships an official MCP server, or a popular community option already exists.
3. **How do I run it?** Install, configure, point a host at it, see the tool list.

Everything else — security notes, internal architecture, smoke tests — is supporting material that the reader will scroll to only after those three are settled.

## Standard structure

Use the section order below. Drop sections that genuinely do not apply; do not invent new top-level sections without a reason. Look at neighbouring connectors before introducing anything novel.

```markdown
# @mindstone/mcp-server-<name>

[![npm version](...)](...)
[![License: FSL-1.1-MIT](...)](./LICENSE)

One-line description of what this server does.

*One-line positioning sentence in italics — see "Positioning line" below.*

## Status

- **Version:** [0.x.y](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-<name>)
- **Auth:** <one-phrase auth model> ([`ENV_VAR_NAME`](./server.json))
- **Tools:** [<count>](./src/tools/) (<short domain summary>)
- **Surface:** cloud-api | desktop-addin | local-cli | browser-automation
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

## Why this exists

…see the "Why this exists" guidance below…

## Example interaction

> "<a representative user prompt>"

Tools the host calls:
1. `<tool_name_one>` — <one-line description of what it does for this prompt>
2. `<tool_name_two>` — <…>

Response (trimmed):
```json
{ "…": "…" }
```

## Requirements
## Quick Start
## Configuration
## Host configuration examples
## Tools (<count>)
## Security notes        # if there is anything connector-specific
## Licence
```

Rationale for the top-of-README order:

1. **Title + tagline** — am I in the right place?
2. **Positioning line** — is this the official one or someone else's? Should I keep reading?
3. **Status block** — version, auth, tool count, hosts. The triage signals.
4. **Why this exists** — for the reader who wants the full positioning after the quick-triage block has done its job.
5. **Example interaction** — what does a successful call actually look like, now that I've decided to use this one?

Conventions worth keeping consistent across connectors:

- **Title.** Use the published package name (`@mindstone/mcp-server-<name>`). Older READMEs use the human title (`Slack MCP Server`) — either is fine, but pick one and stick with it within a single file.
- **Tagline.** A single sentence directly under the title. Same wording, more or less, as the row in the root `README.md` table — see "Updating the parent README" below.
- **Header badges.** Cap at three: npm version, licence, and at most one more (e.g. last release). More than three signals "hobby project"; this repo's positioning is the opposite.
- **Tool count.** Put the number in the heading (`## Tools (23)`) so readers can scan for it. The count must match the number registered in `src/index.ts` (or `src/tools/`); CI doesn't enforce this yet, so it's on the PR author to keep current.
- **Licence.** Always FSL-1.1-MIT with a link to the local `LICENSE`.

### Positioning line

A single italic sentence directly under the tagline. It exists so a reader scanning the top of the page can answer *"is this the official server or someone else's, and why does this one exist?"* without reading the "Why this exists" paragraph below.

Shape: *"<What it is in one phrase>. <Most distinctive fact>."* Keep it under ~25 words. No marketing language.

Good examples:

- *Local-only Fathom MCP. Not the official server — built before Fathom shipped theirs; tokens stay on disk and each release goes through our own security review.*
- *Desktop-only Office MCP. Edits the Word/Excel/PowerPoint documents the user already has open on macOS or Windows.*
- *Multi-account HubSpot MCP. Host-orchestrated OAuth, sandboxed file uploads, source-attribution labels on every new record.*

Anti-patterns: *"powerful Slack integration"*, *"comprehensive CRM access"*, *"AI-first design"*. Strip any adjective that isn't load-bearing.

### Status block

Three to five rows, plain Markdown bullets, **with every claim linked to evidence**. The point is fast triage that a security-conscious reader can verify in two clicks.

```markdown
## Status

- **Version:** [0.2.3](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-<name>)
- **Auth:** API key ([`FATHOM_API_KEY`](./server.json))
- **Tools:** [7](./src/tools/) (meetings, transcripts, teams)
- **Surface:** cloud-api
- **Machine-readable:** [`STATUS.json`](./STATUS.json)
```

Rules:

- Every fact that *can* link to its source of truth *should*. Version → `CHANGELOG.md`. Auth → `server.json`. Tools → `src/tools/`. The README's authority is borrowed from the linked artefacts.
- The final `Machine-readable:` row links to the connector's `STATUS.json` (see below). That file is the source of truth that the catalogue and the parent-README table both consume.
- Do not add badges to this block. Badges are constrained to the three at the top. Status rows are plain text + inline links because they're grep-able, easy to keep current, and don't add HTTP requests to the README render.
- When `lastVerifiedAgainstApi` is set in `STATUS.json`, append a small *"Last verified against the live API: YYYY-MM-DD"* line below the bullet list.

### STATUS.json (machine-readable mirror of the Status block)

Each connector ships a `STATUS.json` at `connectors/<name>/STATUS.json`. It is the source-of-truth for fields that appear on the GitHub Pages catalogue and the parent README's connector table. The README's `## Status` block is the human-readable rendering of the same data; CI verifies they don't drift.

Shape (full spec in [`docs/status.schema.json`](./status.schema.json)):

```json
{
  "$schema": "../../docs/status.schema.json",
  "schemaVersion": 2,
  "name": "<connector-dir>",
  "package": "@mindstone/mcp-server-<name>",
  "auth": {
    "type": "api-key | basic-auth | oauth-host-orchestrated | oauth-local-callback | oauth | none | hybrid",
    "envVars": ["UPPERCASE_NAMES_FROM_SERVER_JSON"]
  },
  "tools": {
    "count": 7,
    "domains": ["meetings", "transcripts", "teams"]
  },
  "surface": "cloud-api | desktop-addin | local-cli | browser-automation | local-protocol",
  "evidence": {
    "changelog": "./CHANGELOG.md",
    "tools": "./src/tools/",
    "auth": "./src/",
    "tests": "./test/",
    "npm": "https://www.npmjs.com/package/@mindstone/mcp-server-<name>",
    "serverJson": "./server.json"
  }
}
```

Bootstrapping and maintenance:

- Generate a draft for a single connector with `node scripts/init-status.mjs <connector-name>`. The script reads `package.json`, `server.json`, counts `registerTool()` calls in `src/` (with a fallback that handles the `definitions.ts`-array pattern used by hubspot), and writes a draft. It leaves `surface`, `tools.domains`, and `tools.count` (when the heuristics under-report — verify against the README) for the human author to confirm.
- Verify it is in sync with the rest of the connector with `node scripts/check-status.mjs <connector-name>`. CI runs this for every connector via the `status-check` matrix in `.github/workflows/ci.yml` and fails the PR on drift: tool-count mismatch, missing/extra secret env vars, `surface: "TBD"`, `## (Available )?Tools (n)` heading drift in the README, a present `version` field, or `schemaVersion ≠ 2`.
- `schemaVersion` is `2` today (v1 → v2, 2026-06-11: the stored `version` field was removed — the version is derived from `package.json`, and `check-status.mjs` rejects a STATUS.json that still carries one; see `docs/plans/260609_catalogue_drift_prevention.md`, Option 4). When a required field is added or semantics change, the schema version is bumped and `check-status.mjs` rejects older STATUS.json files until they're migrated.
- All scripts under `scripts/` operate on **one** connector at a time, per the repo-wide rule in `AGENTS.md`. The catalogue builder (`scripts/build-catalogue.mjs`) reads from all connectors but writes only into `docs/`; the committed catalogue is verified against the live generator output by the `catalogue-check` job on every PR.

### Example interaction

One block, placed immediately below `## Why this exists` and above `## Requirements`. Strict format:

```markdown
> "<a representative user prompt the host might receive>"

Tools the host calls:
1. `<tool_name>` — <one-line description for this specific use>
2. `<tool_name>` — <…>

Response (trimmed):
```json
{ "...": "..." }
```
```

Rules:

- **Plain text prompt + JSON response.** No host UI screenshots — they age badly. No GIFs.
- **Trim aggressively.** The point is to show shape, not to be exhaustive. Five to fifteen lines of JSON is plenty.
- **Be honest.** The example must be something the connector can actually do today. If you wouldn't want CI to assert against it, don't write it.
- **Avoid host-specific syntax** (no Claude system prompts, no Cursor mentions). The prompt is what a user would type in plain English.
- **One example per connector.** Two only if the connector has two genuinely different surfaces (e.g. read vs write, or two unrelated domains).

### Forbidden patterns

These are explicit violations of the repo's `AGENTS.md`. They have crept into individual READMEs and should be fixed when touched, not propagated:

- **No emojis anywhere in the README.** Including warning emojis at the top of a section. The current opener in `connectors/quickbooks/README.md` (`## ⚠️ Breaking change…`) is an anti-example — that heading should read `## Breaking change in 0.3.0 — production writes are gated by default`.
- **No marketing adjectives.** *"powerful"*, *"comprehensive"*, *"seamless"*, *"best-in-class"*, *"blazing-fast"*, *"industry-leading"*, *"AI-first"*.
- **No AI-tool name-drops.** Do not reference Droid, Claude Code, Copilot, ChatGPT, or any AI coding assistant in commits, branches, PR titles/bodies, or README copy.
- **No host UI screenshots in the README body.** Link out to docs that can be updated independently if a screenshot is genuinely needed.

### Optional sections — use when they earn their place

These help engagement but cost ongoing maintenance. Add them only when the value is real:

- **Table of contents.** For READMEs over ~120 lines. Three to six manual jump links near the top.
- **Architecture sketch.** ASCII diagram for any connector with non-trivial topology (sidecars, multi-process, callback servers, per-account credential files). Commit a PNG only when ASCII genuinely can't carry the meaning. `connectors/office/` is the canonical case.
- **Tools-by-domain table.** When the tool count is above ~10, replace the flat list with a small table. Columns: *Tool*, *R/W*, *One-liner*. Makes destructive tools obvious at a glance.
- **Common workflows.** Two or three short *prompt → tools called* examples chained together. Only when the connector is regularly used in pipelines (e.g. meeting → CRM, ticket → knowledge-base). Drop the section entirely if it would just be padding.
- **Cross-links to paired connectors.** One line, not a section: *"Often used with [`fathom`](../fathom/) for meeting-summary-to-Slack workflows."*

## The "Why this exists" section

Place this directly under the one-line description, **before** installation or configuration. It answers the question every reader is silently asking: *"why this one and not another?"*

### How long it should be

Two to four sentences. Roughly 80–150 words. If a list helps, keep it to three short bullets at most. Anything longer belongs in a separate "Design notes" or "Security" section further down.

### What it should cover

A good "Why this exists" paragraph touches on three things:

1. **The state of the world when you built it.** What MCP servers existed for this product when you started? Often the honest answer is "none from the vendor" or "a few community options".
2. **What changed since.** If the vendor has since shipped an official MCP server, say so and link to it. Be open about it — readers will find out anyway.
3. **Why your server is still worth using.** One or two concrete reasons, in plain language. Examples: "everything runs on the user's machine", "we ship a desktop add-in alongside the server so the two stay in step", "we keep going through our own security review before each release".

### Language

Write for a reader who has never seen your codebase.

**Avoid**

- Internal codenames or product names that are not user-facing
- Industry acronyms that are not universally understood
- Compound technical phrases like *"host-orchestrated OAuth with atomic, durable, single-use refresh-token persistence"* or *"eager-load identity caching"*
- Marketing language: *"best-in-class"*, *"blazing-fast"*, *"industry-leading"*

**Prefer**

- Short sentences
- The active voice
- Concrete, observable facts: *"tokens stay on the user's machine"*, *"the user signs in through their browser"*, *"each account has its own credentials file"*
- The same friendly tone you would use in a launch blog post — not a security audit report

### What not to mention

- **Do not name third-party products you used to depend on and have since moved away from.** The story should be about your work, not about a previous tool. Even if migrating away from a service was a genuine reason for starting the project, that detail is internal context — it should not appear in a public README.
- **Do not name community projects unkindly.** If a community implementation was useful as a starting point, credit it. If it didn't fit your needs, describe the gap in your own terms rather than criticising the other project.
- **Do not invent reasons.** If a vendor already has a good official MCP server and yours covers the same ground with no real difference, say so and consider whether your server needs to exist at all. Readers respect honesty.

### Before you write

Spend a few minutes checking the current landscape:

1. **Search the web** for `"<vendor> official MCP server"` and read the top results. Vendors are shipping MCP servers monthly; what was true six months ago is often no longer true.
2. **Check your own CHANGELOG** for the first-release date so the "when we built this" phrasing is anchored to a real moment in time.
3. **Note any other MCP servers** (official or popular community ones) and decide whether to mention them by name. Mentioning the vendor's own server, with a link, is almost always the right choice.

If a vendor released an official MCP server *after* yours did, that is the headline nuance to capture — the reader needs to know both that you got there first and that the vendor has since caught up.

### A template

Use this as a starting point. Replace the bracketed parts with what fits your situation; drop the brackets that don't apply.

> When we started building this connector, [vendor] had not yet released an official MCP server[ — that came later, in (month year)]. The options available at the time [were thin / did not cover the surface area we needed / did not pass our security review]. We wrote our own so that [the host application or a specific user] could [concrete capability] with [tokens / data / files] staying on the user's machine. [Vendor]'s official server now exists and is a reasonable choice for many use cases — we continue to maintain this one because [one short, concrete reason].

### Worked examples in this repository

- [`connectors/fathom/README.md`](../connectors/fathom/README.md) — covers a case where the vendor's official MCP server arrived after ours.
- [`connectors/office/README.md`](../connectors/office/README.md) — covers a case where the vendor has not shipped an MCP server for this particular surface (desktop apps) and the community options didn't fit.
- [`connectors/hubspot/README.md`](../connectors/hubspot/README.md) — covers a case where vendor and community options exist but ours fills specific gaps that mattered to us (multi-account, local-only, sandboxed file uploads).

Read those three and use whichever shape is closest to the situation you're writing about.

## The other sections

### Requirements

A short bullet list: Node version, npm, OS constraints, any external CLI the connector shells out to (`shortcuts`, `office-addin-dev-certs`, etc.). Keep it factual — if the connector is desktop-only, say so.

### Quick Start

Three blocks, in this order, each a short fenced code sample:

1. **Install & build** — `cd connectors/<name> && npm install && npm run build`.
2. **npx (once published)** — `npx -y @mindstone/mcp-server-<name>`.
3. **Local** — `node dist/index.js`.

Do not add a fourth variant unless the connector genuinely needs one (e.g. a sidecar that has to be started separately).

### Configuration

List every environment variable the server reads, grouped by required vs optional. For each one give:

- The variable name
- A one-sentence description of what it controls
- A default if there is one, and any constraints (E.164 numbers, allow-listed hosts, `min`/`max` values)

These must also be declared in `server.json` under `packages[0].environmentVariables`. The README list and the manifest list should agree; CI rejects mismatches.

If the connector has a non-trivial auth flow (host-orchestrated OAuth, structured `auth_required` responses, a local 127.0.0.1 callback server), include a short subsection describing the shape of the response or the steps the user sees. Do not paste internal protocol diagrams.

### Host configuration examples

JSON snippets for the hosts the connector is regularly used with — typically Claude Desktop, Cursor, and any in-house host. One block per host. Use the `npx` form by default and a `node dist/index.js` block for local development.

### Tools

A flat or lightly grouped list of every tool the server exposes, with a one-line description for each. Group by domain (Messages, Channels, Files, …) when the surface is large enough to benefit from grouping; otherwise leave it flat. Annotate destructive or experimental tools (`[EXPERIMENTAL]`, "destructive", "requires `<ENV>` opt-in") inline rather than in a footnote.

### Security notes

Only when the connector has something specific to call out: workspace sandboxing, allow-listed download hosts, untrusted-content envelopes, production-write opt-ins, source-attribution labels on new records, and so on. Cross-link to the repo-root `SECURITY.md` for vulnerability reporting.

If the connector has nothing connector-specific to add beyond what the root `README.md` already covers, omit the section entirely.

### Licence

A single line:

> [FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on YYYY-MM-DD.

## Updating the parent README

The repo-root `README.md` is the first thing most readers see. **Every time a connector is added, removed, or has a meaningful change to its description, the parent README needs to be updated in the same PR.**

There are two pieces to keep in sync.

### 1. The connector table

Add (or update) one row in the `## Connectors` table. The recommended shape is four columns, giving the reader two extra triage signals without losing mobile-friendliness:

```markdown
| Connector | What it does | Auth | Tools |
|-----------|--------------|------|-------|
| [<name>](connectors/<name>/) | <one-line description> | <API key \| OAuth \| …> | <count> |
```

The repo's existing table is two columns (`Connector | Description`); migrating it to four columns is a one-off repo-wide change rather than something to do connector-by-connector. Until that migration lands, follow the existing two-column shape and keep the `Auth` and `Tools` signals in the connector's own Status block. When the migration does land, the four-column rows are filled from each connector's Status block — that's why we keep the same vocabulary in both places.

Conventions:

- **Order alphabetically by connector name.** The table is sorted; keep it sorted.
- **Link target is the directory**, not the README file — `connectors/<name>/` resolves to the README on GitHub and works locally too.
- **Description is one line.** Match the tagline directly under the title in the connector's own README — they should say the same thing in the same words, give or take punctuation.
- **Auth column** uses the same vocabulary as the Status block: *API key*, *OAuth (host-orchestrated)*, *OAuth (local 127.0.0.1 callback)*, *none*. Shorten to *OAuth* in the table when the longer form doesn't fit; keep the full phrase in the connector's Status block.
- **Tools column** is just the count — no parenthetical. Detail belongs in the Status block.

### 2. The description, blended from "what it does" and "why"

The description in the table row is not just a restatement of the package name. It is a short, human-readable sentence that combines:

- **A short overview of what the connector does** — verbs and nouns, the same shape as the connector's tagline.
- **Any genuinely relevant detail from the connector's "Why this exists" section** — but only if it adds something a reader scanning the table would actually want to know.

Aim for a single sentence, around 10–20 words. Plain English. No marketing language, no internal codenames, no acronyms that are not universally understood.

**Examples already in the repo**

| Row | What works |
|-----|------------|
| `office` — *Read and edit Word documents, Excel workbooks, and PowerPoint presentations from desktop Microsoft 365 via an Office Add-in sidecar* | Pulls "desktop" and "Office Add-in sidecar" from the "Why" section — those are the distinguishing facts. |
| `fathom` — *List and search meetings, view details, read transcripts, and manage teams via Fathom AI* | Pure overview — the "Why" details (security review, runs locally) are repo-wide properties, not row-worthy. |
| `browser-automation` — *Headless browser control via accessibility snapshots — navigate, fill forms, click, and screenshot pages via the agent-browser CLI* | Verb list + the unusual mechanism ("accessibility snapshots", "agent-browser CLI") that sets it apart. |

**Anti-patterns to avoid**

- Copy-pasting the whole "Why this exists" paragraph into the table cell. It will not fit and will not scan.
- Marketing adjectives — *"powerful"*, *"comprehensive"*, *"seamless"*. The reader can tell.
- Repeating phrasing that is already implied repo-wide (e.g. "source-available", "MCP server", "local-only") — those are covered by the page around the table.

### How to derive the row

A quick recipe:

1. Start with the tagline directly under the connector title.
2. Read the "Why this exists" section. Pick at most one fact that would change a reader's decision about whether to click the row (the surface area, the deployment shape, the unique mechanism).
3. Rewrite as a single sentence in plain English. If the result is longer than ~20 words or needs a comma-separated list of three or more clauses, trim until it fits.
4. Update the connector's own tagline to match, if you tightened the wording. The table row and the README tagline should not drift.

## Before you open the PR

A short checklist before pushing:

- [ ] One-line description at the top of the connector README matches the row in the root `README.md` table.
- [ ] Italic positioning line sits directly under the description and is under ~25 words.
- [ ] `## Status` block sits directly under the positioning line and lists at least Version, Auth, Tools, Surface, and `Machine-readable: STATUS.json`. Every claim is hyperlinked to its evidence (CHANGELOG, src/tools/, server.json, npm).
- [ ] `connectors/<name>/STATUS.json` exists, was created from `node scripts/init-status.mjs <name>`, has had its `TBD` fields filled in, and `node scripts/check-status.mjs <name>` passes.
- [ ] `## Why this exists` follows the Status block, is 80–150 words, and follows the language guidance above.
- [ ] `## Example interaction` sits directly below "Why this exists", uses the prescribed format, and shows something the connector can actually do today.
- [ ] Header badges total ≤ 3 (npm version, licence, optionally one more).
- [ ] Every env var listed in the README is also declared in `server.json` under `packages[0].environmentVariables`.
- [ ] Tool count in the `## Tools (<n>)` heading and in the Status block both match the number of tools registered in `src/index.ts` (or `src/tools/`).
- [ ] Root `README.md` table contains a row for this connector, alphabetically placed, with a description that blends overview and any row-worthy detail from "Why". If the four-column table is in place, Auth and Tools columns match the Status block.
- [ ] No emojis, no marketing language, no internal codenames, no AI-tool names anywhere in the README.
