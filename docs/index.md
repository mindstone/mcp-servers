---
layout: default
title: mcp-servers catalogue
---

# mcp-servers catalogue

A machine-readable index of the [mindstone/mcp-servers](https://github.com/mindstone/mcp-servers) monorepo: 28 source-available MCP servers, audited weekly by the [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/mindstone/mcp-servers).

Each row links to a per-connector page generated from the connector's `STATUS.json`. The data on this site is derived from the source repository on every push to `main` — if it looks stale, the data isn't.

| Connector | What it does | Version | Auth | Tools | Surface |
|-----------|--------------|---------|------|-------|---------|
| [apple-shortcuts](./catalogue/apple-shortcuts.html) | An MCP server that exposes Apple Shortcuts functionality to Rebel via the macOS &#96;shortcuts&#96; CLI. | 0.1.2 | None | 2 | local CLI |
| [browser-automation](./catalogue/browser-automation.html) | Headless browser control via accessibility snapshots — navigate pages, fill forms, click elements, take screenshots, and manage tabs using the &#91;agent-browser&#93;&#40;https://www.npmjs.com/package/agent-browser&#41; CLI. | 0.1.7 | None | 18 | browser automation |
| [elevenlabs](./catalogue/elevenlabs.html) | ElevenLabs MCP server for Model Context Protocol hosts. Generate speech, music, and sound effects, browse voices, and transcribe audio using the ElevenLabs API through a standardised MCP interface. | 0.2.2 | API key | 8 | cloud API |
| [email-imap](./catalogue/email-imap.html) | Email IMAP/SMTP MCP server for Model Context Protocol hosts. Read, search, send, and manage emails through IMAP and SMTP — supports iCloud Mail, Gmail, Yahoo Mail, Outlook / Microsoft 365, and custom IMAP providers. | 0.2.3 | API key | 9 | local protocol |
| [fathom](./catalogue/fathom.html) | List and search meetings, view details, read transcripts, and manage teams via Fathom AI. | 0.2.3 | API key | 7 | cloud API |
| [freshdesk](./catalogue/freshdesk.html) | Freshdesk Support MCP server for Model Context Protocol hosts. Manage helpdesk tickets, search and filter support requests, reply to customers, add internal notes, and configure Freshdesk accounts — all through a standardised MCP interface. | 0.2.2 | API key | 11 | cloud API |
| [gamma](./catalogue/gamma.html) | Gamma AI presentation generation MCP server for Model Context Protocol hosts. Create AI-powered presentations, documents, webpages, and social posts, manage themes and folders, and export content through a standardised MCP interface. | 0.3.2 | API key | 6 | cloud API |
| [google-analytics](./catalogue/google-analytics.html) | Google Analytics 4 MCP server for Model Context Protocol hosts. Discover account/property structure, explore the live schema, run reports &#40;with row-volume safety&#41;, and inspect admin configuration through a standardised MCP interface. | 0.1.1 | OAuth | 25 | cloud API |
| [hubspot](./catalogue/hubspot.html) | HubSpot MCP server for CRM operations &#40;contacts, companies, deals, tickets, leads, tasks, notes, associations&#41;, properties and owners, marketing/lists, workflows, knowledge base lookups, and file operations. | 0.1.2 | OAuth (host-orchestrated) | 92 | cloud API |
| [humaans](./catalogue/humaans.html) | Humaans HR platform MCP server for Model Context Protocol hosts. Query employee profiles, job roles, time-away requests, company info, and office locations through a standardised MCP interface. | 0.2.2 | API key | 11 | cloud API |
| [kling](./catalogue/kling.html) | Kling AI video generation MCP server for Model Context Protocol hosts. Generate AI videos from text descriptions or images, and manage video generation tasks through a standardised MCP interface. | 0.3.2 | API key | 4 | cloud API |
| [mixmax](./catalogue/mixmax.html) | Mixmax email productivity MCP server for Model Context Protocol hosts. Manage sequences, send tracked emails, use email templates &#40;snippets&#41;, view meeting links, and monitor message engagement through a standardised MCP interface. | 0.2.2 | API key | 10 | cloud API |
| [nano-banana](./catalogue/nano-banana.html) | Nano Banana MCP server — Google Gemini image generation and editing via Model Context Protocol. Generate images from text descriptions and edit existing images using Google Gemini's AI capabilities. | 0.3.2 | API key | 3 | cloud API |
| [napkin](./catalogue/napkin.html) | Napkin AI visual generation MCP server for Model Context Protocol hosts. Generate professional visuals — diagrams, infographics, and illustrations — from text descriptions, check generation status, and download results through a standardised MCP interface. | 0.3.2 | API key | 4 | cloud API |
| [office](./catalogue/office.html) | Read and edit Word documents, Excel workbooks, and PowerPoint presentations from desktop Microsoft 365 via an Office Add-in sidecar. | 0.1.4 | None | 53 | desktop add-in |
| [openai-image](./catalogue/openai-image.html) | OpenAI image generation MCP server for Model Context Protocol hosts. Generate and edit images via OpenAI's &#96;gpt-image-2&#96; model — sharp text rendering, multilingual support, four quality levels, three aspect ratios — through a standardised MCP interface. | 0.1.1 | API key | 2 | cloud API |
| [outreach](./catalogue/outreach.html) | Outreach sales engagement MCP server — prospects, sequences, accounts, tasks, and mailings via Outreach API. | 0.1.3 | OAuth (local 127.0.0.1 callback) | 15 | cloud API |
| [pandadoc](./catalogue/pandadoc.html) | PandaDoc document automation MCP server for Model Context Protocol hosts. Create, send, and manage documents, templates, and e-signatures through a standardised MCP interface. | 0.2.2 | API key | 9 | cloud API |
| [quickbooks](./catalogue/quickbooks.html) | QuickBooks Online MCP server for Model Context Protocol hosts. Manage invoices, bills, customers, vendors, employees, and accounts in QuickBooks Online through a standardised MCP interface. | 0.3.1 | OAuth | 13 | cloud API |
| [retell-ai](./catalogue/retell-ai.html) | Voice agent phone calls, call management, agent configuration, LLM prompt management, and voice discovery via &#91;Retell AI&#93;&#40;https://www.retellai.com/&#41; API. | 0.2.1 | API key | 20 | cloud API |
| [runway](./catalogue/runway.html) | Runway ML MCP server for Model Context Protocol hosts. Generate AI video, images, audio, speech, sound effects, and manage custom voices — all through a standardised MCP interface powered by Runway's generative AI models. | 0.3.2 | API key | 22 | cloud API |
| [salesforce](./catalogue/salesforce.html) | Salesforce CRM MCP server — accounts, contacts, opportunities, leads, tasks, users, and custom objects via the Salesforce API. | 0.1.2 | OAuth (local 127.0.0.1 callback) | 26 | cloud API |
| [servicenow](./catalogue/servicenow.html) | ServiceNow ITSM MCP server for Model Context Protocol hosts. Manage incidents, change requests, users, and knowledge base articles in ServiceNow through a standardised MCP interface. | 0.2.2 | Basic auth | 10 | cloud API |
| [slack](./catalogue/slack.html) | Slack workspace MCP server — channels, messages, threads, reactions, users, files, bookmarks, and scheduled messages via the Slack Web API. | 0.1.2 | OAuth (host-orchestrated) | 23 | cloud API |
| [talentlms](./catalogue/talentlms.html) | TalentLMS MCP server for Model Context Protocol hosts. Manage users, courses, groups, branches, enrolments, reporting, and assessments in TalentLMS through a standardised MCP interface. | 0.2.2 | API key | 24 | cloud API |
| [vanta](./catalogue/vanta.html) | Vanta compliance MCP server — read and write vulnerabilities, tests, controls, evidence, resources, people, vendors, and compliance summaries via the Vanta API. | 0.1.0 | OAuth | 18 | cloud API |
| [workday](./catalogue/workday.html) | Workday HCM MCP server for Model Context Protocol hosts. Query workers, profiles, and organizations in Workday through a standardised MCP interface using OAuth 2.0 authentication. | 0.2.2 | OAuth | 4 | cloud API |
| [zendesk](./catalogue/zendesk.html) | Zendesk Support MCP server for Model Context Protocol hosts. | 0.3.2 | Hybrid | 20 | cloud API |

## How this catalogue is built

- The source of truth for each row is `connectors/<name>/STATUS.json` in the repo. The file is validated by `scripts/check-status.mjs` on every PR.
- This page is regenerated from those JSON files by `scripts/build-catalogue.mjs` and published via GitHub Pages. The generator is read-only — it never modifies a connector directory.
- Connectors without a `STATUS.json` yet are listed with derived data from `package.json` and `server.json`; their per-connector pages are marked `status: pending`.

## See also

- [Repository on GitHub](https://github.com/mindstone/mcp-servers)
- [Security policy](https://github.com/mindstone/mcp-servers/blob/main/SECURITY.md)
- [Migration guide for the `@mindstone-engineering/` → `@mindstone/` scope change](https://github.com/mindstone/mcp-servers/blob/main/MIGRATION.md)
- [Connector README guide](https://github.com/mindstone/mcp-servers/blob/main/docs/CONNECTOR_README_GUIDE.md)
