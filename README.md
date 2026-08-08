<p align="center">
  <img src="docs/assets/rogue.svg" alt="Rogue, the Rebel character for safe action and control" width="112" />
</p>

# mcp-servers

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mindstone/mcp-servers/badge)](https://scorecard.dev/viewer/?uri=github.com/mindstone/mcp-servers)

Source-available MCP servers by Mindstone. Works with any MCP host — Claude Desktop, Cursor, Rebel, and others.

Browse all 35 connectors with their version, auth model, and tool count at the [catalogue site](https://mindstone.github.io/mcp-servers/) (regenerated from each connector's `STATUS.json` on every push).

## Connectors

| Connector | Description |
|-----------|-------------|
| [apple-shortcuts](connectors/apple-shortcuts/) | Run and list Apple Shortcuts on macOS via the `shortcuts` CLI |
| [browser-automation](connectors/browser-automation/) | Headless browser control via accessibility snapshots — navigate, fill forms, click, and screenshot pages via the agent-browser CLI |
| [elevenlabs](connectors/elevenlabs/) | Generate speech, music, and sound effects, browse voices, and transcribe audio via the ElevenLabs API |
| [email-imap](connectors/email-imap/) | Read, search, send, and manage emails through IMAP and SMTP |
| [fathom](connectors/fathom/) | List and search meetings, view details, read transcripts, and manage teams via Fathom AI |
| [freshdesk](connectors/freshdesk/) | Manage helpdesk tickets, search support requests, reply to customers, and add internal notes |
| [gamma](connectors/gamma/) | Create AI-powered presentations, documents, webpages, and social posts via Gamma |
| [google-analytics](connectors/google-analytics/) | Discover GA4 accounts and properties, explore the live schema, and run reports via the Google Analytics API |
| [google-workspace](connectors/google-workspace/) | Read, search, and send across Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, and Comments with host-orchestrated OAuth and per-account on-disk credentials |
| [hubspot](connectors/hubspot/) | Manage HubSpot CRM — contacts, companies, deals, tickets, leads, tasks, notes, properties, lists, workflows, knowledge base, and files — with multi-account, host-orchestrated OAuth |
| [humaans](connectors/humaans/) | Query employee profiles, job roles, time-away requests, and company info via Humaans HR |
| [kling](connectors/kling/) | Generate AI videos from text descriptions or images via Kling AI |
| [microsoft-calendar](connectors/microsoft-calendar/) | List, create, update, and respond to Outlook calendar events, check free/busy, and list calendars; reuses the cohort's host-orchestrated Microsoft 365 OAuth surface |
| [microsoft-files](connectors/microsoft-files/) | List, search, upload, download, share, and read OneDrive files via Microsoft Graph; reuses the cohort's host-orchestrated Microsoft 365 OAuth surface |
| [microsoft-mail](connectors/microsoft-mail/) | List, search, read, send, reply, forward, draft, move, and delete Outlook email; owns the cohort's host-orchestrated Microsoft 365 OAuth surface |
| [microsoft-sharepoint](connectors/microsoft-sharepoint/) | Discover sites, browse libraries, read pages and lists, search content, and mutate SharePoint files/lists with incremental Sites.Read.All consent |
| [microsoft-teams](connectors/microsoft-teams/) | List and read Teams chats, send chat messages, list teams and channels, and read presence; reuses the cohort's host-orchestrated Microsoft 365 OAuth surface |
| [mixmax](connectors/mixmax/) | Manage sequences, send tracked emails, use templates, and monitor engagement via Mixmax |
| [nano-banana](connectors/nano-banana/) | Generate and edit images using Google Gemini's AI capabilities |
| [napkin](connectors/napkin/) | Generate professional visuals — diagrams, infographics, and illustrations — from text via Napkin AI |
| [office](connectors/office/) | Read and edit Word documents, Excel workbooks, and PowerPoint presentations from desktop Microsoft 365 via an Office Add-in sidecar |
| [openai-image](connectors/openai-image/) | Generate and edit images via OpenAI's `gpt-image-2` — sharp text rendering, multilingual support, and four quality levels |
| [outreach](connectors/outreach/) | Manage prospects, sequences, accounts, tasks, and mailings via the Outreach sales engagement API |
| [pandadoc](connectors/pandadoc/) | Create, send, and manage documents, templates, and e-signatures via PandaDoc |
| [quickbooks](connectors/quickbooks/) | Manage invoices, bills, customers, vendors, employees, and accounts in QuickBooks Online |
| [replit-ssh](connectors/replit-ssh/) | Read, write, list, and check files on Replit projects over SSH/SFTP, with one-shot SSH key + config setup on the operator's machine |
| [retell-ai](connectors/retell-ai/) | Place voice-agent phone calls, manage agents and LLM prompts, and discover voices via the Retell AI API |
| [runway](connectors/runway/) | Generate AI video, images, audio, speech, and sound effects via Runway ML |
| [salesforce](connectors/salesforce/) | Manage accounts, contacts, opportunities, leads, tasks, users, and custom objects via the Salesforce API |
| [servicenow](connectors/servicenow/) | Manage incidents, change requests, users, and knowledge base articles in ServiceNow |
| [slack](connectors/slack/) | Multi-workspace Slack — channels, messages, threads, reactions, users, files, bookmarks, and scheduled messages via the Slack Web API, with host-orchestrated OAuth |
| [talentlms](connectors/talentlms/) | Manage users, courses, groups, branches, enrolments, and assessments in TalentLMS |
| [vanta](connectors/vanta/) | Read and manage compliance posture in Vanta — vulnerabilities, tests, controls, evidence, resources, people, vendors, documents, and compliance summary |
| [workday](connectors/workday/) | Query workers, profiles, and organizations in Workday HCM |
| [zendesk](connectors/zendesk/) | Manage tickets, macros, users, and views in Zendesk Support |

## Quick Start

Each server builds independently:
```bash
cd connectors/<name>
npm install
npm run build
```

Or run directly via npx (once published):
```bash
npx -y @mindstone/mcp-server-zendesk
```

> **Moving from `@mindstone-engineering/`?** Every server has been republished under the shorter `@mindstone/` npm scope. The legacy `@mindstone-engineering/mcp-server-*` packages still install but are marked deprecated. See [MIGRATION.md](MIGRATION.md) for the consumer one-liner and the deprecation timeline.

See each server's README for configuration and host setup instructions. Some connectors require additional environment variables to opt into specific behaviour (e.g. `QB_ALLOW_PROD_WRITES` for QuickBooks production writes, `MCP_WORKSPACE_PATH` for sandboxed file reads) — see the per-connector READMEs for the full list.

## Security & Hardening

This monorepo follows a defence-in-depth posture for tool-call hosts. Highlights include:

- **Workflow safety.** GitHub Actions workflows are env-fy'd against script injection (CWE-94), every action is pinned to a commit SHA (kept current by Dependabot), and each job is granted a least-privilege `permissions:` block. Publish is split into a build job (does the install/test/pack with no publish credentials) and a publish job (downloads the packed tarball, runs only `npm publish --ignore-scripts --provenance` under OIDC trusted publishing, gated by the `npm-publish` environment). The publish job invokes NO third-party JS — `tsc`, `vitest`, lifecycle scripts, etc. all run upstream, away from `id-token: write`. See [docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md](docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md) for the supply-chain threat model and [docs/security/BRANCH_PROTECTION.md](docs/security/BRANCH_PROTECTION.md) for required GitHub settings.
- **Release-age cool-down.** The repo-level `.npmrc` sets `min-release-age=7` (days), so CI refuses to install dependency versions published in the last week. This blocks the "same-day malicious re-publish" path that ships post-`npm audit`-clean PRs into a release tag.
- **Provenance-attested releases.** Releases are published by CI (`.github/workflows/release.yml`) under the `@mindstone/` npm scope via Trusted Publishing OIDC — no long-lived npm token exists anywhere — with `--provenance` Sigstore attestations consumers can verify via `npm audit signatures`. Every publishable release commit must carry a `Release-Gate` trailer pointing at its pre-release security review, and every publish posts an alert; the full gate chain is in [docs/PUBLISH_APPROVAL_PROCESS.md](docs/PUBLISH_APPROVAL_PROCESS.md). (Only a brand-new connector's *first* publish is manual and WebAuthn-gated; those tarballs carry no provenance attestation but remain shasum-verifiable — check out the release commit and run `npm pack`; see [MIGRATION.md](MIGRATION.md#what-you-get-on-the-new-scope).)
- **OpenSSF Scorecard.** The repo runs the [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/mindstone/mcp-servers) weekly via `.github/workflows/scorecard.yml`. The report is generated by a third party from the source tree, so every claim above (action pinning, branch protection, token usage, dependency hygiene) is independently checked rather than just asserted here. The current score is shown by the badge at the top of this README.

### Recommendations for consumers

These connectors are published as plain npm packages. The strongest single thing you can do to protect yourself from a future supply-chain compromise of *any* npm package (these or otherwise) is to use a client that does not run lifecycle scripts by default:

- **pnpm** (`pnpm install` / `pnpm dlx`) — does not execute `postinstall`/`prepare` hooks unless explicitly allowlisted via `onlyBuiltDependencies`. pnpm v11+ also defaults to a 24-hour `minimumReleaseAge` cool-down.
- **bun** (`bunx`) — same default, no lifecycle scripts unless allowlisted.
- **npm** — if you must use npm, set `min-release-age=7` and `ignore-scripts=true` in your global `~/.npmrc`. Requires npm v11.10+ for `min-release-age`.

None of our published packages need `postinstall` to function, so disabling lifecycle scripts in your installer of choice is safe.
- **Untrusted-content envelopes.** External content from email, helpdesk, and ticketing systems (email-imap, freshdesk, zendesk) is wrapped in `<untrusted-content source="...">` envelopes with close-tag breakout escaping, so an LLM host can recognise and refuse instruction-injection attempts.
- **Workspace sandboxing.** File-uploading connectors (nano-banana, pandadoc, elevenlabs) constrain reads to `MCP_WORKSPACE_PATH` (or `os.tmpdir()`) with canonical-prefix containment that handles symlinked roots like `/tmp` → `/private/tmp`.
- **Secure-by-default writes.** Production-impacting writes (QuickBooks invoices/bills/customers/vendors) require an explicit `QB_ALLOW_PROD_WRITES=1` opt-in env var; outreach prospect-enrolment and mixmax sequence-recipient tools carry `destructiveHint: true` so hosts surface confirmation prompts.
- **SSRF & path traversal.** Download connectors (napkin, runway) enforce host allow-lists, manual-redirect handling, and symlink-safe write paths under a configurable root.
- **Loopback OAuth bind.** Connectors with local OAuth callback servers (salesforce, outreach) hard-code 127.0.0.1, ignoring any `MCP_OAUTH_BIND_HOST` override.
- **E.164 validation.** Outbound phone-call tools (retell-ai) reject non-E.164 numbers before any upstream API call.

For per-connector security notes, see each connector's README.

To report a vulnerability, please see [SECURITY.md](SECURITY.md).

## The Mindstone open-source family

This repo is one of several open-source projects from Mindstone:

- [Rebel](https://mindstone.com) — the AI workspace desktop app that ships these
  connectors out of the box (source release in progress).
- [Super-MCP](https://github.com/mindstone/Super-MCP) — a proxy MCP router that
  loads only the tools you actually need, saving your context window.
- [rebel-system](https://github.com/mindstone/rebel-system-oss) — the public
  Rebel system: skills, prompts, operators, help docs, and templates.
- [meeting-note-recorder](https://github.com/mindstone/meeting-note-recorder)
  — meeting detection, recording, and live transcripts (the Rebel note-taker).

## Licence

Each connector is licensed under [FSL-1.1-MIT](https://fsl.software/FSL-1.1-MIT.template.md) — see the LICENSE file in each connector directory for details.
