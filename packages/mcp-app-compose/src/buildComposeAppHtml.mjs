// Shared compose/send MCP-App iframe template for email-shaped connectors.
//
// Lifted verbatim from the shipped Gmail compose template
// (connectors/google-workspace/src/resources/compose-email-template.ts); with the
// Gmail config the output is byte-identical to that template, pinned by
// connectors/google-workspace/test/compose-email-parity.test.ts. Only the
// genuinely connector-specific sites are parameterized: resource URI, send tool
// name, From helper copy, CC/BCC visibility, and the deep-link subsystem.
//
// Plain ESM (.mjs, JSDoc types) so connector codegen scripts can import it under
// plain `node` in pretest/CI, where no TypeScript loader is available.
// Typed consumers import the src/index.ts facade instead.

/** @typedef {import('./types.js').ComposeAppConfig} ComposeAppConfig */

const RESOURCE_URI_PATTERN = /^ui:\/\/[A-Za-z0-9._/-]+$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
// Config strings are spliced into single-quoted JS string literals inside the
// template's inline <script>. Banning <, >, backticks, backslashes, and newlines
// means no spliced value can form a </script> terminator, escape the string
// literal, or inject markup.
const HELPER_TEXT_FORBIDDEN = /[<>`\\\r\n]/;

/** @param {string} value */
function quoteJsString(value) {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** @param {ComposeAppConfig} config */
function assertComposeAppConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('[mcp-app-compose] config must be an object');
  }
  // Closed mode discriminator. `email` (the default when absent) keeps the two
  // existing email configs byte-identical; `slack`/`teams` select the chat
  // shape. Everything the modes share stays baked into the template.
  const mode = config.mode === undefined ? 'email' : config.mode;
  if (mode !== 'email' && mode !== 'slack' && mode !== 'teams') {
    throw new Error("[mcp-app-compose] mode must be 'email', 'slack', or 'teams'");
  }
  const isChat = mode !== 'email';
  if (typeof config.resourceUri !== 'string' || !RESOURCE_URI_PATTERN.test(config.resourceUri)) {
    throw new Error('[mcp-app-compose] resourceUri must be a ui:// URI matching ' + String(RESOURCE_URI_PATTERN));
  }
  if (typeof config.sendToolName !== 'string' || !TOOL_NAME_PATTERN.test(config.sendToolName)) {
    throw new Error('[mcp-app-compose] sendToolName must match ' + String(TOOL_NAME_PATTERN));
  }
  if (config.draftToolName !== undefined) {
    if (typeof config.draftToolName !== 'string' || !TOOL_NAME_PATTERN.test(config.draftToolName)) {
      throw new Error('[mcp-app-compose] draftToolName must match ' + String(TOOL_NAME_PATTERN));
    }
    if (isChat) {
      throw new Error('[mcp-app-compose] chat modes (slack/teams) must not set draftToolName');
    }
  }
  if (isChat) {
    // From is email-only (chat has no sending account), so the helper copy is
    // optional here. If a chat config still supplies it, it must clear the same
    // splice-safety guard before it can be spliced into the inline <script>.
    if (
      config.fromMissingHelperText !== undefined &&
      (typeof config.fromMissingHelperText !== 'string' ||
        config.fromMissingHelperText.length === 0 ||
        HELPER_TEXT_FORBIDDEN.test(config.fromMissingHelperText))
    ) {
      throw new Error(
        '[mcp-app-compose] fromMissingHelperText must be non-empty plain text without <, >, backticks, backslashes, or newlines'
      );
    }
  } else if (
    typeof config.fromMissingHelperText !== 'string' ||
    config.fromMissingHelperText.length === 0 ||
    HELPER_TEXT_FORBIDDEN.test(config.fromMissingHelperText)
  ) {
    throw new Error(
      '[mcp-app-compose] fromMissingHelperText must be non-empty plain text without <, >, backticks, backslashes, or newlines'
    );
  }
  if (!config.fields || typeof config.fields.cc !== 'boolean' || typeof config.fields.bcc !== 'boolean') {
    throw new Error('[mcp-app-compose] fields.cc and fields.bcc must be booleans');
  }
  if (isChat && (config.fields.cc || config.fields.bcc)) {
    throw new Error('[mcp-app-compose] chat modes (slack/teams) must set fields.cc and fields.bcc to false');
  }
  const kind = config.deepLink && config.deepLink.kind;
  if (kind !== 'gmail' && kind !== 'none') {
    throw new Error("[mcp-app-compose] deepLink.kind must be 'gmail' or 'none'");
  }
  if (isChat && kind === 'gmail') {
    throw new Error("[mcp-app-compose] chat modes (slack/teams) must set deepLink.kind to 'none'");
  }
  if (config.blockedSendFallback !== undefined) {
    const fallbackKind = config.blockedSendFallback && config.blockedSendFallback.kind;
    if (fallbackKind !== 'gmail-compose' && fallbackKind !== 'none') {
      throw new Error("[mcp-app-compose] blockedSendFallback.kind must be 'gmail-compose' or 'none'");
    }
    if (isChat && fallbackKind === 'gmail-compose') {
      throw new Error('[mcp-app-compose] chat modes (slack/teams) must not set a gmail-compose blockedSendFallback');
    }
  }
}

// ---------------------------------------------------------------------------
// Mode adapter. The single shared template literal below carries the whole
// skeleton (head/CSS, 3-view state machine, send lifecycle, theme, resize, host
// protocol). Its mode-specific regions are descriptor holes filled by
// resolveMode(config): the email descriptor is the historical verbatim text
// (so mode:'email' reproduces the shipped bytes), and slack/teams supply their
// chat equivalents. cc/bcc/gmail/blocked holes are still driven by the existing
// field/deepLink flags — chat configs set those all off, collapsing them — so
// this descriptor only carries what those flags cannot express.

/** @param {import('./types.js').ComposeFieldSpec} f */
function buildEmailReadFormPayloadBody(f) {
  return (
    '        var payload = {\n' +
    '          to: normalizeAddressList(toInput.value),\n' +
    (f.cc ? '          cc: normalizeAddressList(ccInput.value),\n' : '') +
    (f.bcc ? '          bcc: normalizeAddressList(bccInput.value),\n' : '') +
    "          subject: String(subjectInput.value || ''),\n" +
    "          body: String(bodyInput.value || '')\n" +
    '        };\n' +
    '        if (currentEmail) {\n' +
    '          payload.email = currentEmail;\n' +
    '        }\n' +
    '        return payload;\n'
  );
}

/** @param {import('./types.js').ComposeFieldSpec} f */
function buildEmailApplyDraftDataBody(f) {
  return (
    "        var draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : {};\n" +
    '        toInput.value = listToInputValue(draft.to);\n' +
    (f.cc ? '        ccInput.value = listToInputValue(draft.cc);\n' : '') +
    (f.bcc ? '        bccInput.value = listToInputValue(draft.bcc);\n' : '') +
    "        subjectInput.value = typeof draft.subject === 'string' ? draft.subject : '';\n" +
    "        bodyInput.value = typeof draft.body === 'string' ? draft.body : '';\n" +
    "        currentEmail = typeof draft.email === 'string' ? draft.email : '';\n" +
    '        applyFromValue(currentEmail);\n' +
    (f.cc ? '        setCcVisible(normalizeAddressList(draft.cc).length > 0);\n' : '') +
    (f.bcc ? '        setBccVisible(normalizeAddressList(draft.bcc).length > 0);\n' : '') +
    '        clearError();\n' +
    '        clearSuccess();\n' +
    '        postResize();\n'
  );
}

/**
 * @param {import('./types.js').ComposeFieldSpec} f
 * @param {boolean} gmail
 */
function buildEmailRenderSentViewBody(f, gmail) {
  return (
    "        sentFrom.textContent = trimString(payload.email) || 'Account not shown';\n" +
    "        sentTo.textContent = normalizeAddressList(payload.to).join(', ');\n" +
    (f.cc
      ? '        var ccList = normalizeAddressList(payload.cc);\n' +
        "        sentCc.textContent = ccList.join(', ');\n" +
        "        sentCcField.classList.toggle('hidden', ccList.length === 0);\n"
      : '') +
    (f.bcc
      ? '        var bccList = normalizeAddressList(payload.bcc);\n' +
        "        sentBcc.textContent = bccList.join(', ');\n" +
        "        sentBccField.classList.toggle('hidden', bccList.length === 0);\n"
      : '') +
    "        sentSubject.textContent = String(payload.subject || '');\n" +
    "        sentBody.textContent = String(payload.body || '');\n" +
    (gmail
      ? '        gmailUrl = buildGmailUrl(meta, payload.email);\n' +
        "        openGmailButton.classList.toggle('hidden', !gmailUrl);\n"
      : '')
  );
}

const SLACK_READ_FORM_PAYLOAD_BODY =
  "        var channel = String(toInput.value || '').trim();\n" +
  '        var payload = {\n' +
  '          channel: channel,\n' +
  "          text: String(bodyInput.value || '')\n" +
  '        };\n' +
  '        if (intendedRecipient) {\n' +
  '          payload.intended_recipient = intendedRecipient;\n' +
  '        }\n' +
  '        return payload;\n';

const TEAMS_READ_FORM_PAYLOAD_BODY =
  "        var chatId = String(toInput.value || '').trim();\n" +
  '        var payload = {\n' +
  '          chatId: chatId,\n' +
  "          content: String(bodyInput.value || '')\n" +
  '        };\n' +
  '        return payload;\n';

const SLACK_VALIDATE_BODY =
  '        if (!trimString(payload.channel)) {\n' +
  "          return 'Add a channel or person in To.';\n" +
  '        }\n' +
  '        if (!trimString(payload.text)) {\n' +
  "          return 'Add a message before sending.';\n" +
  '        }\n' +
  '        return null;\n';

const TEAMS_VALIDATE_BODY =
  '        if (!trimString(payload.chatId)) {\n' +
  "          return 'Add a chat in To.';\n" +
  '        }\n' +
  '        if (!trimString(payload.content)) {\n' +
  "          return 'Add a message before sending.';\n" +
  '        }\n' +
  '        return null;\n';

const SLACK_APPLY_DRAFT_BODY =
  "        var draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : {};\n" +
  "        toInput.value = String(draft.target || '');\n" +
  "        bodyInput.value = String(draft.text || '');\n" +
  "        intendedRecipient = typeof draft.intended_recipient === 'string' ? draft.intended_recipient : '';\n" +
  '        if (intendedRecipient) {\n' +
  "          recipientNotice.textContent = 'Rebel will send this as a direct message to the person from your request.';\n" +
  "          recipientNotice.classList.remove('hidden');\n" +
  '        } else {\n' +
  "          recipientNotice.textContent = '';\n" +
  "          recipientNotice.classList.add('hidden');\n" +
  '        }\n' +
  '        clearError();\n' +
  '        clearSuccess();\n' +
  '        postResize();\n';

const TEAMS_APPLY_DRAFT_BODY =
  "        var draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : {};\n" +
  "        toInput.value = String(draft.target || '');\n" +
  "        bodyInput.value = String(draft.text || '');\n" +
  '        clearError();\n' +
  '        clearSuccess();\n' +
  '        postResize();\n';

const CHAT_RENDER_SENT_VIEW_BODY =
  "        sentTo.textContent = String(payload.channel || payload.chatId || '');\n" +
  "        sentBody.textContent = String(payload.text || payload.content || '');\n";

/**
 * Resolve the mode-specific descriptor spliced into the shared template.
 * @param {ComposeAppConfig} config
 */
function resolveMode(config) {
  const mode = config.mode === undefined ? 'email' : config.mode;
  const f = config.fields;
  const gmail = config.deepLink.kind === 'gmail';

  if (mode === 'email') {
    return {
      title: 'Compose Email',
      formAriaLabel: 'Compose email',
      identityFieldHtml:
        '      <div class="field from-field">\n' +
        '        <label>From</label>\n' +
        '        <span id="fromValue" class="from-value"></span>\n' +
        '        <span id="fromHelper" class="from-helper hidden"></span>\n' +
        '      </div>',
      toPlaceholder: 'name@example.com, team@example.com',
      subjectFieldHtml:
        '      <div class="field">\n' +
        '        <label for="subjectInput">Subject</label>\n' +
        '        <input id="subjectInput" class="input" type="text" autocomplete="off" placeholder="Email subject">\n' +
        '      </div>\n\n',
      bodyLabel: 'Body',
      bodyPlaceholder: 'Write your email',
      recipientNoticeHtml: '',
      sendLabelText: 'Send email',
      sentIdentityFieldHtml:
        '      <div class="field">\n' +
        '        <label>From</label>\n' +
        '        <span id="sentFrom" class="sent-value"></span>\n' +
        '      </div>\n\n',
      sentSubjectFieldHtml:
        '      <div class="field">\n' +
        '        <label>Subject</label>\n' +
        '        <span id="sentSubject" class="sent-value"></span>\n' +
        '      </div>\n\n',
      extraStateVars: '',
      extraDomVars: '',
      fromMissingHelperTextLiteral: quoteJsString(config.fromMissingHelperText),
      setSendingFields: '        subjectInput.disabled = nextSending;\n',
      readFormPayloadBody: buildEmailReadFormPayloadBody(f),
      validatePayloadBody:
        '        if (!payload.to || payload.to.length === 0) {\n' +
        "          return 'Add at least one recipient in To.';\n" +
        '        }\n' +
        '        if (!trimString(payload.subject)) {\n' +
        "          return 'Add a subject before sending.';\n" +
        '        }\n' +
        '        if (!trimString(payload.body)) {\n' +
        "          return 'Add an email body before sending.';\n" +
        '        }\n' +
        '        return null;\n',
      applyDraftDataBody: buildEmailApplyDraftDataBody(f),
      renderSentViewBody: buildEmailRenderSentViewBody(f, gmail),
      inputListenerElements:
        '[toInput, ' + (f.cc ? 'ccInput, ' : '') + (f.bcc ? 'bccInput, ' : '') + 'subjectInput, bodyInput]',
      sendFailedText: 'Failed to send email.',
      sentCollapseDefault: 'Email sent.',
      sentCollapseStamped: 'Email sent · ',
      unknownDetailTextLiteral:
        '"Rebel didn\'t hear back in time. Check your Sent folder before sending again, so it doesn\'t go out twice."',
      cancelCollapseUnknownText: 'Collapsed. Check your Sent folder if you are not sure.',
    };
  }

  // Chat: slack / teams. Single target + message, no subject/cc/bcc/From/deep
  // link. Slack additionally carries a locked intended-recipient (for DM sends)
  // and its notice; Teams routes by chatId and has neither.
  const isSlack = mode === 'slack';
  return {
    title: 'Compose message',
    formAriaLabel: 'Compose message',
    identityFieldHtml:
      '      <div class="field">\n' +
      '        <span id="workspaceLine" class="from-helper hidden"></span>\n' +
      '      </div>',
    toPlaceholder: isSlack ? '#general or a channel ID' : 'Chat ID',
    subjectFieldHtml: '',
    bodyLabel: 'Message',
    bodyPlaceholder: 'Write your message',
    recipientNoticeHtml: isSlack
      ? '      <div id="recipientNotice" class="status warning hidden" role="status" aria-live="polite"></div>\n\n'
      : '',
    sendLabelText: 'Send message',
    sentIdentityFieldHtml: '',
    sentSubjectFieldHtml: '',
    extraStateVars: isSlack ? "      var intendedRecipient = '';\n" : '',
    extraDomVars: isSlack ? "      var recipientNotice = document.getElementById('recipientNotice');\n" : '',
    fromMissingHelperTextLiteral: "''",
    setSendingFields: '',
    readFormPayloadBody: isSlack ? SLACK_READ_FORM_PAYLOAD_BODY : TEAMS_READ_FORM_PAYLOAD_BODY,
    validatePayloadBody: isSlack ? SLACK_VALIDATE_BODY : TEAMS_VALIDATE_BODY,
    applyDraftDataBody: isSlack ? SLACK_APPLY_DRAFT_BODY : TEAMS_APPLY_DRAFT_BODY,
    renderSentViewBody: CHAT_RENDER_SENT_VIEW_BODY,
    inputListenerElements: '[toInput, bodyInput]',
    sendFailedText: 'Failed to send message.',
    sentCollapseDefault: 'Message sent.',
    sentCollapseStamped: 'Message sent · ',
    unknownDetailTextLiteral:
      '"Rebel didn\'t hear back in time. Check whether it sent before sending again, so it doesn\'t go out twice."',
    cancelCollapseUnknownText: 'Collapsed. Check whether it sent if you are not sure.',
  };
}

/**
 * Build the complete compose/send iframe HTML document for a connector.
 * The returned string is the exact bytes the connector serves as its ui://
 * compose resource (leading newline included, matching the historical Gmail
 * template).
 * @param {ComposeAppConfig} config
 * @returns {string}
 */
export function buildComposeAppHtml(config) {
  assertComposeAppConfig(config);
  const f = config.fields;
  const gmail = config.deepLink.kind === 'gmail';
  const blockedSend = !!(config.blockedSendFallback && config.blockedSendFallback.kind === 'gmail-compose');
  // Save-draft subsystem: email-mode configs that name a draft tool grow a
  // "Save draft" action. Every draft region below is gated on this flag, so
  // configs without it stay byte-identical to the historical output.
  const hasDraft = config.draftToolName !== undefined;
  const m = resolveMode(config);
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${m.title}</title>
  <style>
    :root {
      --bg: #ffffff;
      --panel: #ffffff;
      --border: #d9dde5;
      --text: #1f2937;
      --muted: #6b7280;
      --input-bg: #ffffff;
      --button-bg: #1f6feb;
      --button-text: #ffffff;
      --button-bg-hover: #1b63d3;
      --secondary-bg: #f3f4f6;
      --secondary-text: #1f2937;
      --secondary-border: #d1d5db;
      --error-bg: #fef2f2;
      --error-border: #fecaca;
      --error-text: #991b1b;
      --success-bg: #ecfdf5;
      --success-border: #bbf7d0;
      --success-text: #166534;
      --warning-bg: #fffbeb;
      --warning-border: #fde68a;
      --warning-text: #92400e;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --panel: #111827;
        --border: #334155;
        --text: #e5e7eb;
        --muted: #9ca3af;
        --input-bg: #0b1220;
        --button-bg: #3b82f6;
        --button-text: #eff6ff;
        --button-bg-hover: #2563eb;
        --secondary-bg: #1f2937;
        --secondary-text: #e5e7eb;
        --secondary-border: #374151;
        --error-bg: #2b1011;
        --error-border: #7f1d1d;
        --error-text: #fca5a5;
        --success-bg: #052e1b;
        --success-border: #166534;
        --success-text: #86efac;
        --warning-bg: #2a2106;
        --warning-border: #854d0e;
        --warning-text: #fcd34d;
      }
    }

    html[data-theme="light"] {
      color-scheme: light;
    }

    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0f172a;
      --panel: #111827;
      --border: #334155;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --input-bg: #0b1220;
      --button-bg: #3b82f6;
      --button-text: #eff6ff;
      --button-bg-hover: #2563eb;
      --secondary-bg: #1f2937;
      --secondary-text: #e5e7eb;
      --secondary-border: #374151;
      --error-bg: #2b1011;
      --error-border: #7f1d1d;
      --error-text: #fca5a5;
      --success-bg: #052e1b;
      --success-border: #166534;
      --success-text: #86efac;
      --warning-bg: #2a2106;
      --warning-border: #854d0e;
      --warning-text: #fcd34d;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.4;
    }

    .wrapper {
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .field label {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .from-value {
      color: var(--text);
      font-size: 14px;
      padding: 2px 0;
      word-break: break-word;
    }

    .from-helper {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }

    .input,
    .textarea {
      width: 100%;
      background: var(--input-bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
    }

    .input:focus,
    .textarea:focus {
      outline: 2px solid rgba(59, 130, 246, 0.35);
      outline-offset: 1px;
    }

    .textarea {
      min-height: 180px;
      resize: vertical;
      white-space: pre-wrap;
    }

    .toggles {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }

    .link-button {
      border: none;
      padding: 0;
      background: none;
      color: var(--muted);
      text-decoration: underline;
      font-size: 12px;
      cursor: pointer;
    }

    .link-button:hover {
      color: var(--text);
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 2px;
${hasDraft ? '      flex-wrap: wrap;\n' : ''}    }

    .button {
      border-radius: 8px;
      border: 1px solid transparent;
      min-height: 36px;
      padding: 0 14px;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 120ms ease, opacity 120ms ease, border-color 120ms ease;
    }

    .button:disabled {
      cursor: not-allowed;
      opacity: 0.75;
    }

    .button-primary {
      background: var(--button-bg);
      color: var(--button-text);
    }

    .button-primary:hover:enabled {
      background: var(--button-bg-hover);
    }

    .button-secondary {
      background: var(--secondary-bg);
      color: var(--secondary-text);
      border-color: var(--secondary-border);
    }

    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      display: inline-block;
      animation: spin 700ms linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .status {
      border-radius: 8px;
      border: 1px solid transparent;
      padding: 8px 10px;
      font-size: 13px;
    }

    .error {
      background: var(--error-bg);
      border-color: var(--error-border);
      color: var(--error-text);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .success {
      background: var(--success-bg);
      border-color: var(--success-border);
      color: var(--success-text);
    }

    .warning {
      background: var(--warning-bg);
      border-color: var(--warning-border);
      color: var(--warning-text);
      display: block;
    }

    .warning strong {
      display: block;
      margin-bottom: 2px;
    }

    .warning .warning-detail {
      opacity: 0.85;
    }

${blockedSend ? `    .blocked-actions {
      margin-top: 8px;
    }

` : ''}    .collapsed {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel);
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    .hidden {
      display: none !important;
    }

    .sent-header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .sent-badge {
      display: inline-flex;
      align-items: center;
      background: var(--success-bg);
      color: var(--success-text);
      border: 1px solid var(--success-border);
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 12px;
      font-weight: 600;
    }

    .sent-timestamp {
      color: var(--muted);
      font-size: 12px;
    }

    .sent-value {
      color: var(--text);
      font-size: 14px;
      word-break: break-word;
    }

    .sent-body {
      color: var(--text);
      font-size: 14px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 260px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      background: var(--input-bg);
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div id="collapsedState" class="collapsed hidden">
      <span id="collapsedMessage">Draft collapsed.</span>
      <button id="reopenButton" type="button" class="button button-secondary">Reopen</button>
    </div>

    <form id="composeForm" class="card" novalidate aria-label="${m.formAriaLabel}">
${m.identityFieldHtml}

      <div class="field">
        <label for="toInput">To</label>
        <input id="toInput" class="input" type="text" autocomplete="off" placeholder="${m.toPlaceholder}">
      </div>

${f.cc || f.bcc ? `      <div class="toggles">
${f.cc ? `        <button id="toggleCcButton" type="button" class="link-button" aria-expanded="false" aria-controls="ccRow">Add CC</button>
` : ''}${f.bcc ? `        <button id="toggleBccButton" type="button" class="link-button" aria-expanded="false" aria-controls="bccRow">Add BCC</button>
` : ''}      </div>

` : ''}${f.cc ? `      <div id="ccRow" class="field hidden">
        <label for="ccInput">CC</label>
        <input id="ccInput" class="input" type="text" autocomplete="off" placeholder="cc@example.com">
      </div>

` : ''}${f.bcc ? `      <div id="bccRow" class="field hidden">
        <label for="bccInput">BCC</label>
        <input id="bccInput" class="input" type="text" autocomplete="off" placeholder="bcc@example.com">
      </div>

` : ''}${m.subjectFieldHtml}      <div class="field">
        <label for="bodyInput">${m.bodyLabel}</label>
        <textarea id="bodyInput" class="textarea" placeholder="${m.bodyPlaceholder}"></textarea>
      </div>

      <div id="errorBox" class="status error hidden" role="alert">
        <span id="errorText"></span>
        <button id="retryButton" type="button" class="link-button">Retry</button>
      </div>

${blockedSend ? `      <div id="blockedBox" class="status warning hidden" role="status" aria-live="polite">
        <span id="blockedText"></span>
        <div class="blocked-actions">
          <button id="openComposeButton" type="button" class="button button-secondary">Open in Gmail</button>
        </div>
      </div>

` : ''}${m.recipientNoticeHtml}      <div id="successBox" class="status success hidden" role="status" aria-live="polite"></div>

      <div id="unknownBox" class="status warning hidden" role="status" aria-live="polite">
        <strong id="unknownTitle"></strong>
        <span id="unknownText" class="warning-detail"></span>
      </div>

      <div class="actions">
        <button id="cancelButton" type="button" class="button button-secondary">Cancel</button>
${hasDraft ? `        <button id="draftButton" type="button" class="button button-secondary">
          <span id="draftSpinner" class="spinner hidden" aria-hidden="true"></span>
          <span id="draftLabel">Save draft</span>
        </button>
` : ''}        <button id="sendButton" type="button" class="button button-primary">
          <span id="sendSpinner" class="spinner hidden" aria-hidden="true"></span>
          <span id="sendLabel">${m.sendLabelText}</span>
        </button>
      </div>
    </form>

    <div id="sentView" class="card hidden" role="status" aria-live="polite">
      <div class="sent-header">
        <span class="sent-badge">Sent</span>
        <span id="sentTimestamp" class="sent-timestamp"></span>
      </div>

${m.sentIdentityFieldHtml}      <div class="field">
        <label>To</label>
        <span id="sentTo" class="sent-value"></span>
      </div>

${f.cc ? `      <div id="sentCcField" class="field hidden">
        <label>CC</label>
        <span id="sentCc" class="sent-value"></span>
      </div>

` : ''}${f.bcc ? `      <div id="sentBccField" class="field hidden">
        <label>BCC</label>
        <span id="sentBcc" class="sent-value"></span>
      </div>

` : ''}${m.sentSubjectFieldHtml}      <div class="field">
        <label>Message</label>
        <div id="sentBody" class="sent-body"></div>
      </div>

      <div class="actions">
${gmail ? `        <button id="openGmailButton" type="button" class="button button-secondary hidden">Open in Gmail</button>
` : ''}        <button id="sentCollapseButton" type="button" class="button button-secondary">Collapse</button>
      </div>
    </div>
  </div>

  <script>
    (function () {
      'use strict';

      var RESOURCE_URI = ${quoteJsString(config.resourceUri)};
      var currentEmail = '';
      // The host prefills the draft exactly once via ui/notifications/tool-result
      // on ready. We apply only the FIRST prefill and ignore any later ones, so a
      // stray or hostile re-post can't silently rewrite a draft the user has
      // already reviewed before clicking Send.
      var draftApplied = false;
      var pendingRequestId = null;
      var pendingPayload = null;
      var sending = false;
      var collapsed = false;
      var outcomeUnknown = false;
      var sent = false;
${m.extraStateVars}${hasDraft ? `      // Which action the in-flight request belongs to ('send' | 'draft').
      // Captured before clearing on reply/timeout so the response handler can
      // route error/success correctly. retryAction survives the reply so a
      // later Retry click still knows which tool to re-invoke.
      var pendingAction = null;
      var retryAction = null;
` : ''}${blockedSend ? `      var sendBlocked = false;
` : ''}${gmail ? `      var gmailUrl = null;
` : ''}      var sendTimeoutId = null;
      // Just beyond the host-side tool-call timeout (60s) so a legitimately slow
      // send resolves to its real result first; this only fires when the reply
      // is genuinely lost, so the button can never stay stuck-silent.
      var SEND_TIMEOUT_MS = 75000;

      var composeForm = document.getElementById('composeForm');
      var collapsedState = document.getElementById('collapsedState');
      var collapsedMessage = document.getElementById('collapsedMessage');
      var reopenButton = document.getElementById('reopenButton');

      var sentView = document.getElementById('sentView');
      var sentTimestamp = document.getElementById('sentTimestamp');
      var sentFrom = document.getElementById('sentFrom');
      var sentTo = document.getElementById('sentTo');
${f.cc ? `      var sentCcField = document.getElementById('sentCcField');
      var sentCc = document.getElementById('sentCc');
` : ''}${f.bcc ? `      var sentBccField = document.getElementById('sentBccField');
      var sentBcc = document.getElementById('sentBcc');
` : ''}      var sentSubject = document.getElementById('sentSubject');
      var sentBody = document.getElementById('sentBody');
${gmail ? `      var openGmailButton = document.getElementById('openGmailButton');
` : ''}      var sentCollapseButton = document.getElementById('sentCollapseButton');

      var toInput = document.getElementById('toInput');
${f.cc ? `      var ccInput = document.getElementById('ccInput');
` : ''}${f.bcc ? `      var bccInput = document.getElementById('bccInput');
` : ''}      var subjectInput = document.getElementById('subjectInput');
      var bodyInput = document.getElementById('bodyInput');
      var fromValue = document.getElementById('fromValue');
      var fromHelper = document.getElementById('fromHelper');
${f.cc ? `      var ccRow = document.getElementById('ccRow');
` : ''}${f.bcc ? `      var bccRow = document.getElementById('bccRow');
` : ''}${f.cc ? `      var toggleCcButton = document.getElementById('toggleCcButton');
` : ''}${f.bcc ? `      var toggleBccButton = document.getElementById('toggleBccButton');
` : ''}
      var sendButton = document.getElementById('sendButton');
      var sendLabel = document.getElementById('sendLabel');
      var sendSpinner = document.getElementById('sendSpinner');
${hasDraft ? `      var draftButton = document.getElementById('draftButton');
      var draftLabel = document.getElementById('draftLabel');
      var draftSpinner = document.getElementById('draftSpinner');
` : ''}      var cancelButton = document.getElementById('cancelButton');
      var retryButton = document.getElementById('retryButton');

      var errorBox = document.getElementById('errorBox');
      var errorText = document.getElementById('errorText');
      var successBox = document.getElementById('successBox');
      var unknownBox = document.getElementById('unknownBox');
      var unknownTitle = document.getElementById('unknownTitle');
      var unknownText = document.getElementById('unknownText');
${blockedSend ? `      var blockedBox = document.getElementById('blockedBox');
      var blockedText = document.getElementById('blockedText');
      var openComposeButton = document.getElementById('openComposeButton');
` : ''}${m.extraDomVars}
      function applyThemeFromHostContext() {
        try {
          var context = window.__MCP_HOST_CONTEXT__;
          if (!context || (context.theme !== 'light' && context.theme !== 'dark')) {
            return;
          }
          document.documentElement.setAttribute('data-theme', context.theme);
        } catch (_) {
          // Ignore theme extraction errors
        }
      }

      function trimString(value) {
        return String(value || '').trim();
      }

      function applyFromValue(email) {
        var trimmed = trimString(email);
        if (trimmed) {
          fromValue.textContent = trimmed;
          fromValue.style.color = '';
          fromHelper.textContent = '';
          fromHelper.classList.add('hidden');
        } else {
          fromValue.textContent = 'Account not shown';
          fromValue.style.color = 'var(--muted)';
          fromHelper.textContent = ${m.fromMissingHelperTextLiteral};
          fromHelper.classList.remove('hidden');
        }
      }

      function formatAddressItem(item) {
        if (item && typeof item === 'object') {
          var email = trimString(item.email || item.address || item.value);
          var name = trimString(item.name || item.displayName);
          if (email && name) {
            return name + ' <' + email + '>';
          }
          return email;
        }
        return trimString(item);
      }

      function normalizeAddressList(value) {
        if (Array.isArray(value)) {
          return value.map(formatAddressItem).filter(Boolean);
        }
        if (typeof value === 'string') {
          return value
            .split(',')
            .map(function (item) { return trimString(item); })
            .filter(Boolean);
        }
        return [];
      }

      function listToInputValue(list) {
        return normalizeAddressList(list).join(', ');
      }

      var resizeQueued = false;
      function postResize() {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(function () {
          resizeQueued = false;
          var height = Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0
          );
          window.parent.postMessage(
            { jsonrpc: '2.0', method: 'ui/resize', params: { height: height } },
            '*'
          );
        });
      }

      function postReady() {
        window.parent.postMessage(
          {
            method: 'mcp-app:ready',
            params: { resourceUri: RESOURCE_URI }
          },
          '*'
        );
      }

      // Exactly one of the three panels is visible at a time: the editable form,
      // the read-only sent view, or the collapsed summary bar.
      function showView(view) {
        composeForm.classList.toggle('hidden', view !== 'form');
        sentView.classList.toggle('hidden', view !== 'sent');
        collapsedState.classList.toggle('hidden', view !== 'collapsed');
        postResize();
      }

      function setCollapsed(nextCollapsed, message) {
        collapsed = nextCollapsed;
        if (nextCollapsed) {
          collapsedMessage.textContent = message || 'Draft collapsed.';
          showView('collapsed');
        } else {
          // Expanding after a send restores the read-only sent view (never the
          // editable form) so the user can re-read what went out without any risk
          // of a duplicate send; before sending, it restores the editable form.
          showView(sent ? 'sent' : 'form');
        }
      }

      function setSending(nextSending) {
        sending = nextSending;
        sendButton.disabled = nextSending${blockedSend ? ' || sendBlocked' : ''};
${hasDraft ? '        draftButton.disabled = nextSending;\n' : ''}        cancelButton.disabled = nextSending;
        toInput.disabled = nextSending;
${f.cc ? `        ccInput.disabled = nextSending;
` : ''}${f.bcc ? `        bccInput.disabled = nextSending;
` : ''}${m.setSendingFields}        bodyInput.disabled = nextSending;
        sendSpinner.classList.toggle('hidden', !nextSending);
        sendLabel.textContent = nextSending ? 'Sending…' : ${quoteJsString(m.sendLabelText)};
        sendButton.setAttribute('aria-busy', nextSending ? 'true' : 'false');
        postResize();
      }

${hasDraft ? `      // Mirror of setSending for the Save-draft action. One request is in
      // flight at a time (both paths share pendingRequestId and set the same
      // \`sending\` flag), so the two busy states can never overlap; every
      // control locks either way and only the active button shows a spinner
      // and aria-busy.
      function setSavingDraft(nextSaving) {
        sending = nextSaving;
        sendButton.disabled = nextSaving${blockedSend ? ' || sendBlocked' : ''};
        draftButton.disabled = nextSaving;
        cancelButton.disabled = nextSaving;
        toInput.disabled = nextSaving;
${f.cc ? `        ccInput.disabled = nextSaving;\n` : ''}${f.bcc ? `        bccInput.disabled = nextSaving;\n` : ''}        subjectInput.disabled = nextSaving;
        bodyInput.disabled = nextSaving;
        sendSpinner.classList.add('hidden');
        sendLabel.textContent = ${quoteJsString(m.sendLabelText)};
        sendButton.setAttribute('aria-busy', 'false');
        draftSpinner.classList.toggle('hidden', !nextSaving);
        draftLabel.textContent = nextSaving ? 'Saving…' : 'Save draft';
        draftButton.setAttribute('aria-busy', nextSaving ? 'true' : 'false');
        postResize();
      }

` : ''}      function clearError() {
        errorText.textContent = '';
        errorBox.classList.add('hidden');
      }

      function showError(message) {
        errorText.textContent = message || ${quoteJsString(m.sendFailedText)};
        errorBox.classList.remove('hidden');
        postResize();
      }

      function clearSuccess() {
        successBox.textContent = '';
        successBox.classList.add('hidden');
      }

      function showSuccess(message) {
        successBox.textContent = message;
        successBox.classList.remove('hidden');
        postResize();
      }

      function clearSendTimeout() {
        if (sendTimeoutId !== null) {
          clearTimeout(sendTimeoutId);
          sendTimeoutId = null;
        }
      }

      function clearUnknown() {
        outcomeUnknown = false;
        unknownTitle.textContent = '';
        unknownText.textContent = '';
        unknownBox.classList.add('hidden');
      }

      // No reply ever came back for the send (e.g. the host's response was lost
      // before reaching this iframe). We genuinely don't know whether the email
      // went out, so we must NOT claim success or failure: re-enable the form and
      // tell the user to verify before resending (the send is not idempotent, so
      // a blind retry could send a duplicate).
      function showSendUnknown() {
        outcomeUnknown = true;
        clearError();
        clearSuccess();
        unknownTitle.textContent = 'Not sure if this sent.';
        unknownText.textContent = ${m.unknownDetailTextLiteral};
        unknownBox.classList.remove('hidden');
        postResize();
      }

      function handleSendTimeout() {
        sendTimeoutId = null;
        if (!pendingRequestId) {
          return;
        }
        pendingRequestId = null;
${hasDraft ? `        if (pendingAction === 'draft') {
          pendingAction = null;
          setSavingDraft(false);
          showDraftSaveUnknown();
          return;
        }
        pendingAction = null;
` : ''}        setSending(false);
        showSendUnknown();
      }

${hasDraft ? `      // Same lost-reply honesty as a send, lower stakes: a blind retry here
      // could create a duplicate draft, so we say we're not sure and point at
      // the Drafts folder instead of offering Retry.
      function showDraftSaveUnknown() {
        outcomeUnknown = true;
        clearError();
        clearSuccess();
        unknownTitle.textContent = 'Not sure if the draft was saved.';
        unknownText.textContent =
          "Rebel didn't hear back in time. Check your Drafts folder before trying again, so you don't create a duplicate.";
        unknownBox.classList.remove('hidden');
        postResize();
      }

` : ''}${f.cc ? `      function setCcVisible(visible) {
        ccRow.classList.toggle('hidden', !visible);
        toggleCcButton.textContent = visible ? 'Hide CC' : 'Add CC';
        toggleCcButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
      }

` : ''}${f.bcc ? `      function setBccVisible(visible) {
        bccRow.classList.toggle('hidden', !visible);
        toggleBccButton.textContent = visible ? 'Hide BCC' : 'Add BCC';
        toggleBccButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
      }

` : ''}      function readFormPayload() {
${m.readFormPayloadBody}      }

      function validatePayload(payload) {
${m.validatePayloadBody}      }

${hasDraft ? `      // Same provider-compatible minimum as sending (the draft tools require
      // To, Subject, and Body too) with save-specific copy. Draft is
      // email-mode only, so this body is the email shape unconditionally.
      function validateDraftPayload(payload) {
        if (!payload.to || payload.to.length === 0) {
          return 'Add at least one recipient in To.';
        }
        if (!trimString(payload.subject)) {
          return 'Add a subject before saving.';
        }
        if (!trimString(payload.body)) {
          return 'Add an email body before saving.';
        }
        return null;
      }

` : ''}      function sendPayload(payload) {
        pendingPayload = payload;
        pendingRequestId = 'send-' + Date.now() + '-' + Math.random().toString(16).slice(2);
${hasDraft ? `        pendingAction = 'send';
        retryAction = null;
` : ''}        setSending(true);
        clearError();
        clearSuccess();
        clearUnknown();
        clearSendTimeout();
        sendTimeoutId = setTimeout(handleSendTimeout, SEND_TIMEOUT_MS);

        window.parent.postMessage(
          {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: ${quoteJsString(config.sendToolName)},
              arguments: payload
            },
            id: pendingRequestId
          },
          '*'
        );
      }

${hasDraft ? `      function saveDraftPayload(payload) {
        pendingPayload = payload;
        pendingRequestId = 'draft-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        pendingAction = 'draft';
        retryAction = null;
        setSavingDraft(true);
        clearError();
        clearSuccess();
        clearUnknown();
        clearSendTimeout();
        sendTimeoutId = setTimeout(handleSendTimeout, SEND_TIMEOUT_MS);

        window.parent.postMessage(
          {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: ${quoteJsString(config.draftToolName ?? '')},
              arguments: payload
            },
            id: pendingRequestId
          },
          '*'
        );
      }

