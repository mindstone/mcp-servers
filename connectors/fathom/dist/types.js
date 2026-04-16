export const REQUEST_TIMEOUT_MS = 30_000;
export const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';
export class FathomError extends Error {
    code;
    resolution;
    constructor(message, code, resolution) {
        super(message);
        this.code = code;
        this.resolution = resolution;
        this.name = 'FathomError';
    }
}
//# sourceMappingURL=types.js.map