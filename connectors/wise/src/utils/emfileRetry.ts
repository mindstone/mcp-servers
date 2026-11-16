export async function withRetryOnEmfile<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EMFILE') {
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    return operation();
  }
}

export function withSingleSyncRetryOnEmfile<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EMFILE') {
      throw error;
    }
    return operation();
  }
}
