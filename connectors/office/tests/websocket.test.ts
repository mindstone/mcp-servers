// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskpaneController } from '../src/addin/taskpane.js';
import { SidecarWebSocketClient } from '../src/addin/websocket.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.dispatchClose();
  }

  dispatchOpen(): void {
    this.onopen?.(new Event('open'));
  }

  dispatchClose(code = 1006): void {
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

function createOkResponse(ok = true): Response {
  return { ok, status: ok ? 200 : 503 } as Response;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createClient(options: Partial<ConstructorParameters<typeof SidecarWebSocketClient>[0]> = {}): SidecarWebSocketClient {
  return new SidecarWebSocketClient({
    app: 'word',
    version: '1.0.0',
    config: { port: 52100, token: 'test-token' },
    onCommand: async () => ({ success: true, data: {} }),
    onStateChange: () => {},
    ...options,
  });
}

function renderTaskpaneDom(): void {
  document.body.innerHTML = `
    <div id="status" class="status disconnected">
      <span class="status-dot"></span>
      <div class="status-content">
        <span id="status-text" class="status-text">Initializing…</span>
        <p id="status-detail" class="status-detail" hidden></p>
        <button id="retry-connect" class="status-button" type="button" hidden>Try again</button>
      </div>
    </div>
    <div id="command-log"></div>
  `;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function connectAndGetSocket(client: SidecarWebSocketClient, force = false): Promise<MockWebSocket> {
  await client.connect(force);
  await flushMicrotasks();

  const socket = MockWebSocket.instances.at(-1);
  expect(socket).toBeDefined();
  return socket!;
}

async function advanceReconnect(delayMs: number): Promise<MockWebSocket> {
  await vi.advanceTimersByTimeAsync(delayMs);
  await flushMicrotasks();

  const socket = MockWebSocket.instances.at(-1);
  expect(socket).toBeDefined();
  return socket!;
}

async function exhaustReconnectWindow(client: SidecarWebSocketClient): Promise<void> {
  const currentSocket = MockWebSocket.instances.at(-1);
  expect(currentSocket).toBeDefined();
  currentSocket!.dispatchClose();

  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
    const nextSocket = await advanceReconnect(delay);
    nextSocket.dispatchClose();
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  MockWebSocket.reset();
  document.body.innerHTML = '';
});

describe('SidecarWebSocketClient', () => {
  it.each(['unchanged', 'unknown'] as const)('bounds repeated 4001 with %s credentials at thirty seconds without Connected', async (outcome) => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));
    const started = Date.now();
    const onGaveUp = vi.fn();
    const onStateChange = vi.fn();
    const noteRejected = vi.fn(async () => outcome);
    const client = createClient({ credential: { noteRejected }, onGaveUp, onStateChange });
    try {
      let socket = await connectAndGetSocket(client);
      for (const delay of [1_000, 2_000, 4_000, 8_000]) {
        socket.dispatchOpen();
        expect(socket.sent[0]).toBe(JSON.stringify({ type: 'auth', token: 'test-token' }));
        socket.dispatchClose(4001);
        await flushMicrotasks();
        socket = await advanceReconnect(delay);
      }
      socket.dispatchOpen();
      socket.dispatchClose(4001);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(30_000 - (Date.now() - started));
      expect(noteRejected.mock.calls).toEqual(Array.from({ length: 5 }, () => ['test-token']));
      expect(onStateChange).not.toHaveBeenCalledWith('connected');
      expect(onGaveUp).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeLessThanOrEqual(30_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  it('does not refresh credentials for a superseded 4003 socket', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));
    const noteRejected = vi.fn(async () => 'changed' as const);
    const client = createClient({ credential: { noteRejected } });
    const socket = await connectAndGetSocket(client);
    socket.dispatchOpen();
    socket.dispatchClose(4003);
    await flushMicrotasks();
    expect(noteRejected).not.toHaveBeenCalled();
    expect(client.state).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(1);
    client.disconnect();
  });

  it('does not reconnect after disposal during a pending rejected-credential refresh', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));
    const refresh = createDeferred<'unchanged'>();
    const noteRejected = vi.fn(() => refresh.promise);
    const client = createClient({ credential: { noteRejected } });
    const socket = await connectAndGetSocket(client);
    socket.dispatchOpen();
    socket.dispatchClose(4001);
    expect(noteRejected).toHaveBeenCalledWith('test-token');
    client.disconnect();
    refresh.resolve('unchanged');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['missing server version', { serverProtocolVersion: undefined }],
    ['wrong server version', { serverProtocolVersion: '2.0' }],
    ['missing client version', { minClientProtocolVersion: undefined }],
    ['wrong client version', { minClientProtocolVersion: '2.0' }],
    ['empty session', { sessionId: '' }],
    ['non-array capabilities', { acceptedCapabilities: 'read_document' }],
    ['non-string capability', { acceptedCapabilities: [null] }],
  ])('does not accept or reset tracking for an invalid registered ack: %s', async (_label, invalid) => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));
    const client = createClient();
    const first = await connectAndGetSocket(client);
    first.dispatchClose();
    const socket = await advanceReconnect(1_000);
    socket.dispatchOpen();
    const tracking = client as { reconnectAttempts: number; firstReconnectAttemptAt: number | undefined };
    const started = tracking.firstReconnectAttemptAt;
    expect(tracking.reconnectAttempts).toBe(1);
    socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
      type: 'registered', sessionId: 'fictional-session', acceptedCapabilities: [],
      serverProtocolVersion: '1.0', minClientProtocolVersion: '1.0', ...invalid,
    }) }));
    expect(client.state).toBe('authenticating');
    expect(tracking.reconnectAttempts).toBe(1);
    expect(tracking.firstReconnectAttemptAt).toBe(started);
    expect(vi.getTimerCount()).toBe(1);
    client.disconnect();
  });

  it('fires onGaveUp exactly once and clears the reconnect timer after the retry window expires', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const onGaveUp = vi.fn();
    const client = createClient({ onGaveUp });

    await connectAndGetSocket(client);
    await exhaustReconnectWindow(client);

    expect(onGaveUp).toHaveBeenCalledTimes(1);
    expect((client as { reconnectTimer: ReturnType<typeof setTimeout> | null }).reconnectTimer).toBeNull();
  });

  it('lets connect(true) reset the reconnect window and give up again on the next cycle', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const onGaveUp = vi.fn();
    const client = createClient({ onGaveUp });

    await connectAndGetSocket(client);
    await exhaustReconnectWindow(client);
    expect(onGaveUp).toHaveBeenCalledTimes(1);

    await connectAndGetSocket(client, true);
    await exhaustReconnectWindow(client);

    expect(onGaveUp).toHaveBeenCalledTimes(2);
  });

  it('avoids websocket attempts and gives up immediately when connect(true) fails the health probe', async () => {
    vi.mocked(fetch).mockResolvedValue(createOkResponse(false));

    const onGaveUp = vi.fn();
    const client = createClient({ onGaveUp });

    await client.connect(true);

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
  });

  it('attempts a websocket connection when connect(true) gets a healthy /health response', async () => {
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const client = createClient();

    await client.connect(true);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toBe('ws://localhost:52100/ws');
  });

  it('resets reconnect tracking only after a valid current registration acknowledgement', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const client = createClient();

    await connectAndGetSocket(client);
    MockWebSocket.instances[0]?.dispatchClose();
    expect((client as { reconnectAttempts: number }).reconnectAttempts).toBe(1);

    const retrySocket = await advanceReconnect(1_000);
    retrySocket.dispatchOpen();

    expect(client.state).toBe('authenticating');
    expect((client as { reconnectAttempts: number }).reconnectAttempts).toBe(1);
    retrySocket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
      type: 'registered', sessionId: 'fictional-session', acceptedCapabilities: [],
      serverProtocolVersion: '1.0', minClientProtocolVersion: '1.0',
    }) }));

    expect(client.state).toBe('connected');
    expect((client as { reconnectAttempts: number }).reconnectAttempts).toBe(0);
    expect((client as { firstReconnectAttemptAt: number | undefined }).firstReconnectAttemptAt).toBeUndefined();
    expect(retrySocket.sent).toEqual([
      JSON.stringify({ type: 'auth', token: 'test-token' }),
      JSON.stringify({ type: 'register', app: 'word', version: '1.0.0' }),
    ]);
  });

  it('leaves an old helper unconfirmed within the existing budget while still handling commands', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));
    const onCommand = vi.fn(async () => ({ success: true as const, data: {} }));
    const onGaveUp = vi.fn();
    const client = createClient({ onCommand, onGaveUp });
    const socket = await connectAndGetSocket(client);
    socket.dispatchOpen();
    socket.onmessage?.(new MessageEvent('message', { data: '{"type":"ping"}' }));
    expect(client.state).toBe('authenticating');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.state).toBe('disconnected');
    expect(onGaveUp).not.toHaveBeenCalled(); // Reachable is not "Rebel is closed".
    expect(vi.getTimerCount()).toBe(0);
    socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
      type: 'command', id: 'fictional-command', action: 'read_document', params: {},
    }) }));
    await flushMicrotasks();
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('connected');
    client.disconnect();
  });

  it('ignores late old socket callbacks and never sends an old command result to its successor', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));
    const pending = createDeferred<{ success: true; data: unknown }>();
    const client = createClient({ onCommand: () => pending.promise });
    const old = await connectAndGetSocket(client);
    old.dispatchOpen();
    old.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
      type: 'command', id: 'old-command', action: 'read_document', params: {},
    }) }));
    old.dispatchClose();
    const current = await advanceReconnect(1_000);
    current.dispatchOpen();
    old.dispatchOpen();
    old.dispatchClose();
    old.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
      type: 'registered', sessionId: 'old', acceptedCapabilities: [],
      serverProtocolVersion: '1.0', minClientProtocolVersion: '1.0',
    }) }));
    pending.resolve({ success: true, data: {} });
    await flushMicrotasks();
    expect(client.state).toBe('authenticating');
    expect(current.sent.map((raw) => JSON.parse(raw).type)).toEqual(['auth', 'register']);
    client.disconnect();
  });
});

