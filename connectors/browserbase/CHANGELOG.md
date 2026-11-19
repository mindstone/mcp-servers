# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The host bridge is now read only through the shared hardened bridge reader, which refuses a symlinked, non-regular, oversized or malformed bridge state file and checks the bridge's reply.
- Function versions' `userParamsSchema` and `sessionCreateParams` (from `list_function_versions`, `get_function_version`, and each build's `createdVersion`) are now each returned as one JSON string inside an untrusted-content envelope, so text the function's author wrote, keys included, reaches the assistant as outside content. Callers that read these fields as objects must unwrap the envelope and parse the JSON.
- `get_download_file` now enforces its 8MB inline limit while streaming: a file whose declared size is over the limit is refused without being read, and any other file is cut off as soon as it passes the limit, instead of being held in memory in full first.

## [0.2.0] - 2026-11-16

### Changed

- Declare file operands (files/readInputs, files/readModes) so Rebel can hand the connector files outside the workspace, e.g. in linked Spaces.

### Security

- Text from the service that contains an untrusted-content tag is now escaped the same way as in every other connector, open and close tags alike, keeping the original spelling, so the assistant still reads that text as outside content.

### Changed

- Use per-request canonical paths for local input files when the client negotiates file read modes version 1; preserve standalone restrictions and output-write rules.

## [0.1.1] - 2026-08-17

### Added
- Initial release: full Browserbase API coverage — projects, sessions (incl. debug URLs, logs, replays, recording downloads, file uploads), contexts, agents, agent runs (incl. polling and messages), downloads, extensions, certificates, fetch, search, and functions (list/invoke/inspect).
