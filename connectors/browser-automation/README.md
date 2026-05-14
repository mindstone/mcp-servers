# Browser Automation MCP Server

Headless browser control via accessibility snapshots — navigate pages, fill forms, click elements, take screenshots, and manage tabs using the [agent-browser](https://www.npmjs.com/package/agent-browser) CLI.

## Installation

```bash
npx -y @mindstone/mcp-server-browser-automation
```

Or install globally:

```bash
npm install -g @mindstone/mcp-server-browser-automation
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
| `BROWSER_AUTOMATION_ALLOW_EVAL` | No | Set to `1` to register the `browser_evaluate` tool. Off by default. See [Security considerations](#security-considerations). |

### MCP Host Configuration

```json
{
  "mcpServers": {
    "browser-automation": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-browser-automation"]
    }
  }
}
```

## Available Tools (17 by default; +1 when `BROWSER_AUTOMATION_ALLOW_EVAL=1`)

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
- **browser_evaluate** — Execute JavaScript in the page context (gated; see [Security considerations](#security-considerations))

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

## Security considerations

Browser automation has a large attack surface: the agent-browser CLI controls a real headless browser that loads URLs you pass it, runs page-side JavaScript, and persists cookies and session state across runs. Read this section before deploying.

### `browser_evaluate` is gated behind `BROWSER_AUTOMATION_ALLOW_EVAL`

`browser_evaluate` lets the model execute arbitrary JavaScript inside the page context — the security equivalent of giving the model a shell on whatever site it has just navigated to. To prevent prompt-injected content from doing this silently, the tool is **only registered when the host explicitly opts in**:

```bash
BROWSER_AUTOMATION_ALLOW_EVAL=1 mcp-server-browser-automation
```

Without this env var, `browser_evaluate` is **not** in the tools list at all — the LLM cannot even see it. When enabled, the tool is annotated `destructiveHint: true` so MCP hosts can (and should) require explicit user confirmation before each invocation.

### URL scheme deny-list

`browser_navigate` and `browser_authenticate` accept only `http:` and `https:` URLs (plus the special `about:blank`). Other URL schemes are refused before the underlying `agent-browser` CLI is invoked:

- `file:` — would let pages read local filesystem paths
- `chrome:` and `chrome-extension:` — internal browser pages and installed extensions
- `javascript:` — equivalent to `eval()` against the current document
- `data:` — inlined attacker-controlled HTML/JS payloads
- `view-source:` — defeats the same-origin policy on rendered content
- `about:` — privileged internal pages (`about:config`, `about:cache`, `about:debugging`, …); only `about:blank` is permitted

### Cookie and session persistence

The connector tells `agent-browser` to use a **named, persistent session** via `AGENT_BROWSER_SESSION_NAME` (default value: `mcp`). All cookies, `localStorage` data, and any logins performed via `browser_authenticate` are stored on disk under that session name and reused across runs. Anyone who can read the session storage — the local user, other tools running as the same user, or backups — can also use those logged-in sessions.

To override the session name (for example, to keep separate profiles per project) set `AGENT_BROWSER_SESSION_NAME` explicitly in the host's MCP server config. To wipe state, close the browser via `browser_close` and remove the session directory managed by `agent-browser`.

### Recommended deployment posture

- **Run the connector against a separate browser profile** — a dedicated `AGENT_BROWSER_SESSION_NAME` per MCP host. Do not reuse your daily browser profile: the connector reads and overwrites cookies in whichever profile it is pointed at, and a malicious page can ride the existing session of any site you are logged into.
- **Leave `browser_evaluate` disabled** unless the host implements user confirmation for every call. The default (off) is the safe choice.
- **Require host confirmation** for `browser_authenticate` and any flow that may navigate to authenticated sites — otherwise prompt injection in fetched content can drive the browser at sites the user is logged into.
- **Treat returned page content as untrusted** — accessibility snapshots, screenshots, and JavaScript-evaluation outputs come from arbitrary websites and may contain prompt-injection attempts.

## License

FSL-1.1-MIT
