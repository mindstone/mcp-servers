# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-12

### Added
- Read tools: `things_get_list` (Today, Inbox, Upcoming, Anytime, Someday, Deadlines, Logbook, narrowed by tag, project or area, paged), `things_search`, `things_get_item`, `things_get_project`, `things_get_overview`.
- Change tools: `things_add_todo`, `things_update_todo`, `things_set_status`, and `things_trash`. Each tool is marked read-only or destructive, so the host app decides which need the user's approval; `THINGS_READ_ONLY=1` offers the reads alone.
- Reads from a private in-memory snapshot of the Things database, so the live file is never written; runs on Node 20 and later with no native dependencies.
- Every change is checked before it is sent (so Things never shows an alert or drops it silently), re-checks the item's title, is read back, and returns how the item was before.

### Security
- User-authored text (titles, notes, tags, names) is returned inside `<untrusted-content>` envelopes, error messages included; the Things URL-scheme token never appears in results, errors or logs.
