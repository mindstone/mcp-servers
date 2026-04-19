# mcp-servers

Source-available MCP servers by Mindstone. Works with any MCP host — Claude Desktop, Cursor, Rebel, and others.

## Connectors

| Connector | Description |
|-----------|-------------|
| [elevenlabs](connectors/elevenlabs/) | Generate speech, music, and sound effects, browse voices, and transcribe audio via the ElevenLabs API |
| [email-imap](connectors/email-imap/) | Read, search, send, and manage emails through IMAP and SMTP |
| [fathom](connectors/fathom/) | List and search meetings, view details, read transcripts, and manage teams via Fathom AI |
| [freshdesk](connectors/freshdesk/) | Manage helpdesk tickets, search support requests, reply to customers, and add internal notes |
| [gamma](connectors/gamma/) | Create AI-powered presentations, documents, webpages, and social posts via Gamma |
| [humaans](connectors/humaans/) | Query employee profiles, job roles, time-away requests, and company info via Humaans HR |
| [kling](connectors/kling/) | Generate AI videos from text descriptions or images via Kling AI |
| [mixmax](connectors/mixmax/) | Manage sequences, send tracked emails, use templates, and monitor engagement via Mixmax |
| [nano-banana](connectors/nano-banana/) | Generate and edit images using Google Gemini's AI capabilities |
| [napkin](connectors/napkin/) | Generate professional visuals — diagrams, infographics, and illustrations — from text via Napkin AI |
| [pandadoc](connectors/pandadoc/) | Create, send, and manage documents, templates, and e-signatures via PandaDoc |
| [quickbooks](connectors/quickbooks/) | Manage invoices, bills, customers, vendors, employees, and accounts in QuickBooks Online |
| [runway](connectors/runway/) | Generate AI video, images, audio, speech, and sound effects via Runway ML |
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
npx -y @mindstone-engineering/mcp-server-zendesk
```

See each server's README for configuration and host setup instructions.

## Security

To report a vulnerability, please see [SECURITY.md](SECURITY.md).

## Licence

Each connector is licensed under [FSL-1.1-MIT](https://fsl.software/FSL-1.1-MIT.template.md) — see the LICENSE file in each connector directory for details.
