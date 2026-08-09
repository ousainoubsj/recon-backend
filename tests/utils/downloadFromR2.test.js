import { jest } from '@jest/globals';

const mockSend = jest.fn();
jest.unstable_mockModule('../../utils/r2Client.js', () => ({
  r2: { send: mockSend },
}));

const { downloadFromR2 } = await import('../../utils/fileParser.js');

function fakeBody(chunks) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('downloadFromR2', () => {
  it('concatenates chunks into a single buffer', async () => {
    mockSend.mockResolvedValue({ Body: fakeBody([Buffer.from('ab'), Buffer.from('cd')]), ContentLength: 4 });

    const result = await downloadFromR2('key');

    expect(result.toString()).toBe('abcd');
  });

  it('reports cumulative bytes received and the total via onProgress', async () => {
    mockSend.mockResolvedValue({ Body: fakeBody([Buffer.from('ab'), Buffer.from('cd'), Buffer.from('e')]), ContentLength: 5 });
    const calls = [];

    await downloadFromR2('key', { onProgress: (bytes, total) => calls.push([bytes, total]) });

    expect(calls).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it('does not throw when onProgress is omitted', async () => {
    mockSend.mockResolvedValue({ Body: fakeBody([Buffer.from('a')]), ContentLength: 1 });

    await expect(downloadFromR2('key')).resolves.toBeInstanceOf(Buffer);
  });

  it('passes through an undefined total when the response omits ContentLength', async () => {
    mockSend.mockResolvedValue({ Body: fakeBody([Buffer.from('a')]) });
    const calls = [];

    await downloadFromR2('key', { onProgress: (bytes, total) => calls.push([bytes, total]) });

    expect(calls).toEqual([[1, undefined]]);
  });
});
