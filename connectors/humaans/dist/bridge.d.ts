/**
 * Path to bridge state file, supporting both current and legacy env vars.
 */
export declare const BRIDGE_STATE_PATH: string;
/**
 * Send a request to the host app bridge.
 *
 * The bridge is an HTTP server running inside the host app (e.g. the host application)
 * that handles credential management and other cross-process operations.
 */
export declare const bridgeRequest: (urlPath: string, body: Record<string, unknown>) => Promise<{
    success: boolean;
    warning?: string;
    error?: string;
}>;
//# sourceMappingURL=bridge.d.ts.map