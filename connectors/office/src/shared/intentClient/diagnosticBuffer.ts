import { NO_OP_SINK, type DiagnosticEvent, type DiagnosticSink } from './diagnostics.js';

const DEFAULT_CAPACITY = 50;

export interface InMemoryDiagnosticBuffer extends DiagnosticSink {
  dump(): DiagnosticEvent[];
  dumpById(requestId: string): DiagnosticEvent[];
  clear(): void;
}

export interface InMemoryDiagnosticBufferOptions {
  capacity?: number;
  sink?: DiagnosticSink;
}

export function composeDiagnosticSinks(...sinks: DiagnosticSink[]): DiagnosticSink {
  if (sinks.length === 0) {
    return NO_OP_SINK;
  }
  if (sinks.length === 1) {
    return sinks[0]!;
  }
  return {
    emit(event: DiagnosticEvent): void {
      for (const sink of sinks) {
        try {
          sink.emit(event);
        } catch {
          // Non-throwing invariant: diagnostics must never break callers.
        }
      }
    },
  };
}

export function createInMemoryDiagnosticBuffer(
  { capacity = DEFAULT_CAPACITY, sink }: InMemoryDiagnosticBufferOptions = {},
): InMemoryDiagnosticBuffer {
  const safeCapacity =
    Number.isFinite(capacity) && capacity > 0
      ? Math.floor(capacity)
      : DEFAULT_CAPACITY;
  const ring = new Array<DiagnosticEvent>(safeCapacity);
  let size = 0;
  let writeIndex = 0;

  const downstream = sink ?? NO_OP_SINK;

  return {
    emit(event: DiagnosticEvent): void {
      ring[writeIndex] = event;
      writeIndex = (writeIndex + 1) % safeCapacity;
      if (size < safeCapacity) {
        size += 1;
      }
      try {
        downstream.emit(event);
      } catch {
        // Non-throwing invariant: diagnostics must never break callers.
      }
    },
    dump(): DiagnosticEvent[] {
      if (size === 0) {
        return [];
      }
      const start = size === safeCapacity ? writeIndex : 0;
      const events: DiagnosticEvent[] = [];
      for (let i = 0; i < size; i += 1) {
        events.push(ring[(start + i) % safeCapacity]!);
      }
      return events;
    },
    dumpById(requestId: string): DiagnosticEvent[] {
      return this.dump().filter((event) => event.requestId === requestId);
    },
    clear(): void {
      size = 0;
      writeIndex = 0;
    },
  };
}
