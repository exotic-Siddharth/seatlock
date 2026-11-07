import { vi } from 'vitest';

export type ApiCall = { method: string; path: string; body: unknown; headers: Record<string, string> };
type Reply = [status: number, body?: unknown];
type Route = Reply | ((call: ApiCall) => Reply | Promise<Reply>);

/**
 * Replaces fetch with a router of canned replies keyed by "METHOD /path".
 * Unknown routes answer 404, so a missing mock shows up as a visible error.
 */
export function mockApi(routes: Record<string, Route>) {
  const calls: ApiCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: ApiCall = {
      method: init?.method ?? 'GET',
      path: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    const [status, body]: Reply = !route
      ? [404, { error: { code: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` } }]
      : typeof route === 'function'
        ? await route(call)
        : route;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    /** Calls to one route, e.g. callsTo('POST /api/holds'). */
    callsTo: (route: string) => calls.filter((c) => `${c.method} ${c.path}` === route),
  };
}

/** A controllable stand-in for the browser's EventSource. */
export class MockEventSource {
  static instances: MockEventSource[] = [];
  static latest(): MockEventSource {
    const source = MockEventSource.instances.at(-1);
    if (!source) throw new Error('No EventSource was opened');
    return source;
  }

  readonly url: string;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.readyState = 2;
  }

  /** The server accepted the stream. */
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** The connection dropped (laptop sleep, server restart, network blip). */
  fail() {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }

  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

export function installEventSource() {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
}