` : ''}      function applyDraftData(rawDraft) {
${m.applyDraftDataBody}      }

      function getDraftFromToolResult(payload) {
        if (!payload || typeof payload !== 'object') {
          return null;
        }
        // CANONICAL: post-A0 super-mcp hoists structuredContent onto the
        // outer block; the host posts it through \`params.structuredContent\`.
        if (payload.structuredContent && typeof payload.structuredContent === 'object') {
          return payload.structuredContent;
        }
        // MIGRATION SHIM: pre-A0 stored sessions replayed through the
        // current iframe lack \`params.structuredContent\` because the outer
        // block had no hoist at capture time. Read inner envelope text →
        // JSON.parse → result.structuredContent. NOT regex-based.
        //
        // Lifetime: PERMANENT defensive read-side helper. Pre-A0 sessions
        // are persisted on disk and may be replayed indefinitely; there is
        // no time-based sunset. Removing this fallback would silently break
        // pre-A0 conversation replay.
        var text = typeof payload.text === 'string' ? payload.text :
          (Array.isArray(payload.content)
            ? (payload.content.find(function (c) { return c && c.type === 'text' && typeof c.text === 'string'; }) || {}).text
            : null);
        if (typeof text !== 'string') return null;
        try {
          var parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && parsed.result && typeof parsed.result === 'object') {
            var inner = parsed.result;
            if (inner.structuredContent && typeof inner.structuredContent === 'object') {
              return inner.structuredContent;
            }
          }
        } catch (_) {
          // Likely-envelope heuristic: text starts with \`{\` and contains
          // \`"package_id"\` in the first 64 chars. If JSON.parse failed on a
          // likely-envelope, surface a warning so the developer chasing
          // "compose form is empty on replay" sees a signal. For non-envelope
          // text (the dominant case), no log fires.
          var prefix = text.length > 64 ? text.slice(0, 64) : text;
          var likelyEnvelope = prefix.charAt(0) === '{' && prefix.indexOf('"package_id"') !== -1;
          if (likelyEnvelope && typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('[compose-email] Migration shim: JSON.parse failed on likely super-mcp envelope; pre-fill skipped');
          }
        }
        return null;
      }

      function findTextBlock(blocks) {
        if (!Array.isArray(blocks)) return null;
        var block = blocks.find(function (c) {
          return c && c.type === 'text' && typeof c.text === 'string';
        });
        return block ? block.text : null;
      }

      // Extract the send result identifiers ({ messageId, threadId, labelIds })
      // from the tool-call reply. The connector attaches structuredContent, which
      // super-mcp hoists onto the outer block, so the fast path is a single read.
      // The envelope-unwrapping fallback keeps this robust for hosts (or replayed
      // sessions) that forward only the serialized super-mcp text envelope.
      function getSendMetaFromResult(result) {
        if (!result || typeof result !== 'object') return null;
        if (result.structuredContent && typeof result.structuredContent === 'object') {
          return result.structuredContent;
        }
        try {
          var outerText = findTextBlock(result.content);
          if (typeof outerText !== 'string' && typeof result.text === 'string') {
            outerText = result.text;
          }
          if (typeof outerText !== 'string') return null;
          var envelope = JSON.parse(outerText);
          if (!envelope || typeof envelope !== 'object') return null;
          // outerText was the connector payload directly (no super-mcp envelope).
          if (envelope.messageId || envelope.threadId) return envelope;
          var inner = envelope.result;
          if (!inner || typeof inner !== 'object') return null;
          if (inner.structuredContent && typeof inner.structuredContent === 'object') {
            return inner.structuredContent;
          }
          var innerText = findTextBlock(inner.content);
          if (typeof innerText !== 'string') return null;
          var payload = JSON.parse(innerText);
          return (payload && typeof payload === 'object') ? payload : null;
        } catch (_) {
          return null;
        }
      }

${blockedSend ? `      // ---- Blocked-send Gmail escape hatch ----
      // Shown ONLY when the user's own send preference blocks the tool
      // (super-mcp TOOL_BLOCKED / -33008 + "disabled by user preference"). We
      // never call the disabled tool; instead we open a prefilled Gmail compose
      // window so the user finishes the send in Gmail (no copy-paste). This is
      // deliberately narrow: admin-disabled ("disabled by your organization…")
      // and generic security-policy blocks fall through to the normal retryable
      // error, because offering a Gmail bypass there would route around a control
      // the user did not set.
      //
      // Gmail compose URLs that get too long can silently fail to open, so we cap
      // the length and degrade visibly (recipients + subject only, paste the body)
      // rather than truncating without telling the user.
      var GMAIL_COMPOSE_MAX_URL = 8000;
      var BLOCKED_SEND_MESSAGE =
        'Sending from here is turned off in your settings. You can finish and send this email in Gmail, or turn sending back on in Settings.';

      function isUserDisabledSendError(message) {
        var m = String(message || '').toLowerCase();
        // Anchor the code so it can't match inside a longer number (-330080),
        // and require the user-preference phrase so admin-disabled / generic
        // security blocks fall through to the ordinary retryable error.
        return /-33008\\b/.test(m) && m.indexOf('disabled by user preference') !== -1;
      }

      // Base URL + path are constant (code-reviewed here, never config-provided);
      // only the field VALUES vary and go through URLSearchParams, so query
      // delimiters, newlines, and reserved characters become encoded data — no
      // query injection or header splitting. The host ui/open-external-link
      // bridge re-validates the mail.google.com host before opening.
      function buildGmailComposeUrl(payload, includeBody) {
        var url = new URL('https://mail.google.com/mail/');
        var params = new URLSearchParams();
        params.set('view', 'cm');
        params.set('fs', '1');
        var to = normalizeAddressList(payload.to).join(',');
        if (to) params.set('to', to);
${f.cc ? `        var cc = normalizeAddressList(payload.cc).join(',');
        if (cc) params.set('cc', cc);
` : ''}${f.bcc ? `        var bcc = normalizeAddressList(payload.bcc).join(',');
        if (bcc) params.set('bcc', bcc);
` : ''}        var subject = trimString(payload.subject);
        if (subject) params.set('su', subject);
        if (includeBody) {
          var body = String(payload.body || '');
          if (body) params.set('body', body);
        }
        url.search = params.toString();
        return url.toString();
      }

      function showBlockedSend() {
        sendBlocked = true;
        clearError();
        clearSuccess();
        clearUnknown();
        sendButton.disabled = true;
        sendButton.title =
          'Sending from here is turned off in your settings. Turn it back on in Settings, or open this draft in Gmail to send.';
        blockedText.textContent = BLOCKED_SEND_MESSAGE;
        blockedBox.classList.remove('hidden');
        postResize();
      }

      openComposeButton.addEventListener('click', function () {
        // Reset any prior "too long" note, then rebuild from the live form so
        // edits made after the block are reflected.
        blockedText.textContent = BLOCKED_SEND_MESSAGE;
        var payload = readFormPayload();
        var composeUrl = buildGmailComposeUrl(payload, true);
        if (composeUrl.length > GMAIL_COMPOSE_MAX_URL) {
          composeUrl = buildGmailComposeUrl(payload, false);
          if (composeUrl.length > GMAIL_COMPOSE_MAX_URL) {
            // Even without the body the link is too long (many recipients, or a
            // very long subject). Gmail would silently refuse to open it, so
            // don't pretend — tell the user and post nothing.
            blockedText.textContent =
              'This draft is too large to open in Gmail. Shorten the recipients or subject, or turn sending back on in Settings.';
            postResize();
            return;
          }
          blockedText.textContent =
            'This email is long, so Gmail will open with just the recipients and subject. Copy the message text above into Gmail before sending.';
          postResize();
        }
        window.parent.postMessage(
          { jsonrpc: '2.0', method: 'ui/open-external-link', params: { url: composeUrl } },
          '*'
        );
      });

