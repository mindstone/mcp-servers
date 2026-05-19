# Changelog

All notable changes to this project will be documented in this file.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-19

### Added
- Initial Google Workspace MCP server with tools for Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Comments, and account diagnostics.
- Optional Google Tasks and Forms tools behind `ENABLE_GOOGLE_TASKS_FORMS=true`.
- Host-orchestrated OAuth setup via structured `auth_required` responses.

### Security
- Removed the bundled callback server so OAuth URLs and callback handling stay with the MCP host.
- Added atomic credential writes, token-refresh disable gating, request timeouts, and internal-reference checks.