describe('taskpane rebel-closed handling', () => {
  it('renders the rebel-closed state and wires the Try again button to connect(true)', () => {
    renderTaskpaneDom();
    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, healthUrl: 'https://localhost:52100/health' });

    controller.setState('rebel-closed');

    expect(document.getElementById('status-text')?.textContent).toBe("Can't reach Rebel.");
    expect(document.getElementById('status-detail')?.textContent).toBe('Make sure Rebel is open on this computer, then select Try again.');

    const button = document.getElementById('retry-connect') as HTMLButtonElement;
    expect(button.hidden).toBe(false);

    button.click();

    expect(document.getElementById('status-text')?.textContent).toBe('Connecting to Rebel…');
    expect(client.connect).toHaveBeenCalledWith(true);

    controller.dispose();
  });

  it('auto-probes /health every 5 seconds while rebel-closed and reconnects when Rebel is back', async () => {
    vi.useFakeTimers();
    renderTaskpaneDom();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, healthUrl: 'https://localhost:52100/health' });

    controller.setState('rebel-closed');
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('https://localhost:52100/health');
    expect(client.connect).toHaveBeenCalledWith(true);
    expect(document.getElementById('status-text')?.textContent).toBe('Connecting to Rebel…');

    controller.dispose();
  });

  it('does not double-connect when an auto-probe resolves after another path already moved the pane to connecting', async () => {
    vi.useFakeTimers();
    renderTaskpaneDom();

    const probe = createDeferred<Response>();
    vi.mocked(fetch).mockReturnValue(probe.promise);

    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, healthUrl: 'https://localhost:52100/health' });

    controller.setState('rebel-closed');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetch).toHaveBeenCalledTimes(1);

    controller.setState('connecting');
    probe.resolve(createOkResponse(true));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(client.connect).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.getElementById('status-text')?.textContent).toBe('Connecting to Rebel…');

    controller.dispose();
  });

  it('probes once on visibilitychange while rebel-closed and reconnects when visible again', async () => {
    renderTaskpaneDom();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, healthUrl: 'https://localhost:52100/health' });

    controller.setState('rebel-closed');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledWith(true);

    controller.dispose();
  });

  it('stays in rebel-closed when auto-probes keep failing', async () => {
    vi.useFakeTimers();
    renderTaskpaneDom();
    vi.mocked(fetch).mockRejectedValue(new Error('still down'));

    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, healthUrl: 'https://localhost:52100/health' });

    controller.setState('rebel-closed');
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.connect).not.toHaveBeenCalled();
    expect(controller.getState()).toBe('rebel-closed');
    expect(document.getElementById('status-text')?.textContent).toBe("Can't reach Rebel.");

    controller.dispose();
  });

  it('clears the auto-probe interval and visibility listener after a successful reconnect', async () => {
    vi.useFakeTimers();
    renderTaskpaneDom();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, healthUrl: 'https://localhost:52100/health' });

    controller.setState('rebel-closed');
    controller.setState('connected');

    expect(clearIntervalSpy).toHaveBeenCalled();

    vi.mocked(fetch).mockClear();
    client.connect.mockClear();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(fetch).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();

    controller.dispose();
  });
  it('does not reconnect after disposal of a controller with a pending health probe', async () => {
    vi.useFakeTimers();
    renderTaskpaneDom();
    const health = createDeferred<Response>();
    const fetchImpl = vi.fn(() => health.promise);
    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, fetchImpl, healthUrl: 'https://localhost:52100/health' });
    controller.setState('rebel-closed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    controller.dispose();
    health.resolve(createOkResponse());
    await flushMicrotasks();
    expect(client.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

});
