# Plan: Runway signed-URL upload timeout (Stage B)

Created: 2026-04-22
Status: in-review
Complexity: low
Confidence: 90%
Intent-critical: no
<!-- Routine follow-up to Stage A. No deliberate non-obvious decisions to preserve. -->

## Task
Add a request timeout to Runway's `uploadEphemeral` signed-URL `fetch` call
(`connectors/runway/src/client.ts:209`) so that a stalled 200MB upload surfaces
as a clear timeout error instead of hanging indefinitely. Stage A deliberately
deferred this path; Stage B now closes the gap.

## User Intent & Requirements

- **Problem/motivation:** Stage A GPT review surfaced: "Runway binary upload
  path has no timeout at all: `uploadEphemeral()` still does a bare
  `fetch(uploadInfo.uploadUrl, { method: 'POST', body: formData })`, so
  presigned uploads can hang indefinitely even after the timeout feature
  landed elsewhere (`connectors/runway/src/client.ts:212`)." — from
  reviewer-gpt5.4-high session `be3edaaa-8666-4ff7-b388-4be7fe6a9017`.
- **Success criteria:**
  - `uploadEphemeral` respects the same `RUNWAY_REQUEST_TIMEOUT_MS` override
    as the rest of the connector (single env var, one clean mental model).
  - Long uploads fail with an actionable error that names the env var, not a
    generic `UPLOAD_FAILED`.
  - No silent hangs.
- **Constraints/preferences:**
  - **User quote (from summary):** "extend timeout for high-risk long-running
    APIs with consistent 30s-default + clean override pattern"
  - **User AskUser answer (cadence):** "whatever is cleanest" → batch with
    Stage A under the same runway v0.3.0 tag (one release, one catalog bump).
  - **User AskUser answer (scope):** high-risk connectors only — runway is
    in scope; the other 3 don't have upload paths.
- **Verbatim quotes (user):**
  - "Stage B (separate): Runway signed-URL upload timeout fix at client.ts:190
    with own GPT review" — from Stage A summary.

## Issue Tracker
- None (mcp-servers has no tracker integration).

## Current State
- **Active constraints:**
  - Must follow the Stage A attribution pattern: `timeoutSignal.aborted` to
    distinguish our timeout from other errors.
  - **Separate `RUNWAY_UPLOAD_TIMEOUT_MS` with 10-min (600_000 ms) default**
    for the signed-URL upload path. Rationale: 60s default for `RUNWAY_REQUEST_TIMEOUT_MS`
    is calibrated for API calls (submit + poll, sub-second); a 200MB upload on
    a 5 Mbps link takes ~5.3 min raw, so 10 min gives comfortable headroom for
    TLS + multipart overhead. Bumped from initial 5-min proposal after
    Phase 5 review feedback ("aggressive not comfortably safe"). Validated via
    same `parseTimeoutEnv`.
  - Mental model: two env vars, two workloads — "API calls are fast, uploads
    are slow". Error message points at the right one.
- **Completed stages:** none (Stage A is a separate task, already committed
  as `e1cf9d2`)
- **Next stage:** Stage 1
- **Open questions:** none

## Research Notes
- `uploadEphemeral` (lines 163-216 of `src/client.ts`) does two HTTP calls:
  1. `runwayFetch('/uploads', ...)` — gets signed upload URL. Already timed
     out via Stage A.
  2. `fetch(uploadInfo.uploadUrl, { method: 'POST', body: formData })` —
     public S3-like signed URL. **No timeout today.** Target of Stage B.
- FormData upload with a 200MB Buffer streams through the fetch Body. If
  the remote hangs after TCP connect, undici will sit on a half-open
  connection forever (fetch has no default timeout in Node).
- `AbortSignal` cancels the entire stream — including mid-upload. That's the
  right behaviour: we want the upload to stop if it stalls.
- The existing `UPLOAD_FAILED` branch handles HTTP-level failures; a timeout
  should throw `TIMEOUT` with the canonical "set `RUNWAY_REQUEST_TIMEOUT_MS`"
  resolution, matching Stage A.
