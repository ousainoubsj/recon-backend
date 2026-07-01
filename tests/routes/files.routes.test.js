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

const mockGetSignedUrl = jest.fn();
jest.unstable_mockModule('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

const { filesRouter } = await import('../../routes/files.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/files', filesRouter);
app.use(errorHandler);

beforeEach(() => jest.clearAllMocks());

describe('POST /api/files/presign', () => {
  it('issues a presigned URL for an allowed content type under the size limit', async () => {
    mockGetSignedUrl.mockResolvedValue('https://r2.example.com/signed-put-url');

    const res = await request(app)
      .post('/api/files/presign')
      .send({ filename: 'transactions.csv', contentType: 'text/csv', size: 1024 });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://r2.example.com/signed-put-url');
    expect(res.body.key).toMatch(new RegExp(`^uploads/${USER_ID}/\\d+-transactions\\.csv$`));
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { expiresIn: 300 },
    );
  });

  it('rejects a file over 50 MB with a 413 RFC 7807 error', async () => {
    const res = await request(app)
      .post('/api/files/presign')
      .send({ filename: 'big.csv', contentType: 'text/csv', size: 51 * 1024 * 1024 });

    expect(res.status).toBe(413);
    expect(res.body.type).toBe('https://recon.app/errors/file-too-large');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects a disallowed content type with a 422 RFC 7807 error', async () => {
    const res = await request(app)
      .post('/api/files/presign')
      .send({ filename: 'doc.pdf', contentType: 'application/pdf', size: 1024 });

    expect(res.status).toBe(422);
    expect(res.body.type).toBe('https://recon.app/errors/validation-error');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
