# @mindstone/mcp-server-elevenlabs

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-elevenlabs.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-elevenlabs)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Generate speech, music and sound effects, browse and create voices, and transcribe and process audio with ElevenLabs. It also builds and manages ElevenLabs voice agents, the AI assistants that talk with people on calls or a website: their versions, tools, reference documents, tests and conversations, plus the stored keys and connected servers they use. Changes are made in your ElevenLabs account and follow your permission settings.

Use it when you want your assistant to produce narration, voiceovers or transcripts, or to set up and test an ElevenLabs voice agent, without leaving the conversation.

## Status

- **Version:** [0.9.1](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-elevenlabs)
- **Auth:** API key ([`ELEVENLABS_API_KEY`](./server.json))
- **Tools:** [41](./src/tools/) (account and usage, voices and pronunciation, speech and dialogue, music and sound effects, transcription and audio processing, dubbing and history, API discovery and voice-agent lifecycle, agent tools, knowledge bases and tests, conversations and review, workspace secrets, environments and MCP servers, phone and WhatsApp account configuration and conversation groups)
- **Surface:** cloud-api
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

The API tools also cover crawl jobs, RAG indexes, document summaries and chunks, source-file URLs, moves and bulk deletion. Crawl creation asks the provider to fetch a URL and may consume credits. Cancelling a crawl also deletes its associated documents and folders, so cancellation, like index and bulk deletion, uses the delete tool.

The API tools also read speech and isolation history, stored transcripts, pronunciation dictionaries and millisecond usage metrics. History continuation and isolation search pages remain caller controlled; speech history cannot verify music or sound effects. History audio, multi-item ZIP downloads and PLS lexicons stream into workspace files without extraction or XML parsing. PLS arrives as binary `text/plain` and is saved with a `.txt` extension. Rule replacement replaces the whole set; addition and removal affect only named rules and return new version identifiers unchanged. Metadata and archive edits leave the version unchanged. Speech, dialogue, voice-conversion and isolation streams use the same file writer and progress as other binary results; they may consume credits, with no live playback or automatic retry. Deletion does not refund work already billed. The curated history, usage and dictionary tools keep their existing behavior.

Workspace sharing can grant, overwrite or remove a user's, group's or service-account key's access. Metadata shows group-role mappings and principal choices, not a complete per-user or key role map; the creator keeps access. Workspace webhooks register destinations for workspace data, list configuration, change delivery settings or remove destinations. HMAC creation returns its signing secret once: keep it for delivery verification; lists cannot recover it. Header values stay hidden, stored destination URLs remain wrapped data and are never fetched. Lists cannot verify custom headers or retries; edits require both a name and disabled state and cannot change the destination URL.

The API tools also read Studio projects, chapters, muted-track IDs and snapshot metadata. Existing chapter snapshots download as MPEG audio; project snapshot archives keep their declared ZIP bytes and stay zipped. Share IDs remain available, filenames come from the connector, and metadata URLs, including signed asset previews and thumbnails, are returned without fetching them. Reads can be repeated explicitly; snapshot metadata does not verify a saved file. Project snapshot audio streaming remains unavailable pending a declared response format.

Studio writes create projects and chapters, edit metadata or exact chapter content, replace project content and pronunciation dictionaries, convert output, and delete projects or chapters. Document uploads use the existing document file binding; source and callback URLs go only to the provider. Conversion spends credits: acceptance is not a finished snapshot. Read the named snapshot list and compare new output before repeating a conversion. Lost creation responses require inspecting candidates, not trusting a project name. Content replacement needs chapter detail reads; project metadata cannot verify uploaded bytes. Deletion does not refund billed work.

Speech Engine configuration can now be created, copied, inspected, updated and deleted. Literal upstream headers stay hidden; secret and dynamic-variable locators remain readable. `auth.enable_auth` defaults to false, so an ID alone may start conversations. Configuration opens no connection and generates no media; later bursting, speculative generation, retranscription and conversation file uploads can incur charges. A copied engine has a new ID; reading the source cannot verify a lost copy response.

Assets can be uploaded from authorized local files, listed, read and deleted. Uploads require a name and use the existing generic binary fallback, without an invented MIME allowlist or provider size cap. Signed content URLs stay wrapped data and are never fetched: they may be null while processing and should not be assumed valid beyond one hour. A metadata read cannot verify original upload bytes or recover a lost upload ID. Deletion does not refund billed work.