` : ''}${gmail ? `      function looksLikeEmail(value) {
        var at = value.indexOf('@');
        return at > 0 && at === value.lastIndexOf('@') && value.indexOf(' ') === -1;
      }

      // Build a Gmail deep link to the just-sent message. The /u/<account> segment
      // targets the right inbox when the user is signed into several Google
      // accounts; #all/<id> opens the thread (falling back to the message id).
      function buildGmailUrl(meta, email) {
        if (!meta || typeof meta !== 'object') return null;
        var id = trimString(meta.threadId) || trimString(meta.messageId);
        if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
        var account = trimString(email);
        var userPart = looksLikeEmail(account) ? encodeURIComponent(account) : '0';
        return 'https://mail.google.com/mail/u/' + userPart + '/#all/' + encodeURIComponent(id);
      }

` : ''}      function formatSentTime() {
        try {
          return new Date().toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
          });
        } catch (_) {
          return '';
        }
      }

      function renderSentView(payload, meta, stamp) {
        payload = payload && typeof payload === 'object' ? payload : {};
        sentTimestamp.textContent = stamp ? 'Sent ' + stamp : 'Sent';
${m.renderSentViewBody}      }

      function handleSendRequest() {
        if (sending) return;
${blockedSend ? `        // Once the user's own send preference has blocked this tool, never
        // re-invoke it — the escape hatch is the only path out. The Send button
        // is already disabled, but this also fends off a future host that grants
        // allow-forms (a submit could otherwise re-fire the disabled tool).
        if (sendBlocked) return;
