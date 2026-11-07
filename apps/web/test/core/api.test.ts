import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, newIdempotencyKey } from '../../src/lib/api';

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('api', () => {
  it('sends JSON with cookies and resolves with the parsed body', async () => {
    fetchMock.mockResolvedValue(json(201, { hold: { id: 'h1' } }));
    const data = await api<{ hold: { id: string } }>('/api/holds', {
      method: 'POST',
      body: { eventId: 'e1', seatIds: [1] },
      headers: { 'X-Queue-Token': 'tok' },
    });

    expect(data).toEqual({ hold: { id: 'h1' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/holds');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{"eventId":"e1","seatIds":[1]}' });
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Queue-Token': 'tok' });
  });

  it('uses GET without a body and POST when a body is given', async () => {
    fetchMock.mockImplementation(async () => json(200, {}));
    await api('/api/events');
    await api('/api/auth/login', { body: { email: 'a@b.co', password: 'pw' } });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST']);
  });

  it('throws ApiError carrying the error body', async () => {
    fetchMock.mockResolvedValue(
      json(409, { error: { code: 'SEATS_UNAVAILABLE', message: '2 seats were just taken', details: { takenSeatIds: [4, 5] } } }),
    );
    const error = await api('/api/holds', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'SEATS_UNAVAILABLE',
      message: '2 seats were just taken',
      details: { takenSeatIds: [4, 5] },
    });
  });

  it('copes with an error response that is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('Bad gateway', { status: 502 }));
    await expect(api('/api/events')).rejects.toMatchObject({ status: 502, code: 'INTERNAL' });
  });

  it('resolves with undefined for 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api('/api/holds/h1', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('turns a network failure into a NETWORK_ERROR ApiError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api('/api/events')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('rethrows aborts untouched', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValue(abort);
    await expect(api('/api/events')).rejects.toBe(abort);
  });

  it('refuses paths outside /api/', async () => {
    await expect(api('/events')).rejects.toThrow(/\/api\//);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('newIdempotencyKey', () => {
  it('returns a fresh UUID each time', () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(key);
  });
});
