export type TransportSurface = 'browser-extension' | 'office-addin';

export type TransportKind = 'port-discovery' | 'sidecar-proxy';

export interface TransportDescriptor {
  surface: TransportSurface;
  origin: string;
  transportKind: TransportKind;
}

export interface HeaderBuildInit {
  requestId: string;
  contentType?: string;
  accept?: string;
}

/**
 * Surface-owned transport seam for the shared intent client.
 *
 * This consolidates URL resolution, auth/header construction, and optional
 * request-body stamping into one interface so the shared client remains
 * platform-agnostic.
 */
export interface IntentTransportAdapter {
  resolveBaseUrl(): string;
  buildHeaders(init: HeaderBuildInit): Promise<Headers>;
  stampRequestBody?(body: Record<string, unknown>): Record<string, unknown>;
  describeForLog(): TransportDescriptor;
  isReachable?(): Promise<boolean>;
  probeReachability?(): Promise<boolean>;
}