` : ''}
        var payload = readFormPayload();
        var validationError = validatePayload(payload);
        if (validationError) {
          showError(validationError);
          return;
        }

        sendPayload(payload);
      }

      // The Send button is type="button" with an explicit click handler rather
      // than a form submit button. The Rebel host renders this iframe with a
      // sandbox of "allow-scripts" only — no "allow-forms" — so native form
      // submission is blocked by the browser BEFORE the submit event fires
      // ("Blocked form submission ... the form's frame is sandboxed and the
      // allow-forms permission is not set"). A submit-driven Send therefore
      // silently did nothing: no postMessage, no spinner, no telemetry.
      // A click handler needs no sandbox permission and is the same path
      // Cancel/Retry already use. The submit listener below stays only as a
      // defensive fallback for hosts that DO grant allow-forms; in this sandbox
      // it never fires (neither the button click nor Enter routes through it).
      // The sending guard keeps any double-fire (in an allow-forms host) a no-op.
      sendButton.addEventListener('click', function () {
        handleSendRequest();
      });

${hasDraft ? `      draftButton.addEventListener('click', function () {
        if (sending) return;
        var payload = readFormPayload();
        var validationError = validateDraftPayload(payload);
        if (validationError) {
          showError(validationError);
          return;
        }
        saveDraftPayload(payload);
      });