Flows image, video and speech jobs run asynchronously, with explicit state reads and list continuation. Image and video generation may use credits; Flows speech is charged per character. Failed generations are documented as uncharged, without a refund promise. Reads have no endpoint fee stated in the specification. Optional webhooks select all or specific configured workspace Flows webhooks for provider delivery. Inline base64 and asset/generation references remain JSON; nothing is uploaded automatically. Completed signed media URLs and MIME stay wrapped data, never fetched, saved or logged; URLs expire about an hour after the read, and re-reading gives a fresh one. No polling or retries are automatic. Keep the returned ID: lists cannot reliably recover a lost creation by its inputs.

Binary downloads are saved incrementally. Clients that request progress receive byte counts and, when a workspace is configured, a relative file reference. If a call fails after reporting saved bytes, the non-empty file is kept and the error identifies it as incomplete. A stalled progress receiver cannot extend the call deadline. This does not promise that an incomplete audio file is playable.

The API tools also save timestamped speech and dialogue, voice-design and remix previews, and existing voice-sample and speaker audio from JSON responses as workspace files. Receipts keep alignment, voice segments and each preview's generated voice ID beside its file; inline audio is omitted. Preview generation may consume credits and does not save a permanent voice. Malformed audio or an unsupported audio media type is an error; completed files are kept and listed if a later preview or receipt fails. Timestamp streaming routes save one audio file and an ordered JSON-lines metadata file per call. Each metadata line contains a redacted, untrusted-content envelope in its `data` field; relative timestamps are preserved. Audio progress uses the same workspace references as binary downloads. A malformed stream or cancellation keeps non-empty partial files and names them in the error; completed files remain marked complete. The tool collects the stream before returning, without live playback or automatic retry.

Detailed music generation (`compose_detailed`) saves each audio part as a workspace file and keeps its composition plan and song metadata in the redacted receipt. It may consume credits. Audio is streamed to disk with progress; malformed or interrupted responses keep any non-empty partial file and identify it as incomplete. Finished files remain complete if a later part fails. Provider filenames are ignored, unsupported audio types are refused, and calls are never retried automatically. Detailed music event streaming is not yet available.

The API tools also support free composition planning, music generation and audio streaming, song uploads, stem separation, ordered video inputs and music finetunes. Paid generation, processing, uploads and training use `elevenlabs_run_job`; finetune reads, edits and deletion use their corresponding resource tools. Training states are returned as reported, without polling. Training accepts up to 50 optional audio files; video requests accept 1–10 files totalling at most 200 MB, in caller order. Duration and account limits remain the provider's responsibility. Audio and ZIP responses stream into workspace files; ZIP bytes are preserved without extraction. Paid binary jobs keep partial files as incomplete on failure and finished files as complete if receipt processing fails. Declared response headers such as `song-id` appear in redacted, untrusted receipt metadata. Provider filenames and undeclared headers are ignored. There is no automatic retry, regeneration or playback; the three convenience music tools keep their existing behavior.

The API tools also create dubbing projects, add language targets and edit source or translated transcript segments. Project creation incurs a minimum charge of one language before output exists, prepaying the first target (including one requested at creation); each additional language is charged separately. Queued acceptance and ready source preparation are not completed dubbed output. States and revisions are returned unchanged, without automatic polling. Regenerating an edited target replaces its output and uses the change tool; it may be billed after the free-regeneration allowance. Deletion does not refund work already running or billed.

Dubbing accepts a source file or a provider-fetched URL, plus an optional JSON transcript. Local media is limited to 3 GiB and transcripts to 4 MiB, with the same file authorization and streaming rules as other uploads. Keyterms and webhook IDs keep caller order. Transcript edits preserve explicit null clears versus omitted fields, and bulk edits remain one atomic request. Editing starts no regeneration. Signed output URLs are returned only as data, expire after one hour, and are never fetched by the connector or copied into diagnostics. Re-read the target for a fresh URL when needed. The four existing dubbing tools keep their contracts.

The API tools also support the deprecated legacy editable dubbing routes. Discovery labels them deprecated and prefers current project operations where available; calls keep the selected legacy route. Segment edits, speaker changes, transcription, translation, dubbing and rendering use the change tool. Transcription does not translate or dub; translation can transcribe missing source text; dubbing can transcribe and translate missing parts. Rendering is asynchronous and omits segments not yet dubbed. Read the resource to inspect its render state.

Legacy creation accepts four optional local file operands: source media, CSV, foreground audio and background audio. CSV bytes pass through unchanged; manual CSV mode is experimental and discouraged for production. The same file authorization and containment rules apply to every operand. Clone selections, library voices, language/segment selections and nullable fields follow the discovered contract. Library voices require the provider permission and available custom voice slots. The pin declares no upload byte limits for these legacy operands. MPEG/MP4 downloads stream to workspace files and return the original automatic dub, even if the resource was later edited. Transcript JSON and subtitle text retain their declared representation. No render, polling, retry or playback starts automatically.

