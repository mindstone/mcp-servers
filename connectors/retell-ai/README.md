# Retell AI MCP Server

Voice agent phone calls, call management, agent configuration, LLM prompt management, and voice discovery via [Retell AI](https://www.retellai.com/) API.

## Installation

```bash
npx -y @mindstone/mcp-server-retell-ai
```

Or install globally:

```bash
npm install -g @mindstone/mcp-server-retell-ai
mcp-server-retell-ai
```

## Configuration

Set the following environment variable:

| Variable | Required | Description |
|---|---|---|
| `RETELL_API_KEY` | Yes | Retell AI API key. Get one at [retellai.com/dashboard](https://www.retellai.com/dashboard) |

### MCP Host Configuration

```json
{
  "mcpServers": {
    "retell-ai": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-retell-ai"],
      "env": {
        "RETELL_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Security: outbound phone calls require host confirmation (MUST)

`create_phone_call` is annotated `destructiveHint: true`. **The MCP host MUST
require explicit user confirmation before invoking this tool.** Outbound calls
are billed per minute against your Retell AI plan and a misfired call has
real-world consequences (a stranger's phone rings, a recording is captured,
your account is charged) that cannot be undone.

Hosts integrating this connector are required to:

- Surface the proposed `from_number` and `to_number` to the user before each
  invocation.
- Block the call until the user explicitly confirms.
- Never auto-approve `create_phone_call` based on prior approvals — each call
  MUST be confirmed individually.

`from_number` and `to_number` are validated against the E.164 regex
`/^\+[1-9]\d{1,14}$/` before any upstream request is made. Numbers must:

- Start with `+`, followed by a country-code digit 1-9 (no leading zero).
- Contain only digits — spaces, dashes, parentheses are rejected.
- Be 2-15 digits long inclusive of the country code.

Malformed numbers are rejected locally with a structured
`INVALID_PHONE_NUMBER` error and are never sent upstream.

## Available Tools (15)

### Phone Calls
- **create_phone_call** — Create an outbound phone call using a Retell AI voice agent
- **create_web_call** — Create a browser-based voice call with a Retell AI agent
- **get_call** — Get details about a specific call (status, transcript, recording)
- **list_calls** — List and filter calls by agent, time range, or status

### Agents
- **get_agent** — Get full configuration of a voice agent
- **list_agents** — List all configured voice agents
- **create_agent** — Create a new voice agent
- **update_agent** — Update an existing agent's configuration

### LLM Configuration
- **update_retell_llm** — Update the LLM configuration (prompt, greeting, model)
- **get_retell_llm** — Get the full LLM configuration
- **create_retell_llm** — Create a new LLM configuration
- **list_retell_llms** — List all LLM configurations

### Discovery
- **list_voices** — List available text-to-speech voices
- **list_phone_numbers** — List registered phone numbers

### Configuration
- **configure_retell_api_key** — Save your Retell AI API key

## License

FSL-1.1-MIT
