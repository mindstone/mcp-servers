# Retell AI MCP Server

Voice agent phone calls, call management, agent configuration, LLM prompt management, and voice discovery via [Retell AI](https://www.retellai.com/) API.

## Installation

```bash
npx -y @mindstone-engineering/mcp-server-retell-ai
```

Or install globally:

```bash
npm install -g @mindstone-engineering/mcp-server-retell-ai
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
      "args": ["-y", "@mindstone-engineering/mcp-server-retell-ai"],
      "env": {
        "RETELL_API_KEY": "your-api-key"
      }
    }
  }
}
```

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
