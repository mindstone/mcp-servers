# Browser Automation MCP Server

Headless browser control via accessibility snapshots — navigate pages, fill forms, click elements, take screenshots, and manage tabs using the [agent-browser](https://www.npmjs.com/package/agent-browser) CLI.

## Installation

```bash
npx -y @mindstone-engineering/mcp-server-browser-automation
```

Or install globally:

```bash
npm install -g @mindstone-engineering/mcp-server-browser-automation
mcp-server-browser-automation
```

## Requirements

This server requires the `agent-browser` CLI binary to control the browser.

### Binary Resolution

1. **PATH lookup** (preferred): If `agent-browser` is on your PATH, it is used directly.
2. **npx fallback**: If the binary is not found, the server automatically falls back to `npx -y agent-browser@0.17`.

### Installing agent-browser

```bash
npm install -g agent-browser
```

Or let the npx fallback handle it automatically (slower on first use due to download).

## Configuration

No API keys or credentials are required. The server communicates with the browser via the agent-browser CLI.

| Variable | Required | Description |
|---|---|---|
| `AGENT_BROWSER_SESSION_NAME` | No | Session name for browser persistence (default: `mcp`) |

### MCP Host Configuration

```json
{
  "mcpServers": {
    "browser-automation": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-browser-automation"]
    }
  }
}
```

## Available Tools (18)

### Navigation
- **browser_navigate** — Navigate to a URL
- **browser_back** — Navigate back in browser history
- **browser_forward** — Navigate forward in browser history
- **browser_wait** — Wait for an element to appear or a specified time

### Observation
- **browser_snapshot** — Get the page accessibility tree with interactive element references
- **browser_screenshot** — Take a screenshot of the current page
- **browser_get_page_info** — Get the current page URL and title

### Interaction
- **browser_click** — Click an element using @ref or CSS selector
- **browser_fill** — Clear a field and fill it with text
- **browser_type** — Type text character by character (real keystrokes)
- **browser_press_key** — Press a keyboard key
- **browser_scroll** — Scroll the page in a direction
- **browser_select** — Select an option from a dropdown
- **browser_hover** — Hover over an element
- **browser_evaluate** — Execute JavaScript in the page context

### Session Management
- **browser_tabs** — List open tabs or switch to a tab
- **browser_close** — Close the browser session
- **browser_authenticate** — Open a visible browser for manual login

## Workflow

The typical workflow uses accessibility snapshots for reliable element targeting:

1. `browser_navigate` → open a page
2. `browser_snapshot` → see interactive elements with @ref IDs
3. `browser_click` / `browser_fill` → interact using @ref references
4. `browser_screenshot` → visual verification

## License

FSL-1.1-MIT
