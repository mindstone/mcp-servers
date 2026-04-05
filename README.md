# rebel-mcps

Standalone MCP connector packages for Mindstone Rebel.

## Connectors

- `connectors/zendesk/` — Zendesk support tickets connector

## Contributing

Each connector builds independently:
```bash
cd connectors/<name>
npm install
npm run bundle
```

See each connector's README for setup and wiring instructions.
