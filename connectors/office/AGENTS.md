# connectors/office — scoped instructions

The repository-root `AGENTS.md` applies in full. This file records the
connector-specific exceptions and contracts that override or refine it.

## Tool input validation: SDK JSON Schema validator (approved Zod exception)

The root convention ("Code conventions") is to validate every tool input with
Zod. This connector is an explicit, human-approved exception, decided during
the OSS migration planning and recorded in planning doc
`260422_rebeloffice_oss_migration.md` (Stage 1 gotcha #2: "Do not upgrade to
Zod here") and in the `src/index.ts:2-13` file header.

- **What runs instead:** tool arguments are validated with the MCP SDK's
  official `AjvJsonSchemaValidator` (`src/index.ts:23`, constructed at
  `src/index.ts:836`) against the same hand-written JSON Schema each tool
  advertises through `tools/list` (`src/index.ts:894`). Because one schema
  object backs both advertisement and enforcement, the advertised shape and
  the enforced shape cannot drift apart.
- **Validation is pre-network:** the `CallTool` handler validates arguments
  (`src/index.ts:920`) and rejects malformed input before the tool handler —
  and therefore before any sidecar network call — is invoked
  (`src/index.ts:929`). Regression coverage: `tests/tool-definitions.test.ts`
  ("pre-network input validation").
- **Why not `McpServer#registerTool` + Zod:** this server is a lift-and-shift
  port whose handler logic and advertised tool schemas are byte-equivalent to
  the implementation the Rebel host's evals and managed-install smoke tests
  snapshot. Migrating to Zod raw shapes would regenerate every advertised
  schema through `zodToJsonSchema`, silently changing the public tool surface
  (different `additionalProperties` handling, `$schema` markers, conditional
  encodings). That modernization is a deliberately separate, dedicated pass
  (a Zendesk-v0.2.0-style SDK upgrade), not a drive-by refactor.
- **Why this is not "hand-rolled validation":** the convention bans
  hand-rolled runtime validation. AJV is one of the two validation providers
  the SDK itself ships for its JSON Schema validation extension point
  (`@modelcontextprotocol/sdk/validation/ajv-provider.js`). The local
  `registerTool` (`src/index.ts:855`) is thin registry plumbing and contains
  no validation logic.

**External (sidecar) responses** are not schema-validated either; instead
every string they return is treated as untrusted and wrapped in the
`<untrusted-content>` envelope — including non-2xx error bodies — before it
can reach the model (security invariant #6; `sidecarRequest` at
`src/index.ts:605`, `toMcpResult` at `src/index.ts:728`; tests in
`tests/sidecar-error-envelope.test.ts` and `tests/untrusted-envelope.test.ts`).

Do not "modernize" the registration or validation layer as part of unrelated
work. When the dedicated SDK-upgrade pass happens, migrate to the root
convention and delete this section.
