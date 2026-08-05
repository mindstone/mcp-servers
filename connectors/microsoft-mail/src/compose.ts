import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * compose_email: returns an editable draft rendered by the host as an
 * interactive MCP-App view (the compose-email iframe). Performs no Graph
 * calls — the iframe invokes send_email itself when the user clicks Send.
 *
 * The `_meta.ui` producer contract below is shared with the Gmail
 * compose_workspace_email tool; the helpers are vendored from there (each
 * connector is an independent package — no cross-connector imports) and the
 * two must stay field-for-field identical apart from the resource URI.
 */

export const COMPOSE_EMAIL_RESOURCE_URI = 'ui://microsoft-mail/compose-email';

export interface ComposeEmailParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

interface ComposeEmailResult extends CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  _meta: {
    ui: {
      resourceUri: string;
      presentation: 'primary';
      viewSummary: string;
      viewRoleLabel: string;
      structuredFallback: {
        kind: 'email-draft';
        payload: {
          to: string[];
          cc: string[];
          bcc: string[];
          subject: string;
          body: string;
        };
      };
    };
  };
  structuredContent: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    email: string;
  };
}

const ANSI_ESCAPE_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const HTML_TAG_PATTERN = /<[^>]*>/g;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sanitizeViewSummaryPart(value: string): string {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '')
    .replace(HTML_TAG_PATTERN, '')
    .trim();
}

export async function handleComposeEmail(params: ComposeEmailParams): Promise<ComposeEmailResult> {
  const to = Array.isArray(params.to)
    ? params.to.filter((addr) => typeof addr === 'string' && addr.trim().length > 0)
    : [];
  const cc = Array.isArray(params.cc) ? params.cc : [];
  const bcc = Array.isArray(params.bcc) ? params.bcc : [];
  const subject = typeof params.subject === 'string' ? params.subject : '';
  const body = typeof params.body === 'string' ? params.body : '';

  if (to.length === 0 || subject.trim().length === 0 || body.trim().length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'compose_email requires non-empty "to" (at least one recipient), "subject", and "body". Provide all three so the editable draft has content for the user to review.',
    );
  }

  // The connector's only account identity; when absent the iframe's
  // From-missing helper tells the user to recreate the draft.
  const email = (process.env.MS_ACCOUNT_EMAIL ?? '').trim();

  const recipientSummary = to.length > 0 ? to.join(', ') : '(no recipients)';
  const fallbackSubject = truncateText(subject, 256);
  const fallbackBody = truncateText(body, 5_000);
  const viewSummaryRecipient = truncateText(sanitizeViewSummaryPart(recipientSummary), 120);
  const viewSummarySubject = truncateText(sanitizeViewSummaryPart(subject), 120);
  const viewSummary = truncateText(
    `Email draft to ${viewSummaryRecipient || '(no recipients)'} — subject "${viewSummarySubject}".`,
    280,
  );

  const draftData = { to, cc, bcc, subject, body, email };

  return {
    content: [
      {
        type: 'text',
        text: `Drafting email to ${recipientSummary} with subject "${subject}"\n\n${JSON.stringify(draftData)}\n\n[View: ${COMPOSE_EMAIL_RESOURCE_URI}]`,
      },
    ],
    _meta: {
      ui: {
        resourceUri: COMPOSE_EMAIL_RESOURCE_URI,
        presentation: 'primary',
        viewSummary,
        viewRoleLabel: 'Editable email draft',
        structuredFallback: {
          kind: 'email-draft',
          payload: { to, cc, bcc, subject: fallbackSubject, body: fallbackBody },
        },
      },
    },
    structuredContent: draftData,
  };
}