` : ''}      composeForm.addEventListener('submit', function (event) {
        event.preventDefault();
        handleSendRequest();
      });

      retryButton.addEventListener('click', function () {
        if (sending) return;
        var payload = readFormPayload();
${hasDraft ? `        if (retryAction === 'draft') {
          var draftValidationError = validateDraftPayload(payload);
          if (draftValidationError) {
            showError(draftValidationError);
            return;
          }
          retryAction = null;
          saveDraftPayload(payload);
          return;
        }
` : ''}        var validationError = validatePayload(payload);
        if (validationError) {
          showError(validationError);
          return;
        }
        sendPayload(payload);
      });

      cancelButton.addEventListener('click', function () {
        if (sending) return;
        // After a lost-reply timeout we don't know if the email sent, so don't
        // claim "Nothing sent." on collapse — point the user to verify instead.
        var collapseMessage = outcomeUnknown
          ? ${quoteJsString(m.cancelCollapseUnknownText)}
          : 'Draft collapsed. Nothing sent.';
        clearError();
        clearSuccess();
        clearUnknown();
        setCollapsed(true, collapseMessage);
      });

      reopenButton.addEventListener('click', function () {
        setCollapsed(false);
      });

      sentCollapseButton.addEventListener('click', function () {
        setCollapsed(true, collapsedMessage.textContent || ${quoteJsString(m.sentCollapseDefault)});
      });

${gmail ? `      // The iframe sandbox is "allow-scripts" only (no allow-popups / allow-forms),
      // so it cannot open a URL itself. Ask the host to open the Gmail link in the
      // user's browser via the ui/open-external-link bridge, which re-validates the
      // URL against its own allowlist before handing it to the OS.
      openGmailButton.addEventListener('click', function () {
        if (!gmailUrl) return;
        window.parent.postMessage(
          { jsonrpc: '2.0', method: 'ui/open-external-link', params: { url: gmailUrl } },
          '*'
        );
      });

