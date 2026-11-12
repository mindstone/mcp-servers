# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The host bridge state file is checked before use: it must be a regular file (not a symbolic link or pipe), of bounded size, valid JSON, with a valid port. The bridge is only ever reached on `127.0.0.1`. Bridge replies that redirect are refused, so the bridge token, and a Wise token sent to the bridge, never leave loopback.
- Bridge replies are checked against a schema, and any text from them that reaches the model is enveloped.
- Locally saved credentials are written atomically with `0600` permissions. A save that fails before the new file replaces the old one keeps the previous credentials; one that fails after that may leave the new credentials in place. Either way `configure_wise` reports `SAVE_FAILED`. A symbolic link at the credentials path is refused for reading and writing.
- Each token is sent only to the Wise host of the environment it was saved for. Before this, a saved sandbox token could be sent to production.
- Unexpected errors return fixed text instead of the raw error message, and logs record only an error code.
- `configure_wise` keeps its "token rejected" answer, with its hint, even when the rest of the rejected reply fails to download.
- Exchange rates, quote notice links and funding replies are now enveloped.
- A funding rejection no longer quotes Wise's error code in its message; the code is still in the enveloped `payment` record. Only an insufficient-funds rejection suggests topping up; any other says to check the transfer first. A funding reply of the wrong shape gives a fixed error that says to check the transfer before retrying.
- Wise API requests, including the token check, refuse redirects, so only the two Wise hosts are ever contacted.
- A write that gets a success status with an unreadable reply says Wise may have acted on it and to check before trying again, instead of advising a retry.
- Connector-written messages quote a Wise value only after a type check: ids only when numeric, counts only from a checked list, and no status strings.
- Profile auto-selection checks the profiles reply and requires the chosen id to be a positive integer before it goes into a URL.
- The activities cursor is returned only when it uses an opaque-token alphabet; otherwise pagination stops. This limits its characters; it does not prove the cursor came from Wise.
- The MCP SDK is pinned to 1.32.2, and its HTTP-server dependencies are updated to fixed versions. The connector runs over stdio only, so none of the advisories these fix were reachable from it.
- Text from the service that contains an untrusted-content tag is now escaped the same way as in every other connector, open and close tags alike, keeping the original spelling, so the assistant still reads that text as outside content.

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
