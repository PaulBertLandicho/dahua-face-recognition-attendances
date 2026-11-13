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

  test('attaches Bearer JWT header with credentials omit when sb-session has an access_token', async () => {
    localStorage.setItem(
      'sb-session',
      JSON.stringify({ access_token: 'jwt-header-test', user: { id: 'ADM-1', role: 'admin' } })
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue('{"accounts":[]}'),
    });

    const { getAdminAccounts } = await import('./dahuaApi');
    await getAdminAccounts();

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/accounts',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-header-test',
        }),
      }),
    );
    localStorage.removeItem('sb-session');
  });

  test('clears sb-session and dispatches sb-auth-expired when a Bearer-authenticated request returns 401', async () => {
    localStorage.setItem(
      'sb-session',
      JSON.stringify({ access_token: 'expired-jwt', user: { id: 'ADM-1', role: 'admin' } })
    );
    const expiredListener = jest.fn();
    window.addEventListener('sb-auth-expired', expiredListener);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: jest.fn().mockResolvedValue('{"error":{"message":"Session expired"}}'),
    });

    const { getAdminAccounts } = await import('./dahuaApi');
    await expect(getAdminAccounts()).rejects.toThrow('Session expired');
    expect(localStorage.getItem('sb-session')).toBeNull();
    expect(expiredListener).toHaveBeenCalledTimes(1);
    window.removeEventListener('sb-auth-expired', expiredListener);
  });
});

