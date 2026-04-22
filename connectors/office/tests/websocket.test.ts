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

  dispatchClose(): void {
    this.onclose?.(new CloseEvent('close'));
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

  it('resets reconnect tracking when the websocket opens successfully', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const client = createClient();

    await connectAndGetSocket(client);
    MockWebSocket.instances[0]?.dispatchClose();
    expect((client as { reconnectAttempts: number }).reconnectAttempts).toBe(1);

    const retrySocket = await advanceReconnect(1_000);
    retrySocket.dispatchOpen();

    expect((client as { reconnectAttempts: number }).reconnectAttempts).toBe(0);
    expect((client as { firstReconnectAttemptAt: number | undefined }).firstReconnectAttemptAt).toBeUndefined();
    expect(retrySocket.sent).toEqual([
      JSON.stringify({ type: 'auth', token: 'test-token' }),
      JSON.stringify({ type: 'register', app: 'word', version: '1.0.0' }),
    ]);
  });
});

describe('taskpane rebel-closed handling', () => {
  it('renders the rebel-closed state and wires the Try again button to connect(true)', () => {
    renderTaskpaneDom();
    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, healthUrl: 'https://localhost:52100/health' });

    controller.setState('rebel-closed');

    expect(document.getElementById('status-text')?.textContent).toBe('Rebel is closed.');
    expect(document.getElementById('status-detail')?.textContent).toBe('Open Rebel to reconnect.');

    const button = document.getElementById('retry-connect') as HTMLButtonElement;
    expect(button.hidden).toBe(false);

    button.click();

    expect(document.getElementById('status-text')?.textContent).toBe('Connecting to Rebel…');
    expect(client.connect).toHaveBeenCalledWith(true);

    controller.dispose();
  });

  it('auto-probes /health every 60 seconds while rebel-closed and reconnects when Rebel is back', async () => {
    vi.useFakeTimers();
    renderTaskpaneDom();
    vi.mocked(fetch).mockResolvedValue(createOkResponse(true));

    const client = { connect: vi.fn().mockResolvedValue(undefined) };
    const controller = createTaskpaneController({ client, healthUrl: 'https://localhost:52100/health' });

    controller.setState('rebel-closed');
    await vi.advanceTimersByTimeAsync(60_000);
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
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetch).toHaveBeenCalledTimes(1);

    controller.setState('connecting');
    probe.resolve(createOkResponse(true));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(60_000);

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
    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.connect).not.toHaveBeenCalled();
    expect(controller.getState()).toBe('rebel-closed');
    expect(document.getElementById('status-text')?.textContent).toBe('Rebel is closed.');

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

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(fetch).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();

    controller.dispose();
  });
});
