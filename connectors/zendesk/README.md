# @harryjbloom18/mcp-server-zendesk

Zendesk Support MCP server for hosts that can launch stdio-based MCP connectors.

## Requirements

- Node.js 18+
- npm

## Build

```bash
cd <path-to-repo>/connectors/zendesk
npm install
npm run bundle
```

Build output:

- `dist/server.cjs`
- `dist/manifest.json`

## Configuration

### Supported environment variables

- `ZENDESK_CONFIG_PATH` — path to the config directory that contains `accounts.json` and `credentials/`
- `ZENDESK_CLIENT_ID` — optional OAuth client ID for legacy token refresh flows
- `ZENDESK_CLIENT_SECRET` — optional OAuth client secret for legacy token refresh flows
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

### Standalone config directory

Create a config directory and `accounts.json` file:

```bash
mkdir -p ~/.mcp/zendesk
cat > ~/.mcp/zendesk/accounts.json <<'EOF'
{
  "accounts": [
    {
      "subdomain": "yourcompany",
      "email": "you@example.com",
      "apiToken": "your-zendesk-api-token"
    }
  ],
  "defaultSubdomain": "yourcompany"
}
EOF
```

## Host configuration examples

### Claude Desktop (`.claude/mcp.json`)

```json
{
  "mcpServers": {
    "Zendesk": {
      "command": "node",
      "args": [
        "<path-to-repo>/connectors/zendesk/dist/server.cjs"
      ],
      "env": {
        "ZENDESK_CONFIG_PATH": "~/.mcp/zendesk"
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "Zendesk": {
      "command": "node",
      "args": [
        "<path-to-repo>/connectors/zendesk/dist/server.cjs"
      ],
      "env": {
        "ZENDESK_CONFIG_PATH": "~/.mcp/zendesk"
      }
    }
  }
}
```

### Mindstone Rebel

Update the Zendesk entry in your Rebel MCP router config:

```json
"Zendesk": {
  "name": "Zendesk",
  "type": "stdio",
  "command": "node",
  "args": [
    "<path-to-repo>/connectors/zendesk/dist/server.cjs"
  ],
  "env": {
    "NODE_PATH": "<path-to-repo>/connectors/zendesk/node_modules",
    "ZENDESK_CONFIG_PATH": "~/Library/Application Support/mindstone-rebel/mcp/zendesk",
    "MCP_HOST_BRIDGE_STATE": "~/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json",
    "LOG_MODE": "strict"
  },
  "description": "Zendesk support tickets...",
  "catalogId": "bundled-zendesk"
}
```

`LOG_MODE=strict` is recommended in Rebel so stdio output stays clean.

After editing the router config, fully quit and restart Rebel so it reloads the connector.

## Smoke test

Ask your MCP host to run a simple Zendesk query such as:

> List my open Zendesk tickets

If that fails, confirm that:

- `dist/server.cjs` exists
- `ZENDESK_CONFIG_PATH` points to a readable directory
- `accounts.json` contains a valid subdomain, email, and API token

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Connector fails to start | Bundle not built yet | Run `npm install && npm run bundle` |
| Auth error or empty results | Wrong config path or invalid credentials | Check `ZENDESK_CONFIG_PATH` and `accounts.json` |
| MCP host reports protocol/parsing issues in Rebel | Stdout noise in a stdio session | Set `LOG_MODE=strict` in the Rebel config |
