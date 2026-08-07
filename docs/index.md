---
layout: default
title: mcp-servers catalogue
---

# mcp-servers catalogue

A machine-readable index of the [mindstone/mcp-servers](https://github.com/mindstone/mcp-servers) monorepo: 39 source-available MCP servers, audited weekly by the [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/mindstone/mcp-servers).

Each row links to a per-connector page generated from the connector's `STATUS.json`. The data on this site is derived from the source repository on every push to `main` — if it looks stale, the data isn't.

| Connector | What it does | Version | Auth | Tools | Surface |
|-----------|--------------|---------|------|-------|---------|
| [apple-shortcuts](./catalogue/apple-shortcuts.html) | An MCP server that exposes Apple Shortcuts functionality to Rebel via the macOS &#96;shortcuts&#96; CLI. | 0.2.0 | None | 3 | local CLI |
| [browser-automation](./catalogue/browser-automation.html) | Browser control you can watch: open pages, sign in, click around, fill forms, take screenshots, and keep a reusable browser session. | 0.2.0 | None | 21 | browser automation |
| [canary](./catalogue/canary.html) | Mindstone's internal release-pipeline test connector — not for use. It exists only to validate the rebel-oss release pipeline end-to-end. Single &#96;ping&#96; tool; no external dependencies, no auth, no bridge. | 0.0.4 | None | 1 | local protocol |
| [elevenlabs](./catalogue/elevenlabs.html) | ElevenLabs MCP server for Model Context Protocol hosts. Generate speech, music, and sound effects, browse voices, and transcribe audio using the ElevenLabs API through a standardised MCP interface. | 0.5.0 | API key | 32 | cloud API |
| [elevenlabs-agents](./catalogue/elevenlabs-agents.html) | ElevenLabs Conversational AI MCP server for Model Context Protocol hosts. Inspect and author voice agents, review conversation transcripts and recordings, manage phone-number assignments, place outbound calls, submit or monitor scheduled batch calls, and write to the knowledge base through the ElevenLabs ConvAI API. | 0.2.0 | API key | 31 | cloud API |
| [email-imap](./catalogue/email-imap.html) | Email IMAP/SMTP MCP server for Model Context Protocol hosts. Read, search, send, and manage emails through IMAP and SMTP — supports iCloud Mail, Gmail, Yahoo Mail, Outlook / Microsoft 365, and custom IMAP providers. | 0.3.0 | API key | 17 | local protocol |
| [fathom](./catalogue/fathom.html) | List and search meetings, view details, read transcripts, and manage teams via Fathom AI. | 0.3.0 | API key | 12 | cloud API |
| [freshdesk](./catalogue/freshdesk.html) | Freshdesk Support MCP server for Model Context Protocol hosts. Manage helpdesk tickets, search and filter support requests, reply to customers, add internal notes, and configure Freshdesk accounts — all through a standardised MCP interface. | 0.2.2 | API key | 20 | cloud API |
| [gamma](./catalogue/gamma.html) | Gamma MCP server for creating Gamma presentations, documents, webpages, and social posts, listing themes and folders, and polling async generation/export status. | 0.4.0 | API key | 6 | cloud API |
| [google-analytics](./catalogue/google-analytics.html) | Google Analytics 4 MCP server for Model Context Protocol hosts. Discover account/property structure, explore the live schema, run reports &#40;with row-volume safety&#41;, create large asynchronous exports, and inspect admin configuration through a standardised MCP interface. | 0.1.1 | OAuth | 34 | cloud API |
| [hubspot](./catalogue/hubspot.html) | HubSpot MCP server for CRM operations &#40;contacts, companies, deals, tickets, leads, tasks, notes, associations&#41;, properties and owners, marketing/lists, workflows, knowledge base lookups, and file operations. | 0.4.0 | OAuth (host-orchestrated) | 106 | cloud API |
| [humaans](./catalogue/humaans.html) | Humaans HR platform MCP server for Model Context Protocol hosts. Query employee profiles, job roles, time-away requests, company info, and office locations through a standardised MCP interface. | 0.2.2 | API key | 16 | cloud API |
| [kling](./catalogue/kling.html) | Kling AI video and image generation MCP server for Model Context Protocol hosts. Generate AI videos from text or images, extend them, add lip-sync, generate images, and manage generation tasks through a standardised MCP interface. | 0.4.0 | API key | 10 | cloud API |
| [microsoft-calendar](./catalogue/microsoft-calendar.html) | Microsoft 365 Outlook Calendar MCP server — list, get, create, update, delete, cancel, and respond to events, check free/busy, find meeting times, and list calendars via the Microsoft Graph API. | 0.2.0 | OAuth (host-orchestrated) | 10 | cloud API |
| [microsoft-files](./catalogue/microsoft-files.html) | Microsoft 365 OneDrive Files MCP server — list, search, get, download, upload, delete, move, copy, share files, manage sharing permissions and version history, review file activity, and read text and Office document contents via the Microsoft Graph API. | 0.2.0 | OAuth (host-orchestrated) | 20 | cloud API |
| [microsoft-mail](./catalogue/microsoft-mail.html) | Microsoft 365 Outlook Mail MCP server — list, search, read, send, reply, forward, draft, move, and delete email, download attachments, read threads, triage &#40;read/flag&#41;, and manage out-of-office replies via the Microsoft Graph API. | 0.3.0 | OAuth (host-orchestrated) | 22 | cloud API |
| [microsoft-sharepoint](./catalogue/microsoft-sharepoint.html) | Microsoft 365 SharePoint MCP server — discover sites, browse document libraries, read pages and lists, search content, and perform SharePoint file/list mutations via the Microsoft Graph API. | 0.2.0 | OAuth (host-orchestrated) | 46 | cloud API |
| [microsoft-teams](./catalogue/microsoft-teams.html) | Microsoft 365 Teams MCP server — list and read Teams chats and channel messages, send messages and replies, start new chats, look up colleagues, search messages, and read or set presence via the Microsoft Graph API. | 0.3.0 | OAuth (host-orchestrated) | 17 | cloud API |
| [mixmax](./catalogue/mixmax.html) | Mixmax email productivity MCP server for Model Context Protocol hosts. Manage sequences, send tracked emails, use email templates &#40;snippets&#41;, view meeting links, recall scheduled sends, and pull engagement analytics through a standardised MCP interface. | 0.3.0 | API key | 13 | cloud API |
| [nano-banana](./catalogue/nano-banana.html) | Nano Banana MCP server — Google Gemini image generation and editing via Model Context Protocol. Generate images from text descriptions and edit existing images using Google Gemini's AI capabilities. | 0.4.0 | API key | 3 | cloud API |
| [napkin](./catalogue/napkin.html) | Napkin AI visual generation MCP server for Model Context Protocol hosts. Generate professional visuals — diagrams, infographics, and illustrations — from text descriptions, check generation status, and download results through a standardised MCP interface. | 0.3.2 | API key | 5 | cloud API |
| [office](./catalogue/office.html) | Read and edit Word documents, Excel workbooks, and PowerPoint presentations from desktop Microsoft 365 via an Office Add-in sidecar. | 0.2.0 | None | 62 | desktop add-in |
| [openai-image](./catalogue/openai-image.html) | OpenAI image generation MCP server — text-to-image and image edits via OpenAI's &#96;gpt-image-2&#96;, with sharp text rendering, multilingual prompts, four quality levels, and three aspect ratios. | 0.2.0 | API key | 2 | cloud API |
| [opus-video-clip](./catalogue/opus-video-clip.html) | OpusClip MCP server for Model Context Protocol hosts. Turn long-form videos into short clips, manage projects, collections, censor jobs, and scheduled social posts through the OpusClip API. | 0.1.0 | API key | 22 | cloud API |
| [outreach](./catalogue/outreach.html) | Outreach sales engagement MCP server — prospects, sequences, accounts, tasks, and mailings via Outreach API. | 0.1.3 | OAuth (local 127.0.0.1 callback) | 22 | cloud API |
| [pandadoc](./catalogue/pandadoc.html) | PandaDoc document automation MCP server for Model Context Protocol hosts. Create, send, and manage documents, templates, and e-signatures through a standardised MCP interface. | 0.3.0 | API key | 15 | cloud API |
| [quickbooks](./catalogue/quickbooks.html) | QuickBooks Online MCP server for Model Context Protocol hosts. Manage invoices, bills, customers, vendors, employees, and accounts in QuickBooks Online through a standardised MCP interface. | 0.3.1 | OAuth | 21 | cloud API |
| [replit-ssh](./catalogue/replit-ssh.html) | Replit SSH MCP server — read, write, list, search, stat, move, and delete files on Replit projects over SSH/SFTP, plus one-shot generation of the local SSH key and &#96;~/.ssh/config&#96; block. | 0.1.2 | None | 9 | local protocol |
| [retell-ai](./catalogue/retell-ai.html) | Voice agent phone calls, batch calling campaigns, call management, agent configuration, LLM prompt management, knowledge bases, chat history, and voice discovery via &#91;Retell AI&#93;&#40;https://www.retellai.com/&#41; API. | 0.3.0 | API key | 32 | cloud API |
| [runway](./catalogue/runway.html) | Runway ML MCP server for Model Context Protocol hosts. Generate AI video, images, audio, speech, sound effects, and manage custom voices — all through a standardised MCP interface powered by Runway's generative AI models. | 0.4.0 | API key | 23 | cloud API |
| [salesforce](./catalogue/salesforce.html) | Salesforce CRM MCP server — accounts, contacts, opportunities, leads, tasks, users, and custom objects via the Salesforce API. | 0.2.0 | OAuth (local 127.0.0.1 callback) | 37 | cloud API |
| [servicenow](./catalogue/servicenow.html) | ServiceNow ITSM MCP server for Model Context Protocol hosts. Manage incidents, change requests, users, and knowledge base articles in ServiceNow through a standardised MCP interface. | 0.3.0 | Hybrid | 13 | cloud API |
| [slack](./catalogue/slack.html) | Slack workspace MCP server — channels, messages, threads, reactions, users, files, bookmarks, and scheduled messages via the Slack Web API. | 0.3.0 | OAuth (host-orchestrated) | 39 | cloud API |
| [talentlms](./catalogue/talentlms.html) | TalentLMS MCP server for Model Context Protocol hosts. Manage users, courses, groups, branches, categories, enrolments, reporting, and assessments in TalentLMS through a standardised MCP interface. | 0.4.0 | API key | 28 | cloud API |
| [vanta](./catalogue/vanta.html) | Vanta compliance MCP server — read and write vulnerabilities, tests, controls, people, vendors, documents, and compliance summaries via the Vanta API. | 0.3.0 | OAuth | 25 | cloud API |
| [wise](./catalogue/wise.html) | Wise &#40;formerly TransferWise&#41; MCP server for Model Context Protocol hosts. Check multi-currency balances and exchange rates, review transactions and activity, manage recipients, price transfers with quotes — and, with an explicit opt-in, create, fund, and cancel transfers — all through a standardised MCP interface. | 0.1.0 | API key | 17 | cloud API |
| [workday](./catalogue/workday.html) | Workday HCM MCP server for Model Context Protocol hosts. Query workers, profiles, direct reports, organizations, locations, jobs, time off, and job requisitions in Workday through a standardised MCP interface using OAuth 2.0 authentication. | 0.2.2 | OAuth | 9 | cloud API |
| [xero](./catalogue/xero.html) | This is a Model Context Protocol &#40;MCP&#41; server implementation for Xero. It provides a bridge between the MCP protocol and Xero's API, allowing for standardized access to Xero's accounting and business features. | 0.0.17 | OAuth | 70 | cloud API |
| [zendesk](./catalogue/zendesk.html) | Zendesk Support MCP server — tickets, users, comments, macros, account setup, and support-workflow discovery through a standard stdio MCP package. | 0.4.0 | Hybrid | 26 | cloud API |

## How this catalogue is built

- The source of truth for each row is `connectors/<name>/STATUS.json` in the repo. The file is validated by `scripts/check-status.mjs` on every PR.
- This page is regenerated from those JSON files by `scripts/build-catalogue.mjs` and published via GitHub Pages. The generator is read-only — it never modifies a connector directory.
- Connectors without a `STATUS.json` yet are listed with derived data from `package.json` and `server.json`; their per-connector pages are marked `status: pending`.

## See also

- [Repository on GitHub](https://github.com/mindstone/mcp-servers)
- [Security policy](https://github.com/mindstone/mcp-servers/blob/main/SECURITY.md)
- [Migration guide for the `@mindstone-engineering/` → `@mindstone/` scope change](https://github.com/mindstone/mcp-servers/blob/main/MIGRATION.md)
- [Connector README guide](https://github.com/mindstone/mcp-servers/blob/main/docs/CONNECTOR_README_GUIDE.md)
