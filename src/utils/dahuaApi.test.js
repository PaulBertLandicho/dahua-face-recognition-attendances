import {
  parseResponseJson,
  deleteDahuaAttendance,
  syncDahuaAttendance,
} from './dahuaApi';

describe('Dahua API helpers', () => {
  const originalFetch = global.fetch;
  const originalBackendUrl = process.env.REACT_APP_BACKEND_URL;
  const originalConnectorUrl = process.env.REACT_APP_DAHUA_CONNECTOR_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalBackendUrl === undefined) {
      delete process.env.REACT_APP_BACKEND_URL;
    } else {
      process.env.REACT_APP_BACKEND_URL = originalBackendUrl;
    }
    if (originalConnectorUrl === undefined) {
      delete process.env.REACT_APP_DAHUA_CONNECTOR_URL;
    } else {
      process.env.REACT_APP_DAHUA_CONNECTOR_URL = originalConnectorUrl;
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
      '/api/dahua/sync-attendance',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('sync users uses the configured Dahua connector first', async () => {
    process.env.REACT_APP_DAHUA_CONNECTOR_URL = 'http://localhost:4000/';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue('{"count":1}'),
    });

    const { syncDahuaUsers } = await import('./dahuaApi');
    await syncDahuaUsers();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:4000/api/dahua/sync-users',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('sync errors preserve the configured backend response', async () => {
    process.env.REACT_APP_BACKEND_URL = 'https://attendance.example.com';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: jest.fn().mockResolvedValue('{"error":"Dahua device is unreachable from cPanel."}'),
    });

    const { syncDahuaUsers } = await import('./dahuaApi');
    await expect(syncDahuaUsers()).rejects.toThrow('Dahua device is unreachable from cPanel.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
