// Hand-maintained declaration twin of gen-compose-html.mjs (plain JS so it
// runs under node without TS tooling). Update alongside the .mjs.
import type { ComposeAppConfig } from '@mindstone/mcp-app-compose';

export declare const GMAIL_COMPOSE_APP_CONFIG: ComposeAppConfig;
export declare function buildFileContents(): { templateTs: string; previewHtml: string };
