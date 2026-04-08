# mcp-servers

Open-source MCP servers by Mindstone. Works with any MCP host — Claude Desktop, Cursor, Rebel, and others.

## Servers

- `connectors/zendesk/` — Zendesk Support (tickets, macros, users, views)

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
