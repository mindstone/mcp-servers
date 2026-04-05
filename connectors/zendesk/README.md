# @harryjbloom18/mcp-server-zendesk

Zendesk MCP connector. Part of the [rebel-mcps](../../README.md) spike — proving the standalone open-source build and Rebel integration loop.

## Prerequisites

- Node.js 18+
- npm

## Build

```bash
npm install
npm run bundle
# → produces dist/server.cjs and dist/manifest.json
```

## Environment Variables

**Rebel mode** (recommended — credentials managed by Rebel):
- `ZENDESK_CONFIG_PATH` — path to Rebel's Zendesk config dir (contains `accounts.json` with subdomain, email, apiToken). Rebel sets this automatically.

**Standalone mode** (if running outside Rebel):
- `ZENDESK_SUBDOMAIN` — your Zendesk subdomain (e.g. `yourcompany`)
- `ZENDESK_EMAIL` — your Zendesk email
- `ZENDESK_API_TOKEN` — your Zendesk API token

**Always set** (important for stdio protocol):
- `LOG_MODE=strict` — suppresses stdout logs that would corrupt the MCP stdio protocol. ALWAYS set this when running as a Rebel MCP.
- `MINDSTONE_REBEL_BRIDGE_STATE` — path to Rebel's inbox bridge state file. Optional — gracefully degraded to null when absent.

## Wiring into Rebel

After building, update `~/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json`.

Find the `"Zendesk"` entry and change:

```json
"Zendesk": {
  "name": "Zendesk",
  "type": "stdio",
  "command": "node",
  "args": [
    "/path/to/home/development/rebel-mcps/connectors/zendesk/dist/server.cjs"
  ],
  "env": {
    "NODE_PATH": "/path/to/home/development/rebel-mcps/connectors/zendesk/dist/node_modules",
    "ZENDESK_CONFIG_PATH": "/path/to/home/Library/Application Support/mindstone-rebel/mcp/zendesk",
    "MINDSTONE_REBEL_BRIDGE_STATE": "/path/to/home/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json",
    "LOG_MODE": "strict"
  },
  "description": "Zendesk support tickets...",
  "catalogId": "bundled-zendesk"
}
```

Then **fully quit and restart Rebel** (Cmd+Q, not just close the window). A package restart is NOT sufficient — the full process must restart to pick up config changes.

## Smoke Test

After restarting Rebel, ask it: **"List my open Zendesk tickets"**

Expected: a list of open tickets from your Zendesk instance (mindstone-45270). If you see an error or empty result where you'd expect tickets, check that `ZENDESK_CONFIG_PATH` is set and `accounts.json` is readable.

## Rebel-Specific Notes

- **`LOG_MODE=strict`**: MUST be set. Without it, the connector writes logs to stdout which corrupts the MCP stdio protocol and causes JSON parse errors in Rebel.
- **`MINDSTONE_REBEL_BRIDGE_STATE`**: Safe to set to a non-existent path — the connector checks for the file and returns null gracefully. Do not remove this env var.
- **Tool namespace**: Rebel registers this connector under the `Zendesk` namespace. Tool names appear as `Zendesk__search_tickets`, etc.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Zendesk tools don't appear after config edit | Config not picked up | Fully quit and restart Rebel (Cmd+Q) |
| MCP parse errors in Rebel logs | stdout logging corrupting stdio | Ensure `LOG_MODE=strict` is set |
| Auth error / empty results | ZENDESK_CONFIG_PATH wrong | Check path contains `accounts.json` with valid credentials |
| `dist/server.cjs` not found | Build not run | Run `npm install && npm run bundle` first |
| Import errors during build | Missing dependency | Check `npm install` completed successfully |
