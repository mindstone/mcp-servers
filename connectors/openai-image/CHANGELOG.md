# Changelog

All notable changes to `@mindstone/mcp-server-openai-image` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-08-10

### Changed

- Close F-3 through F-8: canonical envelope hardening (attribute-bearing close tags, spoofed open tags), race cleanup, 4MB body cap, strict port parsing.

### Fixed

- Envelope helper hardened (F-3): re-synced the vendored `<untrusted-content>` helper with the canonical reference — attribute-bearing close-tag variants (`</untrusted-content foo>`) and spoofed open tags inside wrapped content are now escaped, and the envelope-span matcher used by the output sanitizer accepts the same attribute-bearing close forms.
- Escaped-file remediation (F-4): when the post-link (or post-fallback-write) directory re-verification detects a swap that landed the generated file outside the workspace fence, the file is now unlinked best-effort before the fence violation is rethrown — the violation fails contained, not merely detected.
- Workspace-path resolution errors no longer embed raw OS error text (F-5); the fallback reports the uppercase errno code only, matching the read-error policy.
- The HTTP transport's request-body reader is bounded at 4 MB per request (F-6); over-limit bodies are rejected and the request destroyed instead of being buffered without limit.
- Latent fail-opens closed (F-7): the envelope-echo helper fails closed (emits nothing) if wrapping ever declines, and the magic-byte validator throws `INVALID_IMAGE_DATA` for an unrecognised extension instead of silently skipping validation (both unreachable today).
- `MCP_HTTP_PORT` parsing is strict (F-8): whole-string digits only, bounded to 1-65535, failing fast on values like `8080abc` that `parseInt` previously truncated.

## [0.3.1] - 2026-08-08

### Changed

- Allow moderation 'low' by default: the OPENAI_IMAGE_ALLOW_LOW_MODERATION opt-in gate is removed; invocation gating is the host tool-approval layer's job.

### Changed

- **Moderation opt-in gate removed.** `moderation: 'low'` no longer requires `OPENAI_IMAGE_ALLOW_LOW_MODERATION=1` and is allowed by default like any other tool input; invocation gating is the host's tool-approval layer's job. The env variable, its `server.json` declaration, and the gate wording in the tool schemas and README are gone.

## [0.3.0] - 2026-08-08

### Changed

- OpenAI image connector: request-timeout ceiling, strict parsing, read-fence inode binding against symlink-swap races, moderation opt-in gate.

### Added

- `output_format` (`png | jpeg | webp`) and `output_compression` (0–100, jpeg/webp only) options on `generate_image` and `edit_image`. Saved filename extensions (`.png` / `.jpg` / `.webp`) and inline preview MIME types follow the chosen format. `output_compression` combined with `png` output fails fast with a structured `INVALID_INPUT` error before any API call.
- `background` (`transparent | opaque | auto`) option on both tools. `background: 'transparent'` is gated: it fails fast with `INVALID_INPUT` when combined with `jpeg` output (no alpha channel) or with the default `gpt-image-2` model, which rejects transparent backgrounds upstream — the resolution suggests `OPENAI_IMAGE_MODEL=gpt-image-1.5` (or `gpt-image-1`). Unknown model overrides pass through to upstream validation.

### Security

