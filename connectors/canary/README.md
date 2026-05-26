# @mindstone/mcp-server-canary

A synthetic MCP server used to validate the rebel-oss release pipeline end-to-end. Single `ping` tool; no external dependencies, no auth, no bridge.

## Why this exists

Releasing a real connector for the first time through a brand-new pipeline (Trusted Publishing, GitHub Actions, mcp-publisher, registry sync, host-app catalog) couples two unknowns: the pipeline correctness AND the connector correctness. The canary decouples them — it exercises every step of the pipeline with a tool whose only behaviour is `ping → pong: <message>`.

Once the pipeline has proven itself stable on the canary, real connectors can adopt the same path without piggy-backing on infrastructure debugging.

See [`docs/plans/260525_oss_release_automation.md`](https://github.com/mindstone/mindstone-rebel-1/blob/dev/docs/plans/260525_oss_release_automation.md) (Mindstone-internal) for the full design.

## Tools

### `ping`

Echo a message back wrapped as `pong: <message>`.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `message` | string | yes | A short message to echo back. 1-200 chars. |

Example:

```json
{
  "tool": "ping",
  "arguments": { "message": "hello" }
}
```

Response:

```
pong: hello
```

## Use locally

```bash
npx -y @mindstone/mcp-server-canary
```

This starts the server on stdio. Most MCP hosts will spawn this for you when you add `@mindstone/mcp-server-canary` as a stdio MCP server.

## Status

Pre-1.0 — this is the canary. Versions are stamped 0.0.x deliberately. Do not depend on this connector for any real workflow; its only purpose is to exercise the release machinery.