- `runwayFetch` and `runwayFetchBinary` both already use the Stage A pattern.
  `uploadEphemeral` is the only fetch in the file still using a bare `fetch`.

## Refactor Assessment
- **Areas evaluated:** `uploadEphemeral`, `runwayFetch`, `runwayFetchBinary`.
- **Refactor recommended:** no (for now).
- **Rationale:** A `withTimeout(fetch, timeoutMs)` helper could DRY the
  three paths, but:
  1. Each path has slightly different auth/header injection needs.
  2. The three catch blocks are short and identical in shape.
  3. Extraction would cross the 30-file Stage A boundary into a new file.
  4. Would block this fix on a refactor review, when the timeout bug is
     the user-visible issue.
  Keep as inline pattern for now; note extraction as a future FOLLOW-UP.

## Root Cause Assessment
- **Assessment:** root cause.
- **Justification:** `uploadEphemeral` literally does not have a timeout.
  We add one. There is no deeper cause — this is the cause.

## Performance Considerations
- **Hot paths affected:** `resolveMediaInput` → `uploadEphemeral` for large
  files (>data-URI limit per category). Called once per tool invocation on
  large uploads.
- **Potential impact:** Effectively none. `AbortSignal.timeout` allocates
  one timer + one signal per call; negligible.
- **Mitigation:** none needed.

## Verification Notes
- **Integration risks:** Real signed-URL uploads are hard to mock at the
  `fetch` level (the URL is dynamic, comes from `/uploads`). MSW handlers
  intercepting a wildcard `https://*.amazonaws.com/*` is the standard
  approach — check how runway tests already mock this.
- **Key test to write:** "uploadEphemeral aborts stalled upload with
  `TIMEOUT` error mentioning `RUNWAY_REQUEST_TIMEOUT_MS`". Mirror the test
  pattern from `runwayFetch` timeout tests (500ms override + msw delay).

## Stages