` : ''}${f.cc ? `      toggleCcButton.addEventListener('click', function () {
        setCcVisible(ccRow.classList.contains('hidden'));
        postResize();
      });

` : ''}${f.bcc ? `      toggleBccButton.addEventListener('click', function () {
        setBccVisible(bccRow.classList.contains('hidden'));
        postResize();
      });

` : ''}      ${m.inputListenerElements}.forEach(function (element) {
        element.addEventListener('input', function () {
          clearError();
          clearSuccess();
          clearUnknown();
          postResize();
        });
      });

      window.addEventListener('message', function (event) {
        // Honest scope (origin-independent): the iframe sandbox origin is 'null',
        // so validating event.origin is unreliable across dev/prod/custom-scheme
        // hosts. Instead reject any *identified* sender that isn't our host frame
        // (window.parent). A real cross-frame postMessage always stamps
        // event.source with the sending window, so a hostile sibling frame is
        // rejected here; a null source only occurs for same-context synthetic
        // dispatch (our own code) and cannot be forged from outside, so we
        // tolerate it. This does not authenticate the host's identity — the host
        // separately authenticates this iframe by origin+source.
        if (event.source && event.source !== window.parent) {
          return;
        }

        var data = event.data;
        if (!data || typeof data !== 'object') {
          return;
        }

        if (data.method === 'ui/notifications/tool-result') {
          // Always parse (so the migration-shim's malformed-envelope warning
          // still fires), but apply only the first successful prefill: a stray
          // or hostile re-post can't silently rewrite a draft the user has
          // already reviewed.
          var draft = getDraftFromToolResult(data.params);
          if (draft && !draftApplied) {
            draftApplied = true;
            applyDraftData(draft);
          }
          return;
        }

        if (data.jsonrpc !== '2.0' || !pendingRequestId || data.id !== pendingRequestId) {
          return;
        }

        pendingRequestId = null;
        clearSendTimeout();
        clearUnknown();
${hasDraft ? `        var completedAction = pendingAction;
        pendingAction = null;
        if (completedAction === 'draft') {
          setSavingDraft(false);
        } else {
          setSending(false);
        }