The API tools also read models, account and subscription information, browse voice inventories and manage voice collections. The original `get_voices` route stops working above 500 workspace voices; discover `get_user_voices_v2` instead. Its continuation stays in `data.next_page_token`: while `data.has_more` is true, pass that token unchanged as `query_params.next_page_token`. Shared-library search uses zero-based `query_params.page` and `page_size`; its `last_sort_id` is metadata, not a cursor. There is no automatic paging.

Creating a collection does not add a voice. Adding an existing voice to a collection uses the change tool; removing membership or deleting a collection uses delete and keeps the voices themselves. Shared voices can be saved, voice settings edited, and a voice replicated into the caller-supplied target workspace. Replication keeps the target workspace unchanged and does not switch the connector's API origin. Save a generated preview with `create_voice`, then read its returned voice ID with `get_voice_by_id`. Existing preview audio can also be streamed into a workspace MP3 through `text_to_voice_preview_stream`; a failed read follows the same partial-file rules as other audio reads and can simply be repeated. These reads do not generate another preview or play it.

Instant cloning, voice edits and professional voice management also use the API tools. Create a professional voice record, upload samples, select speakers and trim times, or explicitly request separation, training or manual verification. Creating a record or uploading samples starts none of those later steps. Separation and training change an existing voice or sample, so they use the change tool. Acceptance does not mean completion; read states explicitly when needed. Verification submission is not approval. Nothing is polled, retried, trained, verified or deleted automatically.

Recording and verification-document uploads accept repeated `files` operands through `file_paths`, with authorization checked for every path. The pinned spec gives no upload size limit for these routes, so the shared safe file-size checks and call deadline apply. Voice `labels` keep string values unchanged and encode object values once; PVC metadata accepts object labels. Sample trims stay in milliseconds and `selected_speaker_ids` replaces the full previous selection. Sample audio downloads use only concrete media types in the shared audio table and follow the same partial-file rule as other reads. Captcha retrieval and captcha submission remain unavailable: the pinned response and public reference do not define the challenge representation reliably enough to return it truthfully.

Single-use tokens use the create tool. The pinned token types are `realtime_scribe`, `batch_scribe` and `tts_websocket`; tokens expire after 15 minutes and are consumed on use. Minting a token starts no connection. Only the declared token in success `data` is returned as a usable credential; diagnostics and provider errors omit it. The assistant receives it and the host may retain it in conversation history. Stored account key previews are redacted.

Discover each API operation's contract before calling it. Saving an agent draft uses the change tool because it replaces your existing draft on that branch, if any. Merges, accepted merge proposals and rebases affect callers at once when the target branch serves live traffic.

Podcast creation uses the job tool and automatically converts new media; audio generation is charged. Source URLs are fetched by the provider, and optional callbacks are delivered by the provider. The optional moderation header is intentionally omitted. A lost project ID cannot be reliably recovered by matching source content.

Audio Native supports TXT/HTML article uploads, project creation, content replacement, URL-based replacement and player-settings reads. File updates can auto-publish when requested; URL updates always queue conversion and auto-publication. Returned converting/publishing flags describe submission state, not proof of published audio. Player settings do not expose article content or certify uploaded bytes. Deprecated player fields remain available. No URL is fetched or HTML executed by the connector.

## Requirements

- Node.js 20+
- npm

<!-- BEGIN INSTALL_LINKS: do not edit by hand; regenerated by scripts/gen-install-links.mjs -->
## One-click install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=ElevenLabs&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1lbGV2ZW5sYWJzIl0sImVudiI6eyJFTEVWRU5MQUJTX0FQSV9LRVkiOiIifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22ElevenLabs%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-elevenlabs%22%5D%2C%22env%22%3A%7B%22ELEVENLABS_API_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22ElevenLabs%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-elevenlabs%22%5D%2C%22env%22%3A%7B%22ELEVENLABS_API_KEY%22%3A%22%22%7D%7D)

After clicking the button, your host will prompt you to fill: `ELEVENLABS_API_KEY`.

<details>
<summary>Manual config for Claude Desktop / Claude Code / Goose / Continue.dev (ElevenLabs)</summary>

```json
{
  "mcpServers": {
    "ElevenLabs": {
      "command": "npx",
      "args": [
        "-y",
        "@mindstone/mcp-server-elevenlabs"
      ],
      "env": {
        "ELEVENLABS_API_KEY": ""
      }
    }
  }
}
```

