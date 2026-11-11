import { HoldRequestSchema } from '@seatlock/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError, errorHandler } from '../../src/errors';
import { parse } from '../../src/http';

const app = express()
  .use(express.json())
  .post('/hold', (req, res) => {
    res.json(parse(HoldRequestSchema, req.body));
  })
  .post('/raw-zod', (req, res) => {
    res.json(HoldRequestSchema.parse(req.body));
  })
  .get('/taken', () => {
    throw new AppError('SEATS_UNAVAILABLE', 'Some seats were just taken', { takenSeatIds: [3] });
  })
  .get('/expired', async () => {
    throw new AppError('HOLD_EXPIRED');
  })
  .get('/crash', () => {
    throw new Error('connection string postgres://user:pw@host leaked');
  })
  .use(errorHandler);

describe('errorHandler', () => {
  it('renders an AppError with its status, code, message and details', async () => {
    const res = await request(app).get('/taken');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'SEATS_UNAVAILABLE', message: 'Some seats were just taken', details: { takenSeatIds: [3] } },
    });
  });

  it('gives an AppError without a message a readable default, from async handlers too', async () => {
    const res = await request(app).get('/expired');
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: { code: 'HOLD_EXPIRED', message: 'Hold expired' } });
  });

  it('maps validation failures to 400 VALIDATION_FAILED with the zod issues', async () => {
    for (const path of ['/hold', '/raw-zod']) {
      const res = await request(app).post(path).send({ eventId: 'x', seatIds: [5, 5] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      const paths = res.body.error.details.map((i: { path: (string | number)[] }) => i.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['eventId', 'seatIds']));
    }
  });

  it('hides the message of unexpected errors behind 500 INTERNAL', async () => {
    const res = await request(app).get('/crash');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });
});

describe('parse', () => {
  it('returns the parsed, normalised value', () => {
    const eventId = '0b6f4b5e-5d4a-4bb3-9a4c-6f1f7c2a9e10';
    expect(parse(HoldRequestSchema, { eventId, seatIds: [1, 2], extra: true })).toEqual({ eventId, seatIds: [1, 2] });
  });
});
