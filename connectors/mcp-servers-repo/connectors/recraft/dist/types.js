export const REQUEST_TIMEOUT_MS = 60_000;
export const RECRAFT_API_BASE = 'https://external.api.recraft.ai/v1';
export class RecraftError extends Error {
    code;
    resolution;
    constructor(message, code, resolution) {
        super(message);
        this.code = code;
        this.resolution = resolution;
        this.name = 'RecraftError';
    }
}
//# sourceMappingURL=types.js.map