</details>
<!-- END INSTALL_LINKS -->

## Quick Start

Use the one-click install links above or the `npx` command below to install the
connector. The API tools cover the first supported operations for voice-agent
configuration, webhook tools, knowledge documents and saved tests, not every
ElevenLabs API operation.

### Install & build

From the `mcp-servers` folder of your source checkout:

```bash
cd connectors/elevenlabs
npm ci --ignore-scripts --userconfig ../../.npmrc
npm run build
```

### npx (published npm package)

```bash
npx -y @mindstone/mcp-server-elevenlabs
```

### Local

After building, run from the same `connectors/elevenlabs` folder:

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `ELEVENLABS_API_KEY` — ElevenLabs API key (starts with `sk_`)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### MCP desktop clients

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

## Tools (41)

### Agents, tools, knowledge and saved Tests

Use these tools to create and manage an interactive voice agent: configure its
language model, voice and greeting, attach knowledge documents or webhook tools,
and create and run saved Tests for its responses and tool calls. Choose them when
you need to set up or maintain an agent that responds in a conversation. Use the
audio tools below for direct speech generation, transcription and audio processing.

The nine API tools cover **402 admitted operations in source** from the
2026-11-08 API snapshot. Here, admitted means supported by these nine tools in
this connector snapshot; consult the package changelog for release history and find them with `elevenlabs_discover_api` or the coverage
ledger below. Existing audio tool definitions remain unchanged. This is the first
portion of a broader API expansion, not a claim of complete provider
coverage. [API_COVERAGE.md](./API_COVERAGE.md) records all
515 operations: 402 admitted, 0 planned and 113 excluded, with reasons and
existing package coverage tracked separately. Source additions include tags, analysis items,
settings, environments, test folders and summaries, invocation names, conversation users,
live counts, tool executions, LLM usage estimates and agent knowledge-base size.
The usage calculators and test-summary lookup use reviewed read-only POST requests;
they do not run tests or generate audio. Deletion stays in the delete profile.

Generic media coverage includes the audio-effects catalogue and speech, dialogue and sound generation. Discover the contract for advanced inputs such as audio effects, continuity settings and sound duration. Binary responses are collected incrementally into workspace files; provider filenames are ignored. Requested output formats determine file extensions and format metadata, including raw PCM without a WAV container. These calls use the existing 120-second deadline. Failed or cancelled paid jobs keep non-empty partial files as incomplete. Completed recordings need no follow-up read; errors name unavailable retry verification rather than suggesting an unrelated status check. No retry or polling is automatic.

Generic file processing includes speech isolation, voice conversion, transcription and forced alignment through the media job tool. File-based shared-voice similarity also uses the media job tool and accepts only the audio types listed in its discovered contract; lexicon upload creates a pronunciation dictionary. Transcription preserves synchronous, multichannel and queued responses. A queued response is an acceptance receipt, not a completed transcript; webhooks, polling and retries remain caller choices.

Generic audio uploads accept recognised audio and video file extensions; discovery lists the accepted types for each binding. Raw PCM is accepted only where the request declares it; set `file_format` to `pcm_s16le_16` for 16-bit, 16 kHz mono little-endian input.

Local uploads stream from verified file descriptors in bounded chunks. Singular operands use `{field, file_path}`; array contracts use `{field, file_paths: [...]}`, preserving order and declared cardinality. A required empty array must be supplied explicitly. Each concrete path needs its own negotiated authorization; standalone reads stay inside the workspace. Only nullable bindings accept `file_path: null`. Multipart has no null, so an omitted field and an explicit null both send no part. Structured fields such as transcription `additional_formats` and object metadata are JSON-encoded once; caller strings stay strings. Scalar arrays such as keyterms repeat the field name. These shapes are described in each operation's contract.

Transcription local files must be smaller than 5 GB; alignment files must be smaller than 1 GB, using decimal units. Streaming removes the need to buffer a whole upload, but the existing 120-second deadline still applies. Cancellation and errors close open upload descriptors; paid jobs keep non-empty partial output as incomplete. Provider-fetched transcription URLs belong in the body, never in local file operands. Existing convenience tools keep their upload behavior.

Published templates can be inspected and run with port-keyed inputs; running one uses the destructive change tool because it executes the template's workflow, which may belong to another workspace, and can deliver results to configured webhooks. Lists show this workspace's published templates only. Inspect each run output, not just its overall state. Analytics reads retain tabular values and units, including the distinction between credits and workspace-currency cost. Enterprise audit reads require audit_log_read and return personal data, including names, emails and IP addresses, as untrusted evidence. Paging and retries remain explicit.

