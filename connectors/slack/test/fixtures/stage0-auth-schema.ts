/**
 * Copy of the host's `AuthRequiredResponseSchema` from
 * `src/main/services/mcpService.ts` (Stage 0 of the Slack OSS migration).
 *
 * This schema is the contract the OSS server's `auth_required` response must
 * satisfy. The host parses tool responses with this shape (or an equivalent)
 * and dispatches to the registered Slack OAuth orchestrator.
 *
 * If this drifts from the host's schema, both the OSS server tests AND the
 * host tests will surface the drift — at which point both copies need to be
 * updated. Using `.passthrough()` because the host expects to ignore extra
 * fields rather than reject them; the contract is "must include these
 * fields", not "must include only these fields".
 */
import { z } from 'zod';

export const Stage0AuthRequiredSchema = z
  .object({
    status: z.literal('auth_required'),
    user_action: z
      .object({
        // Host enforces .min(1) — empty string would fail the host parser
        // even though the field is "present". Mirror that constraint.
        id: z.string().min(1),
        label: z.string().optional(),
        instruction: z.string().optional(),
      })
      .passthrough(),
    agent_action: z
      .object({
        instruction: z.string().min(1),
      })
      .passthrough(),
    setupToolName: z.string().optional(),
  })
  .passthrough();

export type Stage0AuthRequiredResponse = z.infer<typeof Stage0AuthRequiredSchema>;
