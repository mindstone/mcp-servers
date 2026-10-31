# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-31

### Added

- Computers on your own Fly.io, E2B or Google Cloud account, set up with a browser (agent-browser) and everyday tools.
- Commands as jobs in their own cgroup that end on cancel, on their timeout, or when nobody waits on them for three minutes; idle stop after 15 minutes.
- The computer's own browser, Library file copies (and text written straight to a file), and scripts saved as reusable tools.

### Security

- Never follows an HTTP redirect, on any transport; everything a computer returns is enveloped as untrusted; account keys are kept out of errors and logs.
