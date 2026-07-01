import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// routes/auth.js has no logic of its own beyond wiring Better Auth's
// toNodeHandler — Better Auth's own sign-up/sign-in/session behavior is the
// library's responsibility to test, not ours. These tests only verify that
// our wiring builds the handler from the right config and delegates every
// request to it.
const mockAuthConfig = { marker: 'the-auth-config' };
jest.unstable_mockModule('../../auth.js', () => ({ auth: mockAuthConfig }));

const mockHandler = jest.fn((req, res) => res.status(200).json({ handled: true, path: req.originalUrl }));
const mockToNodeHandler = jest.fn(() => mockHandler);
jest.unstable_mockModule('better-auth/node', () => ({ toNodeHandler: mockToNodeHandler }));

const { authRouter } = await import('../../routes/auth.js');

const app = express();
app.use('/api/auth', authRouter);

describe('authRouter', () => {
  it('builds its handler from toNodeHandler(auth) using our auth config', () => {
    expect(mockToNodeHandler).toHaveBeenCalledWith(mockAuthConfig);
    expect(mockToNodeHandler).toHaveBeenCalledTimes(1);
  });

  it('delegates requests under /api/auth to the Better Auth handler', async () => {
    const res = await request(app).post('/api/auth/sign-in/email').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handled: true, path: '/api/auth/sign-in/email' });
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it('delegates nested paths like get-session too', async () => {
    const res = await request(app).get('/api/auth/get-session');

    expect(res.status).toBe(200);
    expect(res.body.path).toBe('/api/auth/get-session');
  });
});
