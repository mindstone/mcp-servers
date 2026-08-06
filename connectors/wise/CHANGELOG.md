# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial connector: Wise (formerly TransferWise) integration.
- Read tools: profiles, balances, balance statements, activities, exchange rates, recipients, recipient requirements, transfers.
- Write tools: quote creation and recipient creation (no money movement).
- Money-movement tools (create, fund, and cancel transfers) gated behind `WISE_ALLOW_MONEY_MOVEMENT=1`.
- API-token configuration via `configure_wise` (host bridge or local credential store) or the `WISE_API_TOKEN` environment variable; production/sandbox selection via `WISE_ENVIRONMENT`.
