// Hand-maintained declaration twin of buildComposeAppHtml.mjs (which stays
// plain JS + JSDoc so node 20 can import it without TS tooling). If the .mjs
// signature changes, update this file in the same change.
import type { ComposeAppConfig, ComposeMode, ComposeSendOptions, ComposeSend } from './types.js';

export declare function buildSendArguments(mode: ComposeMode, draft: Record<string, unknown>, options: ComposeSendOptions): ComposeSend;
export declare function buildSendArgumentsModule(config: ComposeAppConfig): string;

/**
 * Builds the full compose/save-draft/send MCP-App iframe HTML document for
 * one connector's configuration. Throws on invalid config.
 */
export declare function buildComposeAppHtml(config: ComposeAppConfig): string;
