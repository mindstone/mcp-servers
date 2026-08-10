# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-08-10

### Changed

- First state-machine release: money-movement gate removed (host tool-approval owns invocation gating) plus the canonical envelope-helper sync.

### Fixed

- Re-synced the vendored `<untrusted-content>` envelope helper with the canonical hardened reference: attribute-bearing close-tag variants (`</untrusted-content foo>`) and spoofed open tags inside wrapped content are now escaped, closing an envelope-breakout gap an LLM parser could read as an envelope boundary.

### Changed
- **Money-movement gate removed.** `create_wise_transfer`, `fund_wise_transfer`, and `cancel_wise_transfer` now run by default; the `WISE_ALLOW_MONEY_MOVEMENT` environment variable is gone. The tools still declare `destructiveHint: true`, so invocation gating is left to the host's tool-approval layer (capability-first product decision).

### Added
- Initial connector: Wise (formerly TransferWise) integration.
- Read tools: profiles, balances, balance statements, activities, exchange rates, recipients, recipient requirements, transfers.
- Write tools: quote creation and recipient creation (no money movement).
- Money-movement tools: create, fund, and cancel transfers.
- API-token configuration via `configure_wise` (host bridge or local credential store) or the `WISE_API_TOKEN` environment variable; production/sandbox selection via `WISE_ENVIRONMENT`.
