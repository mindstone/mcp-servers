# mcp-servers

Source-available MCP servers by Mindstone. Works with any MCP host — Claude Desktop, Cursor, Rebel, and others.

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
| [humaans](connectors/humaans/) | Query employee profiles, job roles, time-away requests, and company info via Humaans HR |
| [kling](connectors/kling/) | Generate AI videos from text descriptions or images via Kling AI |
| [mixmax](connectors/mixmax/) | Manage sequences, send tracked emails, use templates, and monitor engagement via Mixmax |
| [nano-banana](connectors/nano-banana/) | Generate and edit images using Google Gemini's AI capabilities |
| [napkin](connectors/napkin/) | Generate professional visuals — diagrams, infographics, and illustrations — from text via Napkin AI |
| [office](connectors/office/) | Read and edit Word documents, Excel workbooks, and PowerPoint presentations from desktop Microsoft 365 via an Office Add-in sidecar |
| [openai-image](connectors/openai-image/) | Generate and edit images via OpenAI's `gpt-image-2` — sharp text rendering, multilingual support, and four quality levels |
| [outreach](connectors/outreach/) | Manage prospects, sequences, accounts, tasks, and mailings via the Outreach sales engagement API |
| [pandadoc](connectors/pandadoc/) | Create, send, and manage documents, templates, and e-signatures via PandaDoc |
| [quickbooks](connectors/quickbooks/) | Manage invoices, bills, customers, vendors, employees, and accounts in QuickBooks Online |
| [retell-ai](connectors/retell-ai/) | Place voice-agent phone calls, manage agents and LLM prompts, and discover voices via the Retell AI API |
| [runway](connectors/runway/) | Generate AI video, images, audio, speech, and sound effects via Runway ML |
| [salesforce](connectors/salesforce/) | Manage accounts, contacts, opportunities, leads, tasks, users, and custom objects via the Salesforce API |
| [servicenow](connectors/servicenow/) | Manage incidents, change requests, users, and knowledge base articles in ServiceNow |
| [talentlms](connectors/talentlms/) | Manage users, courses, groups, branches, enrolments, and assessments in TalentLMS |
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

See each server's README for configuration and host setup instructions. Some connectors require additional environment variables to opt into specific behaviour (e.g. `QB_ALLOW_PROD_WRITES` for QuickBooks production writes, `MCP_WORKSPACE_PATH` for sandboxed file reads, `BROWSER_AUTOMATION_ALLOW_EVAL` for browser-automation script eval) — see the per-connector READMEs for the full list.

## Security & Hardening

This monorepo follows a defence-in-depth posture for tool-call hosts. Highlights include:

- **Workflow safety.** GitHub Actions workflows are env-fy'd against script injection (CWE-94), every action is pinned to a commit SHA (kept current by Dependabot), and each job is granted a least-privilege `permissions:` block. Publish is split into a build job (does the install/test/pack with no publish credentials) and a publish job (downloads the packed tarball, runs only `npm publish --ignore-scripts --provenance` under OIDC trusted publishing, gated by the `npm-publish` environment). The publish job invokes NO third-party JS — `tsc`, `vitest`, lifecycle scripts, etc. all run upstream, away from `id-token: write`. See [docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md](docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md) for the supply-chain threat model and [docs/security/BRANCH_PROTECTION.md](docs/security/BRANCH_PROTECTION.md) for required GitHub settings.
- **Release-age cool-down.** The repo-level `.npmrc` sets `min-release-age=7` (days), so CI refuses to install dependency versions published in the last week. This blocks the "same-day malicious re-publish" path that ships post-`npm audit`-clean PRs into a release tag.

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

## Licence

Each connector is licensed under [FSL-1.1-MIT](https://fsl.software/FSL-1.1-MIT.template.md) — see the LICENSE file in each connector directory for details.
