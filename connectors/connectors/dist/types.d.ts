export declare const REQUEST_TIMEOUT_MS = 30000;
export declare const HUMAANS_API_BASE = "https://app.humaans.io/api";
export interface BridgeState {
    port: number;
    token: string;
}
export declare class HumaansError extends Error {
    readonly code: string;
    readonly resolution: string;
    constructor(message: string, code: string, resolution: string);
}
export interface HumaansListResponse<T> {
    total: number;
    limit: number;
    skip: number;
    data: T[];
}
export interface HumaansErrorResponse {
    id?: string;
    code: number;
    name: string;
    message: string;
    issues?: Array<{
        name: string;
        reason: string;
        forbidden?: boolean;
    }>;
}
/**
 * Compact person representation for list responses (allowlist for security).
 */
export interface PersonCompact {
    id: string;
    firstName: string;
    lastName: string;
    preferredName: string | null;
    email: string;
    status: string;
    contractType: string | null;
    teams: Array<{
        name: string;
    }>;
    locationId: string | null;
    jobTitle?: string;
    department?: string;
    employmentStartDate: string | null;
    employmentEndDate: string | null;
    timezone: string | null;
}
//# sourceMappingURL=types.d.ts.map