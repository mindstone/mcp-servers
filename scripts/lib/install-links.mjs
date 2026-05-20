// Pure helper: derive Cursor / VS Code / VS Code Insiders one-click install URLs
// and a Markdown block for each connector from its server.json.
// No I/O. Imported by:
//   scripts/gen-install-links.mjs   (rewrites the marker block in each connector README)
//   scripts/build-catalogue.mjs     (renders the same buttons on docs/catalogue/<name>.md)
//
// Spec sources (current as of 2026-05):
//   Cursor — cursor://anysphere.cursor-deeplink/mcp/install?name=<NAME>&config=<BASE64_JSON>
//     <BASE64_JSON> is the server config WITHOUT a `name` field, base64-encoded.
//     Confirmed against danywalls.com (2026-04-02) and the unsplashx live links it ships.
//   VS Code — vscode:mcp/install?<URL_ENCODED_JSON>
//     The JSON includes `name` INSIDE the object. URL is JSON-stringified then
//     URL-encoded. Source: code.visualstudio.com/api/extension-guides/ai/mcp.
//   VS Code Insiders — vscode-insiders:mcp/install?<URL_ENCODED_JSON> (same shape).
//
// Security posture: every PR-controlled value (slug, server.json title,
// package identifier, env-var names) is regex-validated before it is allowed
// to flow into a URL or a Markdown link target. Anything that fails throws,
// because a malformed connector should fail CI loud rather than render silently.

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
// npm package identifier: must be a scoped package on the @mindstone scope or a
// plain lowercase package. We constrain tightly because this string is embedded
// inside both the URL and the Markdown JSON code block.
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// Friendly name: ASCII letters, digits, spaces, and a small set of safe
// punctuation. Allows parens and forward slashes so titles like
// `Email (IMAP/SMTP)` survive intact. Still excludes Markdown- and HTML-
// dangerous characters: `[`, `]`, `<`, `>`, `&`, backticks, quotes, braces.
// The friendly name only flows into encodeURIComponent'd URL fragments,
// JSON-quoted keys, and an HTML <summary> body — none of which can be
// hijacked by parens or slashes.
const FRIENDLY_NAME_RE = /^[A-Za-z0-9 .+\-_/()]{1,64}$/;

function assertSafeString(value, label, regex) {
  if (typeof value !== 'string' || !regex.test(value)) {
    throw new Error(`install-links: rejecting unsafe ${label} value '${value}'`);
  }
  return value;
}

