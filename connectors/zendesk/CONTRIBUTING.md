# Contributing to Zendesk MCP Server

Thank you for considering contributing to the Zendesk MCP Server.

## Getting Started

```bash
git clone https://github.com/nspr-io/mcp-servers.git
cd mcp-servers/connectors/zendesk
npm ci
npm run build
npm test
```

## Development

### Commands

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run watch` | Watch mode (rebuild on changes) |
| `npm test` | Run all tests |
| `npm run test:watch` | Watch mode for tests |
| `npm run test:coverage` | Run tests with coverage report |

### Project Structure

```
src/
  index.ts          # CLI entry point (stdio transport)
  server.ts         # McpServer construction + tool registration
  auth.ts           # Account/credential management
  client.ts         # Zendesk HTTP client (fetch wrapper)
  bridge.ts         # MCP host bridge communication
  types.ts          # Shared types and validation
  utils.ts          # Error handling wrapper + path utilities
  formatters.ts     # Response formatting
  tools/            # Tool domain modules (one per Zendesk domain)
test/
  helpers/          # Reusable test infrastructure
  fixtures/         # Factory functions and test data
  tools/            # Tool-specific test files
```

### Adding a New Tool

1. Add the tool handler in the appropriate `src/tools/*.ts` domain file
2. Register it in `src/server.ts` (if creating a new domain file)
3. Add corresponding tests in `test/tools/*.test.ts`
4. Update the tool count assertion in `test/smoke.test.ts`

### Code Style

- ESM modules (`"type": "module"`) with `.js` import extensions
- TypeScript strict mode with `NodeNext` resolution
- Zod schemas for all tool input validation
- All HTTP calls through `zendeskFetch()` in `client.ts`

## Testing

Tests use [Vitest](https://vitest.dev/) with [MSW](https://mswjs.io/) for HTTP mocking and the MCP SDK's `InMemoryTransport` for protocol-level testing.

Tool tests call tools via the real MCP JSON-RPC protocol — not direct function imports. This catches serialisation, schema validation, and error wrapping bugs.

## Submitting Changes

1. Fork the repository and create a feature branch
2. Make your changes with tests
3. Run `npm run build && npm test` to verify
4. Submit a pull request against `main`

## Release Process

Releases are tag-based. When a `zendesk-v*` tag is pushed, CI automatically builds, tests, and publishes to npm.

## Licence

This project is licensed under FSL-1.1-MIT. After the Change Date (2030-04-08), the licence converts to MIT. See [LICENSE](LICENSE) for details.
