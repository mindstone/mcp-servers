import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'node:path';
import { ElevenLabsError } from './types.js';
import { getAudioWorkspaceRoot } from './tools/path-safety.js';

export type RetainedOutput = { file_path: string; size_bytes: number; media_type: string; state: 'incomplete' | 'complete' };
export type ProgressContext = { progressToken: string | number; sendNotification: (notification: ProgressNotification) => Promise<void> };
type StreamValue = { ref: string; bytes: number; mime: string; state: 'running' | 'complete' | 'incomplete' };
// Standalone wire copy; the serialized conformance fixture is checked by the receiver too.
export const buildStreamedResultMeta = (value: StreamValue) => ({ 'com.mindstone/stream': { version: 1 as const, ...value } });

/** Call-local leading/trailing counter coalescer; the executor owns terminal settlement. */
export function artifactProgress(mime: string, context?: ProgressContext, signal?: AbortSignal, retainUnpublished = false) {
  let latest: { file_path: string; size_bytes: number } | undefined;
  let published = false, settled = false, ordinal = 0, last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  let failure: ElevenLabsError | undefined;
  const retained = (): RetainedOutput | undefined => (published || retainUnpublished) && latest?.size_bytes
    ? { ...latest, media_type: mime, state: 'incomplete' } : undefined;
  const emit = async (state: StreamValue['state']) => {
    if (!context || !latest?.size_bytes) return;
    last = Date.now();
    const root = process.env.MCP_WORKSPACE_PATH?.trim();
    const ref = root ? path.relative(getAudioWorkspaceRoot(), latest.file_path).split(path.sep).join('/') : undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([context.sendNotification({ method: 'notifications/progress', params: {
        progressToken: context.progressToken, progress: ++ordinal, message: `Saved ${latest.size_bytes} bytes (${state}).`,
        ...(ref ? { _meta: buildStreamedResultMeta({ ref, bytes: latest.size_bytes, mime, state }) } : {}),
      } }), new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      })]);
      published = true;
    } catch { failure = new ElevenLabsError('Output progress could not be delivered.', 'PROGRESS_DELIVERY_FAILED', 'The request was not retried.'); }
    finally { if (abort) signal?.removeEventListener('abort', abort); }
  };
  return {
    retained,
    async update(file_path: string, size_bytes: number, abortSignal = signal) {
      if (settled) return;
      signal = abortSignal;
      latest = { file_path, size_bytes };
      await pending;
      if (failure) throw failure;
      if (!context || !size_bytes) return;
      if (Date.now() - last >= 250) { clearTimeout(timer); timer = undefined; await emit('running'); if (failure) throw failure; }
      else if (!timer) timer = setTimeout(() => {
        timer = undefined;
        if (!settled) pending = emit('running');
      }, 250 - (Date.now() - last));
    },
    async finish(state: 'complete' | 'incomplete') {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await pending;
      await emit(state);
      if (failure) throw failure;
    },
  };
}
export type ArtifactProgress = ReturnType<typeof artifactProgress>;
