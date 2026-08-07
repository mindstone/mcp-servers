# Changelog

All notable changes to `@mindstone/mcp-server-microsoft-calendar` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-07

### Changed

- Microsoft Calendar connector: canonical result envelopes, untrusted-content fencing, and hardening sync; expanded event/calendar actions.

### Added
- `get_event` gains `includeAttachments` to list attachment metadata (id, name, contentType, size).
- `cancel_event` tool: organizer-side cancellation with an optional message to attendees (distinct from `delete_event`, which gives no message).
- `update_event` now supports `addAttendees` / `removeAttendees`, merged against the event's current attendee list (Graph PATCH replaces the whole collection, so the connector reads it first).
- `create_event` / `update_event` accept a `recurrence` object (Graph `pattern`/`range`, Zod-validated and passed through) for recurring events.
- `find_meeting_times` tool: suggests slots within a window when all given attendees are free, computed from `getSchedule` free/busy data (deliberately not Graph's `findMeetingTimes` action, which is v1.0 but known-flaky). Slot start/end can be passed straight to `create_event`.
- `list_events` JSON output now includes per-attendee RSVP detail (email, name, type, response status) alongside the existing `attendeeCount`.

### Changed
- Microsoft Graph responses on the event read/write paths (`list_events`, `get_event`, `create_event`, `update_event`, `find_meeting_times`) are now validated with Zod at the boundary; malformed payloads fail closed with a clear error instead of a downstream TypeError. The remaining cast (`get_free_busy`) is still planned debt.
- Tool inputs are validated fail-closed before any Graph request: attendee/email fields require email addresses, date-time fields require ISO 8601, numeric knobs (`top`, `durationMinutes`, `intervalMinutes`, `maxSuggestions`) require bounded positive integers, and recurrence `pattern`/`range` objects are strict (unknown keys rejected) with the documented cross-field rules (`endDate` requires `endDate`, `numbered` requires `numberOfOccurrences`).
- `find_meeting_times` only suggests slots when availability for EVERY requested attendee was resolved; attendees whose schedule row Graph omits (or returns without an `availabilityView`) are listed in `unresolvableAttendees` and no slots are returned.
- `list_events` and `get_event` attachments no longer silently drop Graph pages: the response reports `truncated` / `attachmentsTruncated` when an `@odata.nextLink` is present (the vendor-supplied continuation URL itself is never surfaced).
- `update_event` no longer risks sending `{ address: undefined }` to Graph: current attendees without an email address are left out of the merged list and reported in the response.

### Security
- Envelope every Graph-sourced string that reaches model-visible output: structural-looking fields (IDs, `webLink`/meeting URLs, attendee `type`/`status`, `bodyType`, attachment `id`/`contentType`, `scheduleId`, `availabilityView`, timestamps, calendar `color`) pass through raw only when they match their documented closed format and are enveloped otherwise.
- Envelope vendor-authored error text (`formatGraphError` output, which interpolates the Graph error-body message) before it becomes model-visible, closing a prompt-injection path through crafted Graph error responses.
- Widened the untrusted-content close-tag escaping to all whitespace variants (`</untrusted-content\n>`, `\r`, form feed), matching the sibling connectors.
- Stopped logging the mailboxSettings failure message verbatim; only status/code are logged so a vendor response body cannot reach logs unsanitised.
- Envelope Graph-sourced timezone names before they reach model-visible output (`timezoneInfo.resolved`/`calendarTimezone`/`deviceTimezone` on `list_events` and `find_meeting_times`, plus the `find_meeting_times` `timeZone` field and `note`): `mailboxSettings.timeZone` passes through `windowsToIanaTimezone` unchanged when unknown, so an anomalous tenant-controlled value could previously arrive raw.
- `list_calendars` now validates the Graph response with Zod and shapes `owner` down to `name`/`address` instead of forwarding the vendor object wholesale. Envelope helpers wrap string values, never object keys, so unknown attacker-injected keys can no longer reach model-visible output.
- Event/calendar IDs supplied to `list_events`, `get_event`, `update_event`, `delete_event`, `cancel_event`, and `respond_to_event` are now gated before interpolation into Graph request paths: values containing `?`, `#`, `%`, `\`, whitespace, or `.`/`..` path segments are rejected before any network request is made (so a crafted ID cannot reroute the authenticated request within the shared Microsoft token's scope), and accepted IDs are URL-encoded at the interpolation site, matching the sibling connectors.

## [0.1.2] - 2026-07-03

### Changed

- Envelope external Microsoft 365 content in <untrusted-content> before returning to the model (FOX-3490); float microsoft-shared to ^0.1.0 (0.1.1).

## [0.1.1] - 2026-05-19

### Documentation

- Rewrote `README.md` to follow the structure in [`docs/CONNECTOR_README_GUIDE.md`](../../docs/CONNECTOR_README_GUIDE.md): added an npm-version badge, an italic positioning line, the `## Status` block with hyperlinked evidence and `Hosts tested` / `Machine-readable` rows, a `## Why this exists` section, an `## Example interaction` block, `## Host configuration examples` (Claude Desktop / Cursor and local development), the `(8)` tool count in the `## Tools` heading, and a `## Security notes` section.
- Added the connector to the table in the repo-root `README.md`.

### Planned
- Migrate to `@mindstone/mcp-server-microsoft-shared` from its npm-registry version once `0.1.0` of the shared package is published; the `0.1.0` cohort port currently consumes the shared package as a packed `file:` dependency.
- Tighten Zod validation of Microsoft Graph response payloads in `0.2.0` or later.

## [0.1.0] - 2026-05-19

Initial public release of the Microsoft 365 Outlook Calendar MCP server. Eight tools across event listing, retrieval, creation, update, deletion, response, free/busy lookup, and calendar enumeration via Microsoft Graph.

### Added
- Eight calendar tools: `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `respond_to_event`, `get_free_busy`, `list_calendars`.
- Host-orchestrated auth handoff: token-expired and refresh-disabled errors return the structured `auth_required` envelope pointing at the cohort's `authenticate_microsoft_account` host setup tool; the calendar connector does **not** declare an auth tool of its own (cohort decision — Mail owns the M365 OAuth surface; Calendar/Files/Teams reuse it via host-side routing).
- Token-refresh fail-closed mode via `MICROSOFT_DISABLE_REFRESH=1` (defaults to off; the cloud surface flips it on so tokens cannot rotate without the desktop session).
- Cohort 60s upstream-request timeout with `MICROSOFT_REQUEST_TIMEOUT_MS` override; abort signals compose via `AbortSignal.any()`.
- Calendar timezone resolution preserved 1:1 with the bundled connector: priority `mailboxSettings.timeZone` → `deviceTimezone` (from system prompt) → UTC fallback; mailbox-settings `403` no longer crashes `list_events` (the original bundled regression-fix is retained).

### Security
- Uses the new `McpServer + registerTool + Zod` SDK pattern (cohort `MCP_SERVER_STANDARD`).
- Reads version from `package.json` via `createRequire(import.meta.url)`, so the reported server version cannot drift from the npm artifact.
- Internal-reference scan enforced as part of `npm run build` to block host-internal bridge symbols and workspace paths from shipping in the published tarball.
