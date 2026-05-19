export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: {
      status?: unknown;
      statusCode?: unknown;
      data?: {
        error?: unknown;
      };
    };
    errors?: Array<{ reason?: unknown }>;
  };

  return candidate.code === 401
    || candidate.code === '401'
    || candidate.status === 401
    || candidate.status === '401'
    || candidate.response?.status === 401
    || candidate.response?.status === '401'
    || candidate.response?.statusCode === 401
    || candidate.response?.statusCode === '401'
    || candidate.response?.data?.error === 'unauthorized'
    || candidate.errors?.some((entry) => entry.reason === 'authError') === true;
}

export function isRefreshTokenInvalidError(error: unknown): boolean {
  const values: string[] = [];

  if (error instanceof Error) {
    values.push(error.message);
    const cause = error.cause;
    if (cause instanceof Error) {
      values.push(cause.message);
    }
  }

  if (error && typeof error === 'object') {
    const candidate = error as {
      error?: unknown;
      error_description?: unknown;
      response?: {
        data?: {
          error?: unknown;
          error_description?: unknown;
        };
      };
    };
    for (const value of [
      candidate.error,
      candidate.error_description,
      candidate.response?.data?.error,
      candidate.response?.data?.error_description,
    ]) {
      if (typeof value === 'string') {
        values.push(value);
      }
    }
  }

  const combined = values.join(' ').toLowerCase();
  return combined.includes('invalid_grant')
    || combined.includes('revoked')
    || combined.includes('token has been revoked')
    || combined.includes('token not found');
}
