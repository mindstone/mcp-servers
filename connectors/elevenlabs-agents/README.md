# @mindstone/mcp-server-elevenlabs-agents

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

ElevenLabs Conversational AI MCP server for Model Context Protocol hosts. Inspect voice agents, review conversation transcripts and recordings, check phone-number assignments, and browse knowledge-base documents through the ElevenLabs ConvAI API.

## Status

- **Version:** bootstrap placeholder `0.0.0` until the first publish stage
- **Auth:** API key ([`ELEVENLABS_API_KEY`](./server.json))
- **Tools:** [10](./src/tools/) (configure, agents, conversations, phone numbers, knowledge base)
- **Surface:** cloud-api
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

## Requirements

- Node.js 20+
- npm
- An ElevenLabs API key with Conversational AI access

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/elevenlabs-agents
npm install
npm run build
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `ELEVENLABS_API_KEY` — ElevenLabs API key (starts with `sk_`)
- `MCP_WORKSPACE_PATH` — optional sandbox root for future knowledge-base file uploads
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration example

```json
{
  "mcpServers": {
    "ElevenLabs Agents": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/elevenlabs-agents/dist/index.js"],
      "env": {
        "ELEVENLABS_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools (10)

### Configuration
- `configure_elevenlabs_agents_api_key` — Save your ElevenLabs API key

### Agents
- `list_agents` — List voice agents in the workspace
- `get_agent` — Get one agent, including prompts and nested conversation config

### Conversations
- `list_conversations` — List conversations, optionally filtered by agent/date/success
- `get_conversation` — Get a full conversation transcript and analysis
- `get_conversation_audio` — Download the conversation recording to a tmp file

### Phone numbers
- `list_phone_numbers` — List configured phone numbers
- `get_phone_number` — Get one phone number and its label/assignment

### Knowledge base
- `list_knowledge_base_docs` — List knowledge-base documents
- `get_knowledge_base_doc` — Get one knowledge-base document, with content capped to about 50KB

## Security notes

All external text returned by the ElevenLabs API is wrapped in `<untrusted-content>` envelopes before it reaches the model. This is especially important for conversation transcripts, which can contain attacker-controlled caller speech.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.