Operation contracts list only their reachable schema definitions. Complete operation inventories remain available through paginated discovery and the generated coverage ledger.
Phone-number imports and routing changes, and WhatsApp account setting changes,
use the destructive change tool because they affect live calls or messages. Reads
include stored SIP messages and paged number configuration. Stored custom SIP header
values are hidden wherever phone numbers are returned, including agent configurations
and previews; header names, usernames, credential-presence flags and attribute-to-header
mappings remain visible. Removing a number or
WhatsApp account uses the delete tool. Conversation groups support metadata and
sharing reads, creation, title and description changes and moving a conversation into a group.
Clearing an association and deleting a group use the delete tool because they
remove group-derived access. A group metadata read describes sharing; it does not
independently verify conversation membership. None of these configuration calls
places a call or sends a message.

Agent lifecycle coverage includes branches, drafts, version metadata, deployments,
merge proposals, procedures and agent links, widgets, topics and assignable users.
Merge and rebase previews are reads. Merges, rebases, deployment traffic changes
and replacement review verdicts use the destructive change profile. The legacy
procedure compiler is a dry-run that persists nothing; saving or publishing already
compiles procedures. Branch lists accept a result limit; deployment history accepts
page and page_size. Inspect returned metadata; pagination is caller-managed.

Conversation coverage includes reference resolution, full transcripts, lightweight
summaries, transcript search, SIP messages, tags and triage tickets across the workspace
or one agent. Audio recordings are saved inside the workspace; receipts contain the
local path, byte length and declared media type, with no audio bytes in model text.
Analysis and evaluation reruns can replace stored results and may consume credits.
Ticket creation for a conversation can update an existing open ticket, so it uses the
change tool. Ticket merging keeps source tickets marked as merged. Unused-file
removal, tag unassignment and custom hold-audio removal use the delete tool.
Conversation file uploads accept images, PDFs and text and return a file ID for use in
that conversation. Audio is not accepted by this route.

Agent summaries take `query_params.agent_ids`, not test IDs, and return a map of
per-agent summaries or failure details. Avatar and custom hold-audio uploads use
the change tool because they replace existing media. Avatars accept PNG, JPEG,
GIF or WebP. Hold audio accepts MP3 or WAV up to 40 MB; the provider also limits
clips to 180 seconds. The snapshot gives no avatar size limit, so the runtime
buffer limit applies. These uploads use the same file authorization and opened
descriptor checks as document uploads; a canonical filename determines the type.

Signed conversation URLs (including the deprecated underscore route), WebRTC tokens and
ephemeral realtime client credentials use the create tool: issuing authorization is
a write even when the provider uses GET. Read and query grants acquire no credential
minting or call permission. Returned credentials stay usable in enveloped `data`;
the assistant receives them and the host may retain them in the conversation.
Provider failure diagnostics omit raw detail for these operations. Echoed upstream
realtime tool authorization remains write-only and is redacted. Issued credentials are masked by field name outside their declared response paths, but copies inside unrelated string fields are not caught.
The same field-name masking applies to every operation's reply and to every named tool's reply (such as voice labels from `get_voice`): a secret-named field or signed link the provider sends beyond the documented shape is redacted, while secret references such as `secret_id` and fixed labels from the schema stay readable.
The API key and submitted secrets are always redacted, even if an issued credential has the same value.
Raw SIP messages are withheld from phone-number and conversation logs because they may contain stored header credentials.

Outbound Twilio, Exotel and SIP calls, WhatsApp calls and template messages, batch
submission and batch retry use the destructive `elevenlabs_place_call` tool. These
actions can contact real people and incur provider charges. Provider acceptance,
including a returned conversation ID, does not prove someone answered or received
a message; provider rejections and null call IDs remain visible. Live Twilio
registration returns TwiML as untrusted text; the connector does not execute it or
claim a completed dial. Permission prompts are up to the MCP host; the tool is marked
destructive. No automatic retry or polling is added.

Batch submission takes structured JSON recipients, with scheduling, timezone,
telephony or WhatsApp controls and optional concurrency. It does not read local
CSV files. Cancelling uses the change tool because it stops live calls; deleting
uses delete and removes batch and recipient records while retaining conversations.
Workspace batch pages keep `next_doc` and `has_more` in `data`; pass `next_doc` as
`query_params.last_doc` yourself. CSV exports use the shared workspace artifact
path and preserve exact bytes in a `.csv` file. The optional export `limit` previews
the first N recipients; it is not a continuation cursor.

