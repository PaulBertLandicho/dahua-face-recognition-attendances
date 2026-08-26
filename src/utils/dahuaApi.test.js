import {
  parseResponseJson,
  deleteDahuaAttendance,
  syncDahuaAttendance,
} from './dahuaApi';

describe('Dahua API helpers', () => {
  const originalFetch = global.fetch;
  const originalBackendUrl = process.env.REACT_APP_BACKEND_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalBackendUrl === undefined) {
      delete process.env.REACT_APP_BACKEND_URL;
    } else {
      process.env.REACT_APP_BACKEND_URL = originalBackendUrl;
    }
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

  test('sync attendance uses the production backend when no URL is configured', async () => {
    delete process.env.REACT_APP_BACKEND_URL;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue('{"count":0}'),
    });

    await syncDahuaAttendance();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://dahua-face-recognition-attendances.onrender.com/api/dahua/sync-attendance',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
