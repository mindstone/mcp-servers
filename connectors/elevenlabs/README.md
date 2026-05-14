# @mindstone/mcp-server-elevenlabs

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-elevenlabs.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-elevenlabs)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

ElevenLabs MCP server for Model Context Protocol hosts. Generate speech, music, and sound effects, browse voices, and transcribe audio using the ElevenLabs API through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/elevenlabs
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-elevenlabs
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `ELEVENLABS_API_KEY` — ElevenLabs API key (starts with `sk_`)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "ElevenLabs": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-elevenlabs"],
      "env": {
        "ELEVENLABS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "ElevenLabs": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/elevenlabs/dist/index.js"],
      "env": {
        "ELEVENLABS_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools (8)

### Configuration
- `configure_elevenlabs_api_key` — Save your ElevenLabs API key

### Voices
- `list_voices` — Search and browse available ElevenLabs voices

### Speech
- `generate_speech` — Generate spoken audio from text using text-to-speech
- `generate_sound_effect` — Generate sound effects from a text description

### Music
- `generate_music` — Generate music from a text prompt
- `create_music_plan` — Create a composition plan for music generation (free)
- `generate_music_from_plan` — Generate music from a composition plan

### Transcription
- `transcribe_audio` — Transcribe speech from an audio file to text

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.
