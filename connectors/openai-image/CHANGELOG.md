# Changelog

All notable changes to `@mindstone/mcp-server-openai-image` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-25

### Changed

- Workspace fence now accepts declared-Space symlink roots (matches the built-in file tools' read/write posture); request timeout retuned 90s to 180s for high-quality generation

### Security

- **Declared-Space symlink roots for the workspace fence.** `edit_image` and `generate_image` now read (and write generated images) through in-workspace symlinks whose canonical targets land inside `MCP_WORKSPACE_PATH` **or** one of the host-supplied declared-Space roots in the new `MCP_ALLOWED_SYMLINK_ROOTS` env var — the same roots the host's built-in `Read`/`Write`/`Edit` tools already trust. This fixes the reported defect where the connector's own generated-image output dir (a symlink into a cloud-synced Space) was unreadable by `edit_image`, making 18/18 `edit_image` calls fail. The fence now matches the built-ins' posture: a lexical workspace pre-gate (`path.relative`), then per-call canonical containment with fail-soft skip of an uncanonicalisable root. The previous `startsWith` containment and the cached `workspaceRealPathPromise` snapshot are removed. Invariant #5 in `mcp-servers/AGENTS.md` is amended to record this openai-image-only exception.
- **Output-write containment.** `saveImageToDisk` now applies the same workspace-or-declared-root containment to the resolved output directory before `mkdir`/`writeFile` (deepest-existing-ancestor handling), matching the host's built-in `Write` tool. An undeclared symlink target for `Chief-of-Staff`/`generated-images` is now rejected fail-closed with `WORKSPACE_FENCE_VIOLATION` instead of silently following it.
- **Whole-array validation of `MCP_ALLOWED_SYMLINK_ROOTS`.** Unset / empty / malformed JSON / non-array / any entry that is non-string, empty, or relative → the entire value is malformed → strict workspace-only + one structured stderr warning. A mixed `[validRoot, invalidEntry]` grants nothing; valid entries are not salvaged.

### Fixed

- **Symbolic fence errors.** Fence errors now name the model-supplied input path and the workspace root (never the canonical `realpath` of a symlink target) through a dedicated fence-error formatter, so the agent can self-correct instead of guessing path spellings. The global `sanitizeUserFacingText` basename-collapsing (which guards API keys, prompts, and raw OS messages) is unchanged.
- **Request timeout retuned for `quality: 'high'`.** `DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS` raised from `90000` (90s) to `180000` (3 min). The 90s cap was sized for the pre-`gpt-image-2` model; the 260422 default-quality-`high` change made high-quality generation (OpenAI documents up to ~2 min) essentially always exceed it. The `TIMEOUT` recovery copy now gives agent-actionable advice (retry once, or retry with `quality: 'medium'` for a faster draft) instead of host-env advice the agent cannot act on.
- **`WORKSPACE_FENCE_VIOLATION` error code reconciled with docs.** The README's recovery contract now lists the actual emitted codes (MED-2). No consumer keyed on the old `WORKSPACE_VIOLATION` spelling (grep-verified).

### Changed

- The `quality` `.describe()` strings on both tools now state the latency/cost tradeoff: medium ≈ ~50 s / ~$0.04; high ≈ up to ~3 min / ~$0.21. Default stays `high`.
- `server.json` `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` default updated `90000` → `180000`; optional `MCP_ALLOWED_SYMLINK_ROOTS` declaration added (for standalone OSS users).


## [0.1.2] - 2026-05-19

### Documentation

- Rewrote `README.md` to follow the structure in [`docs/CONNECTOR_README_GUIDE.md`](../../docs/CONNECTOR_README_GUIDE.md): added an italic positioning line, the `## Status` block with hyperlinked evidence, a `## Why this exists` section, a `## Example interaction` block, the `(2)` tool count in the `## Tools` heading, a Mindstone Rebel host-configuration example, a local-development host-configuration example, and renamed `## Security disclosures` to `## Security notes` for repo-wide grep consistency.
- Added the connector to the table in the repo-root `README.md`.

### Fixed

- `package-lock.json` top-level and `packages[""]` version fields were stale at `0.1.0`; they now match `package.json` at `0.1.2`.

## [0.1.1] - 2026-05-19

### Security

- **Removed `OPENAI_API_BASE_URL` env override** — the connector now hard-pins to `https://api.openai.com` so an attacker-controlled environment cannot redirect prompts, image bytes, and the bearer token to a non-OpenAI host. (Reviewer finding HIGH-1, Round 1 § 13 review.)
- **Removed prompt text from saved PNG filenames** — `generateFilename()` previously included a 40-char slug derived from the user prompt, which leaked prompt text into the filesystem and any consumer that read the saved path. Filenames are now `${timestamp}-${randomSuffix}.png` (single image) or `${timestamp}-${index+1}-${randomSuffix}.png` (batches). (Reviewer finding HIGH-2.)

### Added

- **`TIMEOUT` recovery code** — request-timeout failures now return a dedicated `TIMEOUT` code instead of being flattened into `NETWORK_ERROR`. Callers can distinguish timeout from DNS/network/caller-cancellation and surface a useful retry/raise-timeout hint. (Reviewer finding HIGH-3.)
- Legacy fallback-directory migration now refuses to follow a symlinked modern target (`MCP-Generated-Images` as symlink); a sibling `MCP-Generated-Images-safe/` directory is used instead, with a `WARN`-level log entry. (Reviewer finding MEDIUM-4.)

### Changed

- Replaced the `AbortSignal.timeout()` + `AbortSignal.any()` composition (which leaked the internal timer beyond fetch lifetime) with an explicit `AbortController` + `setTimeout` + `clearTimeout` pattern in `finally`, still composing caller cancellation. The new pattern lets us detect whether the connector-owned timeout fired vs the caller cancelled, which is what enables the new `TIMEOUT` recovery code. (Reviewer finding MEDIUM-3.)

### Documentation

- The full Round 1 § 13 reviewer pass (lens-security + reviewer-gpt5.5-high + lens-behavioral-safety) and the Round 2 fix disposition (this release) are recorded in [`docs/reports/security-reviews/260503_openai-image_0.1.0.md`](https://github.com/mindstone/MindstoneRebel/blob/main/docs/reports/security-reviews/260503_openai-image_0.1.0.md) in the consuming repo.

### Known residual findings (carried to 0.2.0+)

- **MED-1** — Realpath workspace fence is check-then-use (TOCTOU): `targetReal` is `realpath()`-validated against the workspace, but the later `stat()` + `readFile()` happen by path. Active local race could swap the file between fence check and read. Closing this requires opening + validating the file descriptor in one operation; tracked for 0.2.0.
- **MED-2** — Recovery error-code naming partially diverges from the originally documented contract (`WORKSPACE_FENCE_VIOLATION` vs `WORKSPACE_VIOLATION`, OpenAI-specific codes vs generic `UPSTREAM_ERROR`). Renaming is a breaking change and waits for 0.2.0.

## [0.1.0] - 2026-05-19

### Added

- Initial open-source release of the OpenAI image generation MCP server.
- `generate_image` tool — text-to-image via OpenAI `gpt-image-2`.
- `edit_image` tool — image edits with up to 4 reference images and an optional mask.
- Structured `{ ok, code, error, resolution }` recovery contract across 8 error codes (`NOT_CONFIGURED`, `UPSTREAM_ERROR`, `TIMEOUT`, `INVALID_INPUT`, `FILE_NOT_FOUND`, `FILE_TOO_LARGE`, `WORKSPACE_VIOLATION`, `INTERNAL_ERROR`).
- `destructiveHint: true`, `openWorldHint: true`, `idempotentHint: false` annotations on both tools per the MCP tool-annotation contract.
- Configurable request timeout via `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` (default 90 s), composing caller `AbortSignal` with the built-in timeout via `AbortSignal.any()`.
- Graceful unconfigured mode — when `OPENAI_API_KEY` is unset, empty, or equal to the literal `{{OPENAI_API_KEY}}` placeholder, the server starts cleanly and returns structured `NOT_CONFIGURED` per call instead of `process.exit(1)`.
- Workspace realpath fence on `edit_image.image_paths` and `edit_image.mask_path` to prevent symlink-escape and traversal.
- One-time idempotent legacy-folder migration (`RebelImages/` → `MCP-Generated-Images/`) when an existing Rebel host's user data is present and the target folder does not yet exist; aborts on symlinks at either path.
- Per-call sanitisation of OpenAI API keys, full prompts, and absolute file paths from logs, error payloads, and stack traces.
- 30 vitest tests across 11 files covering recovery contract, timeout behaviour, sanitisation, workspace fence, legacy migration, MIME validation, and unconfigured-mode startup.

### Security

- All known internal-reference / bridge-state hygiene strings (`MINDSTONE_REBEL_BRIDGE_STATE`, `MCP_HOST_BRIDGE_STATE`, `REBEL_WORKSPACE_PATH`, `nspr`) are absent from `src/`, `test/`, and the published tarball.
- `OPENAI_API_KEY` is read from `process.env` per tool call; the connector itself persists no credentials and writes no token files.
- See [Mindstone Rebel security review](https://github.com/mindstone/MindstoneRebel/blob/main/docs/reports/security-reviews/260503_openai-image_0.1.0.md) for the full § 13 pre-publish review record and live-API probe evidence.
