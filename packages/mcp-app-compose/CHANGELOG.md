# Changelog

All notable changes to this package are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Compose cards hide Retry when sending is blocked by your settings, your organization or security policy. Cancel stays available; a stopped server still offers Retry.
- Compose cards keep the send time across copies and reloads in supporting hosts. Reloaded sent cards hide Reopen because they do not have the sent contents. The copy that sent retains its posted contents even when its reply was lost before host confirmation. Malformed host timestamps use an undated sent bar.
- Unconfirmed sends retain the reminder to check whether the message was sent through edits, Cancel and Reopen. Calls blocked before sending, including `not-dispatched` failures, still say "Nothing sent." A later block does not erase an earlier uncertain send.
- Retry stays unavailable after your own setting blocks sending. Block classification uses only the host's closed `error.data.reason`, never message text.
- After a draft-save timeout, Cancel says "Nothing sent" because saving a draft does not send it; an earlier uncertain send still keeps its check-before-resending wording.

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

- Send requests declare `_meta: { 'mcp-app/cardOutcome': 'sent' }` for supporting hosts; draft-save requests do not declare a send outcome.
- The blocked-send Gmail escape hatch uses only `error.data.reason === 'user-disabled'`. Admin-disabled, security-policy and not-dispatched failures do not open the escape hatch.
- The compose form's built-in wording no longer names a particular host app:
  the lost-reply notices now start "No confirmation came back in time…", the
  Slack direct-message notice reads "This will be sent as a direct message to
  the person you asked to contact.", and a code comment shipped inside the HTML
  now says "The host renders this iframe".

## [0.1.0] - 2026-07-06

### Added

- Initial extraction of the shared compose/send MCP-App iframe HTML into a
  build-time generator: `buildComposeAppHtml(config)` parameterizes resource
  URI, send-tool name, From-helper copy, CC/BCC field visibility, and the
  deep-link subsystem (closed `gmail`/`none` discriminator). With the Gmail
  configuration the output is byte-identical to the template previously
  hand-maintained in the google-workspace connector.
