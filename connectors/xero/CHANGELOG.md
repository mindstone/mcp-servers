# Changelog

All notable changes to `@mindstone/mcp-server-xero` are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.15] - 2026-06-08

### Added
- Initial Mindstone-scoped Xero connector fork based on the Xero fork lineage through `@harrybloom18/xero-mcp-server@0.0.14-fix.5`.
- Added optional invoice `currencyCode` support for invoice creation and draft invoice updates.
- Preserved invoice attachment tools from the current Rebel-pinned `0.0.14-fix.4` fork.
- Preserved history and note tools from the `0.0.14-fix.5` fork.

### Security
- Format Xero SDK errors using whitelisted fields so token-bearing request headers are not returned to the model.