| Tool | Operations | Effect |
| --- | --- | --- |
| `elevenlabs_discover_api` | Local search and request/response contracts | No HTTP or API key needed |
| `elevenlabs_read_resource` | 165 resource reads and calculations | Read only |
| `elevenlabs_create_resource` | 46 creates, including agents, documents, indexes and saved Tests | May consume credits |
| `elevenlabs_change_resource` | 90 edits, including file replacement | May overwrite content, configuration or arrays |
| `elevenlabs_delete_resource` | 49 deletes | Destructive |
| `elevenlabs_run_agent_tests` | Run, cancel and resubmit saved Tests | May consume credits and invoke real integrations |
| `elevenlabs_run_job` | Speech, dialogue, sound and music generation, processing and training | May consume credits and create provider records |
| `elevenlabs_query_knowledge` | Retrieve information from knowledge documents (RAG) | Read only; may consume credits |
| `elevenlabs_place_call` | 8 call, message, batch submit/retry and live registration operations | Destructive; provider services may incur charges |

Receipt follow-ups name required path and query parameters; optional filters matching
known request IDs are marked optional. Other listed operation IDs are names only. Before the
first call to each operation in a conversation, discover its contract unless a
tool description or receipt already gives the exact parameter names and locations.
Branch and version metadata receipts point to the agent configuration read.
Do not infer path parameters, query parameters or body fields from operation names.
Start with local discovery, then send the operation to its declared tool:

```json
{"query":"create agent","family":"agents"}
```

```json
{"operation_id":"create_agent_route"}
```

For example, `elevenlabs_create_resource` accepts:

```json
{"operation_id":"create_agent_route","body":{"name":"Acme guide","conversation_config":{"agent":{"prompt":{"llm":"gemini-3.5-flash","prompt":"Answer questions about the guide."}},"tts":{"voice_id":"voice_example"}}}}
```

Use `list_voices` to obtain a real voice ID. Discovery can inspect named schemas
using `definition`, for example `KnowledgeBaseLocator` with
`operation_id: "create_agent_route"`. Provider constraints and typed enums remain
pinned to 2026-11-08; a new value at a typed position requires a reviewed catalogue
refresh. Free-form provider fields stay free-form. The connector rejects the
aliases `llm_model` and `knowledge_base_document_ids` only at the documented agent
prompt anchors (including Test overrides); use `llm` and structured
`knowledge_base` locators there. Those spellings remain valid data keys elsewhere.

Local document uploads send file bytes plus other fields in a multipart request.
Use `files` separately from scalar `body` fields:

```json
{"operation_id":"create_file_document_route","body":{"name":"Pricing"},"files":[{"field":"file","file_path":"/workspace/pricing.pdf"}]}
```

`update_file_document_route` uses the same file operand on
`elevenlabs_change_resource`, with `path_params.documentation_id`. It replaces the
source file and can overwrite manual content edits. Only the declared `file`
binding is accepted; body-hidden paths are never read. Files must pass the same
negotiated or standalone authorization described below, plus regular-file,
descriptor identity and runtime-size checks. Document MIME types include PDF,
text, Markdown, HTML, Word and EPUB, with `application/octet-stream` fallback;
the provider still determines supported content and account limits. No remote
URL fallback is attempted. Use `create_url_document_route` to ask the provider
to fetch a URL, or `create_text_document_route` for inline text. Uploading does
not write a local output artifact.

To replace the deprecated combined upload/attachment route, create a file **or
URL** document (name is optional), explicitly read the document and current
agent, then call `patch_agent_settings_route` with a caller-authored
`knowledge_base` array containing the prior structured locators and the new
`{"type":"file","name":"Pricing","id":"doc_example"}` locator (use type
`url` for URL documents). These are separate requests, not an atomic replacement.
The connector never fetches/merges configuration, retries writes, polls Tests,
or cleans up resources automatically. Preserve existing arrays and configuration
explicitly; for PATCH update requests, the provider determines which omitted
fields are retained.

A saved Test is a reusable check stored by ElevenLabs for an agent's responses,
tool calls or simulated conversations. To use substitute tool responses in a
simulation, explicitly create a saved simulation Test with
`tool_mock_config: {"mocking_strategy":"all","fallback_strategy":"raise_error"}`
and suitable `tool_mock_overrides`. In the pinned provider schema, `"all"` mocks
every mockable tool; `"raise_error"` selects an error when no mock matches a tool
call, instead of the `"call_real_tool"` fallback. `tool_mock_overrides` supplies
test-specific responses keyed by tool ID, only for tools selected for mocking.
These settings do not guarantee a run has no real effects. Inspect the saved Test,
agent and referenced tools before running it. A run request does not configure
mocks; the caller owns those settings. Tests may consume credits and use real
integrations. Cancellation does not undo prior effects. After a lost run response,
use `list_test_invocations_route` with the known
`query_params.agent_id`, then inspect a returned invocation ID before deciding
whether to retry.

