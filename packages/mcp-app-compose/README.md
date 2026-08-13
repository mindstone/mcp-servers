# @mindstone/mcp-app-compose

Build-time generator for the compose/send MCP-App iframe HTML shared by email-shaped
connectors. `buildComposeAppHtml(config)` returns the complete self-contained HTML
document a connector serves as its `ui://` compose resource.

**Not published to npm.** Consume it as a `file:` devDependency:

```json
"devDependencies": {
  "@mindstone/mcp-app-compose": "file:../../packages/mcp-app-compose"
}
```

Connectors keep a small codegen script (see
`connectors/google-workspace/scripts/gen-compose-html.mjs`) that calls the builder with
their config and writes the generated template into `src/resources/`, which stays
committed. The script's `--check` mode is wired into the connector's `pretest`, so
`npm test` fails if the committed output drifts from the generator.

## Config surface

The config is deliberately tiny — only what genuinely differs between connectors:

- `resourceUri` — the `ui://` URI the connector serves the HTML under.
- `sendToolName` — the tool the iframe calls (`tools/call`) when Send is clicked.
- `draftToolName` — optional (email mode only): the tool the iframe calls when
  Save draft is clicked. When set, the form grows a secondary Save-draft action
  between Cancel and Send that persists the email to the mailbox's Drafts folder
  instead of sending; the tool must accept the same payload shape as the send
  tool. Omit it and the output stays byte-identical to the compose/send-only
  template.
- `fromMissingHelperText` — helper copy shown when the draft carries no sending account.
- `fields.cc` / `fields.bcc` — whether to render the CC/BCC rows and their toggles.
- `deepLink` — discriminator: `{ kind: 'gmail' }` inlines the Gmail "open the sent
  message" deep-link subsystem verbatim; `{ kind: 'none' }` omits it entirely. It is
  deliberately **not** a config-provided URL template: deep links stay code-reviewed
  in this package, never string-assembled from config.

Everything else — theming, the collapsed/form/sent view state machine, the send
lifecycle and timeout handling, address parsing, draft ingestion (including the
permanent pre-A0 envelope migration shim), the host postMessage protocol, and the
sandbox workarounds — is shared verbatim. Change it here once, regenerate every
consumer, and each connector's committed template diff shows exactly what changed.

## Byte-parity contract

With the Gmail config, the builder's output is byte-identical to the previously
hand-maintained Gmail template (`connectors/google-workspace/test/compose-email-parity.test.ts`
pins this against a committed golden fixture). Treat that parity as the regression
gate when editing the template: behavioural changes should be deliberate, visible in
regenerated diffs, and covered by the Gmail behavioural suite.

## Module layout

- `src/buildComposeAppHtml.mjs` — the builder, plain ESM with JSDoc types. It is `.mjs`
  (not `.ts`) so connector codegen scripts can import it under plain `node` in
  `pretest`/CI, where no TypeScript loader is available (CI runs node 20 and 22).
  Import path for codegen scripts: `@mindstone/mcp-app-compose/template`.
- `src/buildComposeAppHtml.d.mts` — hand-maintained declaration twin so TypeScript
  consumers of the `/template` subpath get real types; update it alongside the `.mjs`.
- `src/index.ts` — typed façade for TypeScript/vitest consumers (re-exports the builder
  and the config types).
- `src/types.ts` — `ComposeAppConfig` and friends.
