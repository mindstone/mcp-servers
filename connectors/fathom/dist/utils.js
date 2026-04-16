import { FathomError } from './types.js';
/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On FathomError: returns a structured JSON error with code and resolution.
 * - On unknown error: returns a generic error message.
 *
 * Secrets are never exposed in error messages.
 */
export function withErrorHandling(fn) {
    return async (args, extra) => {
        try {
            const result = await fn(args, extra);
            return { content: [{ type: 'text', text: result }] };
        }
        catch (error) {
            if (error instanceof FathomError) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: false,
                                error: error.message,
                                code: error.code,
                                resolution: error.resolution,
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errorMessage }) }],
                isError: true,
            };
        }
    };
}
//# sourceMappingURL=utils.js.map