Each execution makes one provider request and returns a checked receipt with
operation, status, declared content type, effect annotations and enveloped data.
Discovery notes that `update_settings_route` and `update_dashboard_settings_route`
change settings for the whole workspace.
If response fields the connector does not use differ from the pinned schema,
their data is retained with a `response_contract` warning; check the affected
fields before relying on them. Malformed fields the connector actually uses
(such as pagination fields), or an unexpected response format, cause an error.
Timeout or invalid-success-response errors can follow a completed write. Follow
the read/list guidance in the error through `elevenlabs_read_resource`, and compare
saved state with the intended change before retrying. If a detail read needs an ID
the lost response never supplied, discover and use the matching resource-list
operation first; avoid blind duplicate writes. Callback errors use structured
`ok:false` receipts; strict argument/protocol rejections before a callback keep
the SDK's native errors. Discovery contracts and external response text are
untrusted content, not instructions. RAG retrieval has its own read-only tool
and credit disclosure; it does not create conversations or place calls.

Auth connections store credentials for integrations that reach external data. Create and update
use the change tool. Stored secrets are never shown back; success means stored,
without proving they work. Lists retain readable metadata and `used_by` dependencies.
Keep those dependencies before deleting, then check the exact connection ID is gone.
The list is not a token or password getter.

Secrets, environment variables and MCP server configurations are also available through discovery.
Agent-link tokens and signed source-file URLs delegate access the read already has to whoever holds them; they are intentionally returned by those reads.
Argument and local file errors from the nine API tools omit caller keys and values. Recognized body credentials and policy-classified path or query credentials are removed from complete raw, URL/form and decoded JSON echoes; partial echoes, other transformations and unrecognized fields remain unprotected. Known issues: redaction can stall a call for several seconds, or end it with a generic error, when a submitted credential thousands of characters long meets a long response that nearly matches it; responses nested thousands of levels deep are also slow to redact. Neither shows a credential.
Stored authentication values and literal header maps or records are hidden wherever their declared response schemas reach them. Supported secret, environment and dynamic-variable references stay readable; unexpected objects or arrays at a sensitive value are hidden as a whole. Signed media links, template output links and the declared credential getters intentionally return usable access links or tokens to the assistant, which may retain them in conversation history. Submitted secrets and the account key are still removed from those returns. Stored configuration URLs such as `ws_url` and `token_url` remain readable, including credentials embedded in them.

The curated tools also remove account-key echoes from parsed replies and errors, including setup warnings and file-download failures. Authenticated requests never follow redirects. Every audio upload uses the same audio/video file-type rule; explicit raw PCM support remains available. File contents are not scanned for secrets.

MCP approval changes and overrides of existing MCP tools use the change profile; removals, including environment-value removal by update, use delete.

### Configuration
- `configure_elevenlabs_api_key` — Save your ElevenLabs API key

### Account & discovery (FREE)
- `check_subscription` — Check subscription tier and character credit usage
- `get_usage_stats` — Credit usage over time grouped by product/model/voice (workspace analytics API)
- `list_models` — List TTS models with languages and capabilities

### Voices
- `list_voices` — Search and browse voices on your account
- `get_voice` — Get full details for one voice by voice_id
- `search_shared_voices` — Search the public shared voice library (filters include accent)
- `clone_voice` — Create an instant voice clone from local audio samples (`destructiveHint`)
- `delete_voice` — Permanently delete a voice (`destructiveHint`)
- `design_voice` — Generate voice-design previews from a text description (slow; previews saved under the workspace)
- `create_voice_from_preview` — Save a design preview as a permanent voice (`destructiveHint`)

### Speech & conversion
- `generate_speech` — Generate spoken audio from text using text-to-speech (supports `seed` and `pronunciation_dictionary_locators`)
- `generate_speech_with_timestamps` — Generate speech with character-level timing; also writes an `.srt` subtitle file and alignment JSON
- `generate_sound_effect` — Generate sound effects from a text description
- `speech_to_speech` — Convert source audio to a different voice
- `text_to_dialogue` — Multi-voice dialogue from a script (one voice per line)