` : '        setSending(false);\n'}
        if (data.error) {
          var errorMessage = data.error && typeof data.error.message === 'string'
            ? data.error.message
            : ${hasDraft ? `(completedAction === 'draft' ? 'Failed to save draft.' : ${quoteJsString(m.sendFailedText)})` : quoteJsString(m.sendFailedText)};
${hasDraft ? `          if (completedAction === 'draft') {
            // Retry re-invokes the draft tool, not the send tool — pendingAction
            // is already cleared, so this is what the Retry handler routes on.
            retryAction = 'draft';
          }
` : ''}${blockedSend ? `          // Prefer the host-vetted structured reason (a closed enum the host
          // derives from the tool-block error data) and fall back to
          // text-matching the flattened message for hosts that don't forward it
          // yet. Only 'user-disabled' opens the Gmail escape hatch —
          // admin-disabled and security-policy blocks stay ordinary errors (see
          // the detector comment above for why).
${hasDraft ? `          // Send-failure only: a blocked DRAFT tool must never surface the
          // "sending is turned off" copy or the Open-in-Gmail bypass.
          ` : ''}var blockedReason = data.error.data && data.error.data.reason;
          if (${hasDraft ? 'completedAction !== \'draft\' && ' : ''}(blockedReason === 'user-disabled' || isUserDisabledSendError(errorMessage))) {
            showBlockedSend();
            return;
          }