### Stage 1: Add `RUNWAY_UPLOAD_TIMEOUT_MS` + wrap `uploadEphemeral` signed-URL fetch
- Status: pending
- Files:
  - `connectors/runway/src/types.ts` — add `DEFAULT_UPLOAD_TIMEOUT_MS = 300_000`
    and `getUploadTimeoutMs()` using the existing `parseTimeoutEnv` helper
  - `connectors/runway/src/client.ts` — wrap the `fetch(uploadInfo.uploadUrl, ...)` call
  - `connectors/runway/README.md` — document `RUNWAY_UPLOAD_TIMEOUT_MS`
  - `connectors/runway/test/errors.test.ts` — add upload-timeout test using
    deterministic `https://runway-uploads.example.com/upload` (the runway mock
    server's fixed upload URL) with MSW `http.post` + delay. Add invalid-env
    fallback test.
- Description:
  - In `types.ts`, append:
    ```typescript
    export const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000; // 10 min — calibrated for 200MB uploads with headroom
    export function getUploadTimeoutMs(): number {
      return parseTimeoutEnv('RUNWAY_UPLOAD_TIMEOUT_MS', DEFAULT_UPLOAD_TIMEOUT_MS);
    }
    ```
  - In `client.ts` `uploadEphemeral`, replace the bare fetch with:
    ```typescript
    const uploadTimeoutMs = getUploadTimeoutMs();
    const uploadTimeoutSignal = AbortSignal.timeout(uploadTimeoutMs);
    let uploadRes: Response;
    try {
      uploadRes = await fetch(uploadInfo.uploadUrl, {
        method: 'POST',
        body: formData,
        signal: uploadTimeoutSignal,
      });
    } catch (error) {
      // Attribute timeout to OUR signal only. No caller signal is plumbed here,
      // so a bare timeoutSignal.aborted check is sufficient (same shape as
      // napkin's downloadFile path).
      if (uploadTimeoutSignal.aborted) {
        const timeoutSec = Math.round(uploadTimeoutMs / 1000);
        throw new RunwayError(
          `Runway upload timed out after ${timeoutSec}s`,
          'TIMEOUT',
          `The signed-URL upload took longer than ${timeoutSec}s. Set RUNWAY_UPLOAD_TIMEOUT_MS to increase the timeout, or reduce the file size / use a faster connection.`,
        );
      }
      throw error;
    }
    ```
- Rationale: Preserves the existing error taxonomy (`TIMEOUT` vs
  `UPLOAD_FAILED`), uses the Stage A attribution pattern, but with a
  workload-appropriate default (5 min vs 60s). Separate env var keeps upload
  tuning independent of API-call tuning, so a fast-fail API config doesn't
  prematurely abort a legitimate slow upload.

## Assumptions
| # | Assumption | If wrong | Validation | Needs spike? |
|---|-----------|----------|------------|-------------|
| A1 | `AbortSignal` on `fetch` cancels the in-flight upload body stream in Node 20 undici | Abort arrives but upload continues in background | Read test runs msw; observe connection close | no — well-documented undici behaviour |
| A2 | The `uploadEphemeral` function is called only from `resolveMediaInput` | Other call sites might need different timeouts | `rg 'uploadEphemeral' connectors/runway` | no |
| A3 | `RUNWAY_REQUEST_TIMEOUT_MS=60000` is enough for typical 200MB uploads | Large uploads over slow links fail after 60s | User can raise the env var; documented | no — user-tunable |

## Discovered Improvements
| ID | Category | Description | Action |
|---|---|---|---|
| I1 | FOLLOW-UP | Consider extracting `timedFetch(url, opts, timeoutMs)` helper to DRY runwayFetch / runwayFetchBinary / uploadEphemeral / bridge | follow-up |
| I2 | FOLLOW-UP | Nano-banana 0.3.0 still has the attribution bug fixed in Stage A; 0.3.1 backport | follow-up |

## Amendments
- **2026-04-22 A1**: Changed from unified `RUNWAY_REQUEST_TIMEOUT_MS` to
  separate `RUNWAY_UPLOAD_TIMEOUT_MS` with **5-min** default. Trigger: DA
  (88%) + GLM5 (85%) reviewers both flagged that 60s default is too
  aggressive for 200MB uploads on typical slow links (~5 min at 5 Mbps).
  GPT-5.4 (92%) had approved unified approach but didn't explicitly
  consider slow-link UX. Two-env model keeps upload tuning independent.
- **2026-04-22 A2**: After Phase 5 review feedback ("5-min default is
  aggressive, not comfortably safe"), bumped default to **10 min**
  (`DEFAULT_UPLOAD_TIMEOUT_MS = 600_000`). 200MB at 5 Mbps is 5.3 min
  raw; 10 min covers TLS + multipart overhead without cutting close.
- **2026-04-22 A3**: Test refinements per Phase 5 review:
  - Rewrote invalid-env fallback test to actually reach
    `getUploadTimeoutMs()` (was giving false coverage — auth check fired
    before upload path).
  - Added non-timeout-attribution test (HTTP 500 not mislabeled as
    `TIMEOUT`) per Behavioral Safety suggestion.
  - Positive timeout test now asserts both `'timed out'` and `'TIMEOUT'`
    error code per GPT-5.4 NIT.

## Review History
- 2026-04-22: Plan self-authored by Chief; heavy critique (3 reviewers launched).
- 2026-04-22: reviewer-gpt5.4-high: 92%, no must-address
- 2026-04-22: reviewer-gemini3.1-pro: FAILED (unstructured meta-response) → substituted reviewer-glm5
- 2026-04-22: reviewer-glm5: 85%, no must-address, flagged upload UX concern
- 2026-04-22: reviewer-gpt5.3-codex (DA): 88%, 2 must-address (timeout coupling + test realism) — both addressed in amendment above.

## Reviewer Scoring (Phase 2)
- reviewer-gpt5.4-high: 92% — approved as-is; one test nit accepted (use deterministic URL)
- reviewer-glm5: 85% — upload-UX suggestion accepted (led to amendment)
- reviewer-gpt5.3-codex (DA): 88% — both must-address items accepted and fixed
