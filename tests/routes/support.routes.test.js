import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const USER_ID = 'user-1';

jest.unstable_mockModule('../../middleware/authenticate.js', () => ({
  authenticate: (req, res, next) => {
    req.session = { user: { id: USER_ID } };
    next();
  },
}));

const mockSupportService = {
  sendHelpRequest: jest.fn(),
};

jest.unstable_mockModule('../../services/supportService.js', () => mockSupportService);

const { supportRouter } = await import('../../routes/support.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/support', supportRouter);
app.use(errorHandler);

beforeEach(() => jest.clearAllMocks());

describe('POST /api/support', () => {
  it('sends the help request and returns 204', async () => {
    mockSupportService.sendHelpRequest.mockResolvedValue(undefined);

    const res = await request(app).post('/api/support').send({ message: 'How do I export a report?' });

    expect(res.status).toBe(204);
    expect(mockSupportService.sendHelpRequest).toHaveBeenCalledWith(USER_ID, 'How do I export a report?');
  });

  it('trims the message before sending', async () => {
    mockSupportService.sendHelpRequest.mockResolvedValue(undefined);

    await request(app).post('/api/support').send({ message: '  hello  ' });

    expect(mockSupportService.sendHelpRequest).toHaveBeenCalledWith(USER_ID, 'hello');
  });

  it('rejects an empty message with a 422', async () => {
    const res = await request(app).post('/api/support').send({ message: '   ' });

    expect(res.status).toBe(422);
    expect(mockSupportService.sendHelpRequest).not.toHaveBeenCalled();
  });

  it('rejects a missing message with a 422', async () => {
    const res = await request(app).post('/api/support').send({});

    expect(res.status).toBe(422);
  });

  it('rejects a message over the length limit with a 422', async () => {
    const res = await request(app).post('/api/support').send({ message: 'a'.repeat(4001) });

    expect(res.status).toBe(422);
    expect(mockSupportService.sendHelpRequest).not.toHaveBeenCalled();
  });
});
