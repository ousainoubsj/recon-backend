import { jest } from '@jest/globals';

const mockSet = jest.fn().mockResolvedValue('OK');
const mockGet = jest.fn();
const mockDel = jest.fn().mockResolvedValue(1);
jest.unstable_mockModule('../../config/redis.config.js', () => ({
  redis: { set: mockSet, get: mockGet, del: mockDel },
}));

const { setSampleRows, getSampleRows, clearSampleRows } = await import('../../services/mappingSampleCache.js');

const REPORT_ID = 'report-1';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setSampleRows', () => {
  it('stores the rows as JSON under a report+side-scoped key with a TTL', async () => {
    await setSampleRows(REPORT_ID, 'A', [{ ref: 'R1' }]);

    expect(mockSet).toHaveBeenCalledWith('mapping-sample:report-1:A', JSON.stringify([{ ref: 'R1' }]), 'EX', 86400);
  });
});

describe('getSampleRows', () => {
  it('parses and returns the cached rows when present', async () => {
    mockGet.mockResolvedValue(JSON.stringify([{ ref: 'R1' }]));

    const rows = await getSampleRows(REPORT_ID, 'B');

    expect(mockGet).toHaveBeenCalledWith('mapping-sample:report-1:B');
    expect(rows).toEqual([{ ref: 'R1' }]);
  });

  it('returns null when nothing is cached (expired or never set)', async () => {
    mockGet.mockResolvedValue(null);

    const rows = await getSampleRows(REPORT_ID, 'A');

    expect(rows).toBeNull();
  });
});

describe('clearSampleRows', () => {
  it('deletes both sides in one call', async () => {
    await clearSampleRows(REPORT_ID);

    expect(mockDel).toHaveBeenCalledWith('mapping-sample:report-1:A', 'mapping-sample:report-1:B');
  });
});
