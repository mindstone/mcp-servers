import { RecraftError } from './types.js';
export function withErrorHandling(fn) {
    return async (args, extra) => {
        try {
            const result = await fn(args, extra);
            return { content: [{ type: 'text', text: result }] };
        }
        catch (error) {
            if (error instanceof RecraftError) {
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
            const message = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }],
                isError: true,
            };
        }
    };
}
//# sourceMappingURL=utils.js.map