export declare const REQUEST_TIMEOUT_MS = 60000;
export declare const RECRAFT_API_BASE = "https://external.api.recraft.ai/v1";
export declare class RecraftError extends Error {
    readonly code: string;
    readonly resolution: string;
    constructor(message: string, code: string, resolution: string);
}
export interface RecraftGeneratedImage {
    id?: string;
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
    type?: string;
}
export interface RecraftGenerationResponse {
    data?: RecraftGeneratedImage[];
    image?: RecraftGeneratedImage;
    [key: string]: unknown;
}
export interface RecraftUserInfo {
    id: string;
    email: string;
    name: string;
    credits: number;
}
//# sourceMappingURL=types.d.ts.map