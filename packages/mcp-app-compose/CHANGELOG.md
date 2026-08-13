# Changelog

All notable changes to this package are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional `draftToolName` config knob (email mode only): when set, the compose
  form grows a secondary "Save draft" action between Cancel and Send that calls
  the named tool with the same payload shape as a send, persisting the email to
  the mailbox's Drafts folder instead of sending it. The save lifecycle mirrors
  the send lifecycle (busy state, 75s lost-reply timeout with an honest
  "not sure if it saved" state, draft-routed Retry), a successful save
  collapses to a terminal stamped confirmation, and a blocked draft tool never
  triggers the send-only blocked-send escape hatch. Configs without the knob
  build byte-identical output to before.

### Changed

- The blocked-send Gmail escape hatch now prefers the structured block reason
  newer hosts forward on the JSON-RPC error (`error.data.reason ===
  'user-disabled'`, a closed enum the host derives from the tool-block error)
  and falls back to text-matching the flattened message for hosts that don't
  forward it yet. Admin-disabled and security-policy blocks still surface as
  ordinary retryable errors. Templates built without `blockedSendFallback`
  are byte-identical to before.

## [0.1.0] - 2026-07-06

### Added

- Initial extraction of the shared compose/send MCP-App iframe HTML into a
  build-time generator: `buildComposeAppHtml(config)` parameterizes resource
  URI, send-tool name, From-helper copy, CC/BCC field visibility, and the
  deep-link subsystem (closed `gmail`/`none` discriminator). With the Gmail
  configuration the output is byte-identical to the template previously
  hand-maintained in the google-workspace connector.
