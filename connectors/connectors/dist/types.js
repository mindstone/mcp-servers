export const REQUEST_TIMEOUT_MS = 30_000;
export const HUMAANS_API_BASE = 'https://app.humaans.io/api';
export class HumaansError extends Error {
    code;
    resolution;
    constructor(message, code, resolution) {
        super(message);
        this.code = code;
        this.resolution = resolution;
        this.name = 'HumaansError';
    }
}
//# sourceMappingURL=types.js.map