// Stricter than encodeURIComponent: also percent-encodes `(`, `)`, `'`, `!`,
// `*`, `~`. encodeURIComponent leaves all six alone (they are 'unreserved'
// per RFC 3986), but `(` and `)` will close a Markdown link target early
// when the URL is embedded inside `[label](url)`. Without this wrapper a
// title like `Email (IMAP/SMTP)` produces an URL with a literal `)` that
// truncates the link before the IDE ever sees it.
//
// Reference: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent#encoding_for_rfc3986
function encodeUriComponentForMarkdown(value) {
  return encodeURIComponent(value).replace(
    /[()'!*~]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function deriveFriendlyName(serverJson, slug) {
  const title = serverJson?.title;
  if (typeof title === 'string' && FRIENDLY_NAME_RE.test(title)) {
    return title.trim();
  }
  // Fallback: title-case the slug (apple-shortcuts -> Apple Shortcuts).
  const fallback = slug
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
  // The slug is already SLUG_RE validated, so the fallback satisfies
  // FRIENDLY_NAME_RE by construction.
  return fallback;
}

// Build the env object that will be embedded in every install URL.
//
// Inclusion rule: a var lands in the URL when EITHER
//   - server.json declares it secret or required (the user MUST set it), OR
//   - it has a non-empty `default` value (so the IDE surfaces the recommended
//     value, e.g. ZENDESK_CONFIG_PATH=~/.mcp/zendesk, rather than silently
//     letting the connector fall back to that path at runtime).
// Truly optional flags (isRequired:false, isSecret:false, no default) — e.g.
// MCP_REPLIT_SSH_STRICT_HOST_KEY — stay out of the install prompt because
// they have no value worth showing.
//
// We deliberately do NOT fall back to substring-of-name heuristics (e.g.
// matching "KEY") — that mis-classifies safe toggles such as
// MCP_REPLIT_SSH_STRICT_HOST_KEY as secrets and pollutes the install prompt.
// Every server.json in this repo carries explicit isSecret/isRequired flags
// (CI rejects manifests that fail mcp-publisher validate), so trusting them
// is correct as well as simple.
//
// Value rule: secrets always render as the empty string so the host prompts
// for the real value; non-secrets render as their declared default if any,
// else empty string.
function buildEnvObject(envVars) {
  const env = {};
  if (!Array.isArray(envVars)) return env;
  for (const v of envVars) {
    if (typeof v?.name !== 'string') continue;
    if (!ENV_NAME_RE.test(v.name)) continue;
    const isSecret = v.isSecret === true;
    const isRequired = v.isRequired === true;
    const hasDefault = typeof v.default === 'string' && v.default.length > 0;
    if (!(isSecret || isRequired || hasDefault)) continue;
    if (isSecret) {
      env[v.name] = '';
    } else if (hasDefault) {
      env[v.name] = v.default;
    } else {
      env[v.name] = '';
    }
  }
  return env;
}

// Pure data construction. Throws on malformed input.
export function buildInstallLinks(slug, serverJson) {
  assertSafeString(slug, 'connector slug', SLUG_RE);

  const pkg = serverJson?.packages?.[0];
  if (!pkg) {
    throw new Error(`install-links: ${slug} server.json has no packages[0]`);
  }
  const identifier = assertSafeString(
    pkg.identifier,
    `package identifier for ${slug}`,
    PACKAGE_RE
  );

  const name = deriveFriendlyName(serverJson, slug);
  const env = buildEnvObject(pkg.environmentVariables);

  // Cursor expects the JSON config WITHOUT the wrapping name (name is the
  // query-param). VS Code expects name INSIDE the object.
  const cursorConfig = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', identifier],
    env,
  };
  // Use base64url instead of standard base64 so the encoded payload uses
  // `-` and `_` instead of `+` and `/`. Standard base64 happens to round-trip
  // through Cursor today (verified by inspecting the live unsplashx button),
  // but `+` carries `application/x-www-form-urlencoded` ambiguity (decodes to
  // a literal space in some parsers), and a future config containing `+` or
  // `/` would silently break. base64url removes the question entirely.
  const cursorBase64 = Buffer.from(JSON.stringify(cursorConfig), 'utf8').toString('base64url');
  // base64url is `[A-Za-z0-9_-]` so it doesn't need extra encoding, but the
  // friendly name does — see encodeUriComponentForMarkdown.
  const cursorUrl =
    'cursor://anysphere.cursor-deeplink/mcp/install' +
    `?name=${encodeUriComponentForMarkdown(name)}&config=${cursorBase64}`;

  const vscodeConfig = {
    name,
    command: 'npx',
    args: ['-y', identifier],
    env,
  };
  const vscodeJsonEncoded = encodeUriComponentForMarkdown(JSON.stringify(vscodeConfig));
  const vscodeUrl = `vscode:mcp/install?${vscodeJsonEncoded}`;
  const vscodeInsidersUrl = `vscode-insiders:mcp/install?${vscodeJsonEncoded}`;

  // Manual fallback JSON for hosts that don't speak any URL handler
  // (Claude Desktop today, Goose, Continue.dev, Cline-without-marketplace, etc.).
  const claudeJson = {
    mcpServers: {
      [name]: {
        command: 'npx',
        args: ['-y', identifier],
        env,
      },
    },
  };

  return {
    name,
    identifier,
    env,
    cursorUrl,
    vscodeUrl,
    vscodeInsidersUrl,
    claudeJson,
  };
}

// Render the Markdown block that goes into each connector README (between the
// BEGIN/END INSTALL_LINKS markers) and into each docs/catalogue/<name>.md page.
// Inputs come straight from buildInstallLinks() — already validated.
export function renderInstallBlock(links) {
  const { name, env, cursorUrl, vscodeUrl, vscodeInsidersUrl, claudeJson } = links;

  const envKeys = Object.keys(env);
  const envHint = envKeys.length
    ? `After clicking the button, your host will prompt you to fill: ${envKeys
        .map((k) => '`' + k + '`')
        .join(', ')}.`
    : 'No required environment variables — the install completes without prompts.';

  const claudeJsonString = JSON.stringify(claudeJson, null, 2);

  const cursorBadge =
    'https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white';
  const vscodeBadge =
    'https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white';
  const vscodeInsidersBadge =
    'https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white';

  // The trailing newline is intentional — keeps a clean separator after the
  // END marker so subsequent README sections are not glued to the block.
  return [
    '<!-- BEGIN INSTALL_LINKS: do not edit by hand; regenerated by scripts/gen-install-links.mjs -->',
    '## One-click install',
    '',
    `[![Add to Cursor](${cursorBadge})](${cursorUrl})`,
    `[![Add to VS Code](${vscodeBadge})](${vscodeUrl})`,
    `[![Add to VS Code Insiders](${vscodeInsidersBadge})](${vscodeInsidersUrl})`,
    '',
    envHint,
    '',
    '<details>',
    `<summary>Manual config for Claude Desktop / Claude Code / Goose / Continue.dev (${name})</summary>`,
    '',
    '```json',
    claudeJsonString,
    '```',
    '',
    '</details>',
    '<!-- END INSTALL_LINKS -->',
  ].join('\n');
}