- **MED-1 closed: edit-image file loading is now open-then-validate, with the fence decision bound to the opened inode.** The workspace fence previously validated a reference/mask image's canonical `realpath` and then read the file by path, leaving a check-then-use (TOCTOU) window where a local race could swap the file between fence check and read. `edit_image` now opens a descriptor, confirms via `fstat` that the opened inode (`dev`/`ino`) agrees with the baseline stat, then — closing the residual fence→stat window flagged in pre-release review (F-1), where a symlink swapped in post-fence would pass a stat/open agreement check on its out-of-fence target — re-resolves the canonical path *after* the open (as a synchronous `realpathSync`→`lstatSync` pair — two adjacent syscalls, no attacker-widenable event-loop hop between them) and requires it to be byte-identical to the path the fence approved, and `lstat`-checks that it still names the pinned inode (a canonical path has no symlink leaf by construction, so a swap-back that flips the leaf to a symlink between the re-resolution and the identity check is exposed instead of followed). On Linux the descriptor itself is then resolved via `/proc/self/fd/<fd>` — the kernel's canonical path for the pinned inode, with no pathname window — and containment is re-checked on that; an environment without `/proc` fails closed with a distinct "could not be verified safely" message rather than a misleading "not found". Size bounds are re-checked against the opened descriptor and bytes are read through the descriptor, so a path swap at any point fails closed with `WORKSPACE_FENCE_VIOLATION` ("changed while it was being verified") before any bytes leave the workspace. Documented residuals: on platforms without `/proc` (Node exposes no `openat`/`F_GETPATH`) a directory-component swap timed between the post-open re-resolution and the identity check can still redirect that check — the same unclosable-syscall-instant class as the write side's check→link window; and canonical-prefix containment cannot see hard links (pre-existing, cohort-wide). The race test suite now exercises real on-disk pathname swaps — a plain post-fence symlink swap and the three-rename swap-back variant — not only a mocked `open`.
- **Attacker-controlled text in model-visible errors is now enveloped (invariant #6).** Tool-input paths (`image_paths`, `mask_path`) and the configured `OPENAI_IMAGE_MODEL` value echoed into error messages are wrapped in `<untrusted-content source="…">` envelopes with close-tag breakout escaping, via the canonical vendored helper (`src/untrusted-content.ts`, kept byte-for-byte in sync with `connectors/_template`). A crafted `image_paths` value carrying a mixed-case or whitespace-mutated `</untrusted-content>` variant can no longer break out of the result envelope. `sanitizeUserFacingText` is now envelope-aware: path-collapsing runs only outside envelope spans, so it no longer mangles an envelope's own close tag. The full supplied path remains visible inside the envelope — fence errors stay actionable.
- **Output-write TOCTOU closed.** Generated-image saves were check-then-use: the fence canonicalised and approved the output directory, then `mkdir`/`writeFile` re-accessed it by pathname, leaving a window where a local attacker could swap `generated-images` (or an ancestor) for a symlink and land generated bytes outside the workspace/declared roots — including a swap-back variant that defeated a post-open `realpath` re-check while bytes flowed through the already-opened descriptor. Saves now write through the canonical directory (which contains no symlink components, so no swap can redirect it), never the validated pathname: the bytes are staged in a fresh `mkdtemp` directory (mode `0700`) created atomically inside the canonical directory, written through a single `wx` descriptor (mode `0600`), then hard-linked into place (`link` fails with `EEXIST` if the destination name is taken, by a real file or a planted symlink; filesystems without hard-link support fall back to an exclusive create at the destination). The directory's canonical identity is re-verified before any bytes flow; a mid-flight swap fails closed with `WORKSPACE_FENCE_VIOLATION` ("changed while the image was being saved") and the staging directory is cleaned up. Behavioral fault-injection race tests cover the swap landing before both the staging creation and the file open.
- **Upstream response hardening.** Success payloads are Zod-validated (previously cast): a malformed body fails closed with an observable `NETWORK_ERROR`. Returned image bytes must match the requested format's magic bytes (PNG/JPEG/WEBP signatures): mismatched payloads are rejected with `INVALID_IMAGE_DATA` instead of being saved under a false extension and inline MIME type. Upstream error bodies remain classification-only and never reach model-visible errors (regression-tested).
- **Raw OS error text removed from model-visible read errors.** The fallback branch of the local-read error formatter appended the raw OS error message, which embeds the caller-controlled path a second time, un-enveloped — and the path-collapsing sanitiser could reassemble a close-tag variant split across the final path segment, reopening an envelope-breakout channel (invariant #6). The message now carries only the enveloped input path plus Node's safe uppercase error code (e.g. `(error ENOTDIR)`).
- **Output-write race window at the link step closed.** The canonical-identity re-check previously ran only before the staging write; a local attacker swapping the output directory (or an ancestor) for a symlink after that check could break the staging pathname (`ENOENT`) and redirect the exclusive-create fallback's open through the swapped symlink, landing generated bytes outside the workspace/declared roots. The directory's canonical identity is now re-verified immediately before the hard link, once more after a successful link, and before and after the fallback's exclusive create — a mid-flight swap anywhere in the save sequence fails closed with `WORKSPACE_FENCE_VIOLATION`, and a fence violation raised at the link step is no longer mistaken for a missing-hard-link-support error. Behavioral fault-injection tests cover swaps landing at the link, between a failed link and the fallback open, and immediately after a successful link, plus the no-hard-link fallback's happy path.
- **Unsupported-image-type error now envelopes the caller-controlled extension.** The one remaining echo site that skipped the envelope — the `Unsupported image type: <ext>` message in `edit_image` — let an in-fence filename whose extension carried attacker text (e.g. a spoofed `<untrusted-content source="system">` open tag with no slash, which path-collapsing does not touch) reach the model-visible error un-enveloped, deviating from the connector's invariant-#6 policy. The extension/filename fallback is now enveloped like every other echoed input; regression-tested through the MCP client boundary with a live filesystem fixture.
- **`moderation: 'low'` is now gated behind an explicit env opt-in (F-2).** `moderation` is a model-controllable tool input forwarded upstream on `gpt-image-2`, so a prompt injection in any document the agent reads could append `"moderation": "low"` and weaken OpenAI's content filtering on the user's account. Both tools now fail fast with `INVALID_INPUT` (before any API call) when `low` is requested without `OPENAI_IMAGE_ALLOW_LOW_MODERATION=1` in the server environment; `auto` remains the default and is unaffected. The gate is declared in `server.json` and documented in the README.

### Changed

- `server.json` now declares the optional `MCP_HTTP_PORT` environment variable (loopback-only HTTP transport), closing the manifest drift between the code and the registry declaration. `OPENAI_IMAGE_IMPORT_ONLY` remains undeclared by design: it is a test-harness escape hatch, not a runtime configuration knob.

### Fixed

- `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` validation now matches the documented contract (`server.json`, README): the value must be a base-10 integer string between 1 and 1800000 ms (30 minutes). Non-integer input (`1e9`, `180000abc`, `30000.5`) was previously truncated by `parseInt`, and values above the documented maximum were accepted; both now fall back to the 180000 ms default with a structured warning.

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
