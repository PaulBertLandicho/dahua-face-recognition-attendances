import { parseResponseJson, deleteDahuaAttendance } from './dahuaApi';

describe('Dahua API helpers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('parseResponseJson treats empty responses as empty objects', () => {
    expect(parseResponseJson('')).toEqual({});
    expect(parseResponseJson('   ')).toEqual({});
  });

  test('deleteDahuaAttendance does not crash when backend returns no JSON body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(''),
    });

    await expect(deleteDahuaAttendance('123', '2026-08-24T08:00:00.000Z')).resolves.toEqual({});
  });
});