### History (FREE)
- `list_history` — List previously generated audio items (find that voiceover from last week)
- `get_history_item_audio` — Re-download the audio of a past generation by history_item_id

### Pronunciation dictionaries
- `list_pronunciation_dictionaries` — List pronunciation dictionaries (brand names, jargon) (FREE)
- `get_pronunciation_dictionary` — Get one dictionary's metadata and current rules (FREE)
- `add_pronunciation_dictionary` — Create a dictionary from alias/IPA rules (`destructiveHint`)
- `archive_pronunciation_dictionary` — Archive a dictionary so it is no longer applied (`destructiveHint`; reversible in the dashboard)

### Audio processing
- `isolate_audio` — Remove background noise from an audio file (source must be ≥ ~4.6s; shorter clips fail upstream)
- `forced_alignment` — Align transcript text to audio with per-word timestamps

### Dubbing (v1 API — async submit → poll → download)
- `create_dubbing` — Submit a dubbing job (local `file` via sandbox or `source_url` for ElevenLabs-side fetch)
- `get_dubbing` — Poll job status until `dubbed`, `failed`, or `cancelled`
- `download_dubbed_audio` — Download dubbed audio (Content-Type sniffed)
- `delete_dubbing` — Permanently delete a dubbing job (`destructiveHint`)

### Music
- `generate_music` — Generate music from a text prompt
- `create_music_plan` — Create a composition plan for music generation (free)
- `generate_music_from_plan` — Generate music from a composition plan

### Transcription
- `transcribe_audio` — Transcribe speech from an audio file to text, with optional speaker diarization (`diarize`, `num_speakers`, `diarization_threshold`) and word-level timestamps (`include_word_timestamps`); `scribe_v1` and `scribe_v2` models

For standalone clients, including clients that do not negotiate `files/readModes` version 1, local file paths for upload tools must be inside `MCP_WORKSPACE_PATH` (or `os.tmpdir()` when unset). With negotiated version 1, the host selects a mode for each call: in central mode, input reads use only the host-authorized canonical path described under [Host-authorized local inputs](#host-authorized-local-inputs); in standalone mode, the standalone restrictions apply. See `src/tools/file-input.ts`. In every mode, generated and downloaded files (speech audio, subtitles, history/dubbing downloads, voice-design previews) are written into the canonical workspace root with exclusive creation — existing files are never overwritten. See `src/tools/path-safety.ts`.

## Maintainer notes: API catalogue

The API catalogue generator produces the pinned contracts used by the nine API
tools. Regenerate with `npm run api:generate -- --spec <pinned.json-or-gzip>` and
verify with `npm run api:check -- --spec <pinned.json-or-gzip>`. The input must match
the recorded original-byte pin; the whole provider snapshot is not distributed
with this package and is never fetched at runtime. ElevenLabs serves its OpenAPI
document openly; this package embeds only the descriptors of the admitted
operations that are needed to call them. Ajv and ajv-formats interpret
the retained JSON Schema graph; Zod validates tool envelopes and consumed fields.
Schema nodes containing `unevaluatedProperties`
are rejected during generation and loading because the pinned validator cannot
reliably enforce that construct. Support requires a reviewed validator correction;
the constraint is never silently removed. The keyword is absent from the complete
2026-11-08 provider snapshot (515 operations and 1,846 component schemas), so this
boundary loses no capability in that pin. The same spelling in property names,
examples, defaults and enum data remains unchanged.

Policy rows may declare `retry_check` as an admitted GET read ID or an object
with a non-empty `unavailable_reason`. This overrides the credential-issuer
default, success follow-ups and route/family retry lookups; omitting it
preserves the existing selection.
`optional_header_omissions` lists exact `name` and `reason` pairs. Generation
checks each named header against the spec and rejects required or missing
headers. Discovery retains these reasons; the connector sends no value for the
omitted headers and accepts no caller-supplied headers.
Declared `application/zip` and `application/x-zip` responses both save exact bytes
as `.zip` files, retaining their declared MIME without extraction.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

### Host-authorized local inputs

`files/readModes` version 1 is an experimental extension used by these connectors,
not part of the MCP standard. A compatible host (the app running the connector)
decides which input files a tool call may read. The connector opens only the
host-approved physical path, after resolving symlinks. The host supplies this
permission information with each call; it is not a tool argument you need to set.
Missing or invalid permission information, or a file absent from the approved
list, stops the read.

Clients that do not negotiate this extension keep the connector's existing
standalone file restrictions. This extension changes input-read permissions;
existing output destinations, upload formats, size limits and file checks apply.
