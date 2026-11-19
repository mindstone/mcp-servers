# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Google Cloud: the connector follows an operation link from a Compute Engine reply only when it is a plain `https://compute.googleapis.com` (or `www.googleapis.com`) operation path in the connected project, rebuilt on Compute Engine's own address, so the account token is never sent anywhere else.
- Safety limits on provider replies, counted as they arrive: a command's reply at about 1 MiB (measured on the reply as sent, so not an exact allowance of command text), including the E2B SDK's own streams, whose frames are each checked before the SDK allocates them; past that a command ends with a clear `OUTPUT_TOO_LARGE` error saying how to save long output to a file. E2B error replies from a computer are capped at 1 MiB, Fly.io and Google Cloud API replies at 16 MiB each. E2B's own account API replies, and the number of pages a list of computers can span, are not capped yet.
- File copies out of a computer count the bytes as they arrive and stop at 200 MB, whatever the provider says the size is.
- Fly.io: the per-computer file key is sent only to `<app>.fly.dev` when the app name is a single valid DNS label.
- Tool descriptions tell the assistant to ask the person before creating a computer (which costs money) and before destructive steps (deleting or overwriting, cancelling or stopping running work, browser steps that send, buy or delete); `computer_create` is now marked destructive.

## [0.2.0] - 2026-11-16

### Changed

- Accepts files the host has approved from outside the workspace (files/readModes v1), plus safer output file permissions and clearer read-failure messages.

### Fixed

- `computer_tools` (which lists the scripts saved on a computer with `computer_save_tool`) names any saved tool whose file could not be read, in a new `unreadable` result field, instead of hiding it, and reports a failed listing as an error rather than an empty list.

### Changed

- Use per-request canonical paths for local input files when the client negotiates file read modes version 1; preserve standalone restrictions and output-write rules.

## [0.1.0] - 2026-10-31

### Added

- Computers on your own Fly.io, E2B or Google Cloud account, set up with a browser (agent-browser) and everyday tools.
- Commands as jobs in their own cgroup that end on cancel, on their timeout, or when nobody waits on them for three minutes; idle stop after 15 minutes.
- The computer's own browser, Library file copies (and text written straight to a file), and scripts saved as reusable tools.

### Security

- Never follows an HTTP redirect, on any transport; everything a computer returns is enveloped as untrusted; account keys are kept out of errors and logs.