` : ''}          showError(errorMessage);
          return;
        }

        clearError();
        clearSuccess();
${hasDraft ? `        if (completedAction === 'draft') {
          // Terminal: the draft now lives in the mailbox's Drafts folder.
          // Collapse to a stamped confirmation and retire the form — Reopen
          // would resurrect an editable copy whose next Save/Send silently
          // diverges from (or duplicates) the saved draft.
          var draftStamp = formatSentTime();
          setCollapsed(true, draftStamp ? 'Draft saved · ' + draftStamp : 'Draft saved.');
          reopenButton.classList.add('hidden');
          return;
        }
` : ''}${gmail ? `        // Preserve what was sent (and how to reach it) instead of discarding the
        // draft. pendingPayload is the exact payload we posted; the reply carries
        // the Gmail message/thread ids. We default to the collapsed summary, but
        // Reopen now restores a read-only view of the sent message.
` : `        // Preserve what was sent instead of discarding the draft. pendingPayload
        // is the exact payload we posted. We default to the collapsed summary, but
        // Reopen now restores a read-only view of the sent message.
`}        var sentPayload = pendingPayload || readFormPayload();
        var stamp = formatSentTime();
        renderSentView(sentPayload, getSendMetaFromResult(data.result), stamp);
        sent = true;
        setCollapsed(true, stamp ? ${quoteJsString(m.sentCollapseStamped)} + stamp : ${quoteJsString(m.sentCollapseDefault)});
      });

      if (typeof ResizeObserver === 'function' && document.body) {
        var observer = new ResizeObserver(postResize);
        observer.observe(document.body);
      }

      applyThemeFromHostContext();
${f.cc ? `      setCcVisible(false);
` : ''}${f.bcc ? `      setBccVisible(false);
` : ''}      setCollapsed(false);
      postResize();
      postReady();

      window.parent.postMessage(
        {
          jsonrpc: '2.0',
          method: 'ui/initialize',
          params: { resourceUri: RESOURCE_URI },
          id: 'compose-email-init'
        },
        '*'
      );
    })();
  </script>
</body>
</html>
`;
}
