# Hello World MCP Server

A minimal MCP server demonstrating the standard Rebel connector pattern. Useful as a reference implementation or starting point for new connectors.

## What it does

Provides two simple tools:

| Tool | Description |
|------|-------------|
| `hello_world_say_hello` | Greets a name — returns `"Hello, <name>! 👋"` |
| `hello_world_echo` | Echoes a message back verbatim |

## Setup

No API credentials required — this server has no external dependencies.

### Run locally

```bash
npm install
npm run build
node dist/index.js
```

### Use with Rebel

Add via Settings → Connectors → Add custom MCP:

```json
{
  "command": "node",
  "args": ["/path/to/hello-world-mcp/dist/index.js"]
}
```

### Use with any MCP client (once published)

```json
{
  "command": "npx",
  "args": ["-y", "@mindstone-engineering/mcp-server-hello-world"]
}
```

## Environment variables

None required.

## Tool reference

### `hello_world_say_hello`

Greet someone by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | Name to greet (default: `"World"`) |

**Returns:** `"Hello, <name>! 👋"`

---

### `hello_world_echo`

Echo a message back verbatim.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | The message to echo back |

**Returns:** The message unchanged.
