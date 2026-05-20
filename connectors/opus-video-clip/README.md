# @mindstone/mcp-server-opus-video-clip

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

OpusClip MCP server for Model Context Protocol hosts. Turn long-form videos into short clips, manage projects, collections, censor jobs, and scheduled social posts through the OpusClip API.

## Requirements

- Node.js 20+
- npm
- An OpusClip API key (https://app.opus.pro/settings/integration-tokens)

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/opus-video-clip
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-opus-video-clip
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `OPUS_API_KEY` — OpusClip API key
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`
- `OPUS_API_TIMEOUT_MS` — outbound HTTP timeout for general Opus API calls (default `120000` ms, max 30 min)
- `OPUS_UPLOAD_TIMEOUT_MS` — per-chunk HTTP timeout for GCS resumable upload (default `600000` ms, max 30 min)
- `OPUS_BRIDGE_TIMEOUT_MS` — HTTP timeout for the optional host-app bridge (default `30000` ms, max 30 min)

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "OpusClip": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-opus-video-clip"],
      "env": {
        "OPUS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "OpusClip": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/opus-video-clip/dist/index.js"],
      "env": {
        "OPUS_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools (21)

### Configuration
- `configure_opus_api_key` — Configure the OpusClip API key

### Brand templates
- `opus_get_brand_templates` — List brand templates

### Project lifecycle
- `opus_create_project` — Submit a long-form video URL for clipping
- `opus_get_project` — Retrieve a project's status, metadata, and clips
- `opus_get_clips` — Retrieve clips generated for a project
- `opus_share_project` — Update a project's sharing visibility

### Upload
- `opus_upload_video` — Upload a local video file and create a clip project (orchestrates the 4-step GCS resumable upload)

### Censor jobs
- `opus_create_censor_job` — Create a censor job for a clip
- `opus_get_censor_job_status` — Poll the status of a censor job

### Collections
- `opus_create_collection` — Create a clip collection
- `opus_get_collections` — List your collections
- `opus_export_collection` — Export all clips from a collection
- `opus_delete_collection` — Delete a collection (clips themselves are preserved)

### Collection contents
- `opus_add_clip_to_collection` — Add a clip to an existing collection
- `opus_remove_clip_from_collection` — Remove a clip from a collection (uses Opus's POST-to-delete idiom)

### Social posting
- `opus_get_social_accounts` — List connected social accounts
- `opus_create_social_copy_job` — Generate platform-specific social copy for a clip
- `opus_get_social_copy_job` — Retrieve the result of a social-copy job
- `opus_publish_post` — Publish a clip to a connected social account immediately
- `opus_schedule_post` — Schedule a clip for future publishing
- `opus_cancel_scheduled_post` — Cancel a scheduled social post

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-05-19.
