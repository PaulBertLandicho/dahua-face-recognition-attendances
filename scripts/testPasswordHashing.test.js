const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const bcrypt = require("bcryptjs");

// In-memory mock store for `persons` table during route verification
const mockPersons = new Map();

function resetMockPersons(seedRows = []) {
  mockPersons.clear();
  for (const row of seedRows) {
    mockPersons.set(row.id, { ...row });
  }
}

function createMockConnection() {
  return {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      return mockQuery(sql, params);
    },
  };
}

async function mockQuery(sql, params = []) {
  const normalized = String(sql).replace(/\s+/g, " ").trim();

  // Ignore startup DDL/maintenance statements
  if (/^(CREATE TABLE|ALTER TABLE|SHOW COLUMNS|DELETE FROM dahua_pending_deletions|OPTIMIZE TABLE)/i.test(normalized)) {
    return [[]];
  }

  // Admin accounts list query
  if (/^SELECT id, name, email, role, department, phone_number, approved, created_at FROM persons/i.test(normalized)) {
    return [
      Array.from(mockPersons.values())
        .filter((p) => p.role === "admin" || (p.email && p.email !== "" && p.role === "admin"))
        .map(({ password, token_version, ...rest }) => rest),
    ];
  }

  // Active admin count query
  if (/^SELECT COUNT\(\*\) as count FROM persons WHERE role = 'admin'/i.test(normalized)) {
    const admins = Array.from(mockPersons.values()).filter(
      (p) => p.role === "admin" && p.approved !== 0 && p.approved !== false && !p.archived
    );
    return [[{ count: admins.length }]];
  }

  // Persons lookup by email
  if (/^SELECT \* FROM persons WHERE email = \?/i.test(normalized)) {
    const email = params[0];
    const match = Array.from(mockPersons.values()).find((p) => p.email === email);
    return [match ? [{ ...match }] : []];
  }

  // Persons lookup by id
  if (/^SELECT \* FROM persons WHERE id = \?/i.test(normalized)) {
    const id = params[0];
    const match = mockPersons.get(id);
    return [match ? [{ ...match }] : []];
  }

  // Duplicate email check
  if (/^SELECT id FROM persons WHERE email = \? AND id != \?/i.test(normalized)) {
    const [email, excludeId] = params;
    const match = Array.from(mockPersons.values()).find((p) => p.email === email && p.id !== excludeId);
    return [match ? [{ id: match.id }] : []];
  }

  if (/^SELECT id FROM persons WHERE email = \? LIMIT 1/i.test(normalized)) {
    const [email] = params;
    const match = Array.from(mockPersons.values()).find((p) => p.email === email);
    return [match ? [{ id: match.id }] : []];
  }

  // Generic /api/db/query SELECT `...` FROM `persons`
  if (/^SELECT .+ FROM `persons`/i.test(normalized)) {
    let rows = Array.from(mockPersons.values()).map((r) => ({ ...r }));
    if (/WHERE `id` = \?/i.test(normalized)) {
      rows = rows.filter((r) => r.id === params[0]);
    }
    return [rows];
  }

  // Generic /api/db/query INSERT INTO `persons`
  if (/^INSERT INTO `persons` \(([^)]+)\)/i.test(normalized)) {
    const colsMatch = normalized.match(/^INSERT INTO `persons` \(([^)]+)\)/i);
    const cols = colsMatch[1].split(",").map((c) => c.trim().replace(/`/g, ""));
    const record = { approved: 1, archived: 0, token_version: 1 };
    cols.forEach((c, idx) => {
      record[c] = params[idx];
    });
    const existing = mockPersons.get(record.id) || {};
    mockPersons.set(record.id, { ...existing, ...record });
    return [{ affectedRows: 1, insertId: 0 }];
  }

  // /api/admin/accounts INSERT INTO persons
  if (/^INSERT INTO persons \(id, name, email, password, role, department, phone_number, approved, token_version, created_at\)/i.test(normalized)) {
    const [id, name, email, password, role, department, phone_number] = params;
    mockPersons.set(id, { id, name, email, password, role, department, phone_number, approved: 1, archived: 0, token_version: 1 });
    return [{ affectedRows: 1 }];
  }

  // UPDATE persons SET password = ? WHERE id = ?
  if (/^UPDATE persons SET password = \? WHERE id = \?$/i.test(normalized)) {
    const [password, id] = params;
    const existing = mockPersons.get(id);
    if (existing) existing.password = password;
    return [{ affectedRows: existing ? 1 : 0 }];
  }

  // UPDATE persons SET password = ?, token_version = ? WHERE id = ?
  if (/^UPDATE persons SET password = \?, token_version = \? WHERE id = \?$/i.test(normalized)) {
    const [password, tv, id] = params;
    const existing = mockPersons.get(id);
    if (existing) {
      existing.password = password;
      existing.token_version = tv;
    }
    return [{ affectedRows: existing ? 1 : 0 }];
  }

  // UPDATE persons SET name = ?, email = ?, password = ?, token_version = ? WHERE id = ?
  if (/^UPDATE persons SET name = \?, email = \?, password = \?, token_version = \? WHERE id = \?$/i.test(normalized)) {
    const [name, email, password, tv, id] = params;
    const existing = mockPersons.get(id);
    if (existing) {
      existing.name = name;
      existing.email = email;
      existing.password = password;
      existing.token_version = tv;
    }
    return [{ affectedRows: existing ? 1 : 0 }];
  }

  // Dynamic UPDATE persons / `persons` SET ... WHERE ... = ?
  const updateMatch = normalized.match(/^UPDATE `?persons`? SET (.+?) WHERE `?id`? = \?$/i);
  if (updateMatch) {
    const setParts = updateMatch[1].split(",").map((p) => p.trim());
    const id = params[params.length - 1];
    const existing = mockPersons.get(id);
    if (existing) {
      let paramIdx = 0;
      for (const part of setParts) {
        const eqIdx = part.indexOf("=");
        if (eqIdx === -1) continue;
        const col = part.slice(0, eqIdx).trim().replace(/`/g, "");
        const expr = part.slice(eqIdx + 1).trim();
        if (expr === "?") {
          existing[col] = params[paramIdx++];
        } else if (/COALESCE\(token_version,\s*1\)\s*\+\s*1/i.test(expr)) {
          existing.token_version = Number(existing.token_version || 1) + 1;
        }
      }
    }
    return [{ affectedRows: existing ? 1 : 0 }];
  }

  // Migration script SELECT
  if (/^SELECT id, email, role, password FROM persons/i.test(normalized)) {
    return [
      Array.from(mockPersons.values())
        .filter((p) => p.password !== null && p.password !== undefined && p.password !== "")
        .map(({ id, email, role, password }) => ({ id, email, role, password })),
    ];
  }

  return [[]];
}

// Stub mysql2/promise before loading server.js so tests never require a live database
const mockPool = {
  query: mockQuery,
  getConnection: async () => createMockConnection(),
  end: async () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "mysql2/promise") {
    return {
      createPool: () => mockPool,
    };
  }
  return originalLoad.apply(this, arguments);
};

process.env.SKIP_SERVER_LISTEN = "1";
process.env.BCRYPT_SALT_ROUNDS = "10"; // Keep test suite fast while testing real bcrypt hashes
process.env.ALLOW_LEGACY_PLAINTEXT_UPGRADE = "true";

// Unref any top-level intervals registered by server.js during test loading
const origSetInterval = global.setInterval;
const serverTimers = [];
global.setInterval = (...args) => {
  const handle = origSetInterval(...args);
  if (handle && typeof handle.unref === "function") handle.unref();
  serverTimers.push(handle);
  return handle;
};

const serverModule = require("../server");
const { migratePlaintextPasswords } = require("./hashExistingPasswords");

global.setInterval = origSetInterval;
Module._load = originalLoad;

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  for (const t of serverTimers) clearInterval(t);
  if (server) {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

async function apiJson(route, method, body, token = null) {
  const headers = { "Content-Type": "application/json", Connection: "close" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function seedAdminAndLogin() {
  const rootHash = await bcrypt.hash("RootAdmin!2026", 10);
  mockPersons.set("ROOT-ADM", {
    id: "ROOT-ADM",
    name: "Root Admin",
    email: "rootadmin@company.com",
    password: rootHash,
    role: "admin",
    department: "Admin",
    approved: 1,
    archived: 0,
    token_version: 1,
  });
  serverModule.clearAuthUserCache();
  const loginRes = await apiJson("/api/auth/login", "POST", {
    email: "rootadmin@company.com",
    password: "RootAdmin!2026",
  });
  assert.equal(loginRes.status, 200);
  return loginRes.json.data.session.access_token;
}

test("password helpers validate length/bytes, reject empty DB passwords, and verify hashes", async () => {
  assert.equal(serverModule.validatePasswordStrength("short"), "Password must be at least 8 characters long.");
  assert.equal(serverModule.validatePasswordStrength("        "), "Password must be at least 8 characters long.");
  assert.equal(serverModule.validatePasswordStrength("a".repeat(73)), "Password must not exceed 72 bytes.");
  assert.equal(serverModule.validatePasswordStrength("ValidPass123!"), null);

  const hash = await serverModule.hashPassword("ValidPass123!");
  assert.equal(serverModule.isBcryptHash(hash), true);
  assert.equal(serverModule.isBcryptHash("plaintext"), false);

  // Null/empty stored password must never bypass authentication
  assert.deepEqual(await serverModule.verifyUserPassword("anything123", null), { valid: false, needsRehash: false });
  assert.deepEqual(await serverModule.verifyUserPassword("anything123", ""), { valid: false, needsRehash: false });

  // Matching bcrypt hash passes without rehash
  assert.deepEqual(await serverModule.verifyUserPassword("ValidPass123!", hash), { valid: true, needsRehash: false });
  assert.deepEqual(await serverModule.verifyUserPassword("WrongPass123!", hash), { valid: false, needsRehash: false });
});

test("POST /api/admin/accounts hashes passwords and /api/auth/login verifies against hash & blocks empty DB passwords", async () => {
  resetMockPersons([
    { id: "EMP-NOPASS", name: "No Password", email: "nopass@company.com", password: null, role: "employee", department: "Ops", approved: 1, archived: 0, token_version: 1 },
  ]);
  const adminToken = await seedAdminAndLogin();

  // Unauthenticated account creation must return 401
  const unauthRes = await apiJson("/api/admin/accounts", "POST", {
    name: "Unauth Admin",
    email: "unauth@company.com",
    role: "admin",
    password: "ValidPassword!2026",
  });
  assert.equal(unauthRes.status, 401);

  // Weak password rejected
  const weakRes = await apiJson("/api/admin/accounts", "POST", {
    name: "Admin One",
    email: "admin1@company.com",
    role: "admin",
    password: "123",
  }, adminToken);
  assert.equal(weakRes.status, 400);

  // Valid password stored as bcrypt hash
  const createRes = await apiJson("/api/admin/accounts", "POST", {
    name: "Admin One",
    email: "admin1@company.com",
    role: "admin",
    password: "AdminSecret!2026",
  }, adminToken);
  assert.equal(createRes.status, 200);
  const createdId = createRes.json.account.id;
  const storedRecord = mockPersons.get(createdId);
  assert.ok(storedRecord);
  assert.notEqual(storedRecord.password, "AdminSecret!2026");
  assert.equal(serverModule.isBcryptHash(storedRecord.password), true);

  // Valid login succeeds and issues HS256 JWT
  const loginOk = await apiJson("/api/auth/login", "POST", {
    email: "admin1@company.com",
    password: "AdminSecret!2026",
  });
  assert.equal(loginOk.status, 200);
  assert.equal(loginOk.json.data.user.email, "admin1@company.com");
  assert.equal(loginOk.json.data.user.password, undefined);
  assert.ok(loginOk.json.data.session.access_token);

  // Wrong password rejected
  const loginWrong = await apiJson("/api/auth/login", "POST", {
    email: "admin1@company.com",
    password: "WrongPassword!2026",
  });
  assert.equal(loginWrong.status, 401);

  // Null/empty stored password must fail login (fixes legacy bypass)
  const loginNoPass = await apiJson("/api/auth/login", "POST", {
    email: "nopass@company.com",
    password: "any-password",
  });
  assert.equal(loginNoPass.status, 401);
});

test("POST /api/auth/login transparently upgrades legacy plaintext password to bcrypt on first login", async () => {
  resetMockPersons([
    { id: "LEGACY-1", name: "Legacy Admin", email: "legacyadmin@company.com", password: "oldPlaintextPassword", role: "admin", department: "Admin", approved: 1, archived: 0, token_version: 1 },
  ]);
  serverModule.clearAuthUserCache();

  const res = await apiJson("/api/auth/login", "POST", {
    email: "legacyadmin@company.com",
    password: "oldPlaintextPassword",
  });
  assert.equal(res.status, 200);

  const upgraded = mockPersons.get("LEGACY-1");
  assert.notEqual(upgraded.password, "oldPlaintextPassword");
  assert.equal(serverModule.isBcryptHash(upgraded.password), true);
  assert.equal(await bcrypt.compare("oldPlaintextPassword", upgraded.password), true);
});

test("POST /api/auth/change-password and /api/auth/update-profile require valid JWT, currentPassword, and hash newPassword", async () => {
  const initialHash = await bcrypt.hash("OldSecret!123", 10);
  resetMockPersons([
    { id: "ADM-1", name: "Admin User", email: "admin@company.com", password: initialHash, role: "admin", department: "Admin", approved: 1, archived: 0, token_version: 1 },
    { id: "ADM-2", name: "Other Admin", email: "other@company.com", password: initialHash, role: "admin", department: "Admin", approved: 1, archived: 0, token_version: 1 },
  ]);
  serverModule.clearAuthUserCache();

  // Unauthenticated calls must be rejected with 401
  const unauthChange = await apiJson("/api/auth/change-password", "POST", {
    userId: "ADM-1",
    currentPassword: "OldSecret!123",
    newPassword: "NewSecret!456",
  });
  assert.equal(unauthChange.status, 401);

  const loginRes = await apiJson("/api/auth/login", "POST", {
    email: "admin@company.com",
    password: "OldSecret!123",
  });
  assert.equal(loginRes.status, 200);
  const token1 = loginRes.json.data.session.access_token;

  // Attempting to modify another account's password via userId spoof must return 403
  const crossUser = await apiJson("/api/auth/change-password", "POST", {
    userId: "ADM-2",
    currentPassword: "OldSecret!123",
    newPassword: "NewSecret!456",
  }, token1);
  assert.equal(crossUser.status, 403);

  // Omitting currentPassword must be rejected
  const missingCurrent = await apiJson("/api/auth/change-password", "POST", {
    userId: "ADM-1",
    newPassword: "NewSecret!456",
  }, token1);
  assert.equal(missingCurrent.status, 400);

  // Correct currentPassword updates password and rotates session token cleanly
  const changeOk = await apiJson("/api/auth/change-password", "POST", {
    userId: "ADM-1",
    currentPassword: "OldSecret!123",
    newPassword: "ChangedPass!789",
  }, token1);
  assert.equal(changeOk.status, 200);
  assert.ok(changeOk.json.access_token);
  assert.equal(serverModule.isBcryptHash(mockPersons.get("ADM-1").password), true);
  assert.equal(await bcrypt.compare("ChangedPass!789", mockPersons.get("ADM-1").password), true);

  // Previous JWT token1 must now be revoked due to token_version bump
  const staleCheck = await apiJson("/api/auth/session", "GET", undefined, token1);
  assert.equal(staleCheck.status, 401);
  const token2 = changeOk.json.access_token;

  // Wrong currentPassword in update-profile must be rejected
  const wrongCurrentProfile = await apiJson("/api/auth/update-profile", "POST", {
    userId: "ADM-1",
    newName: "Admin Renamed",
    currentPassword: "WrongCurrent!999",
    newPassword: "NewSecret!456",
  }, token2);
  assert.equal(wrongCurrentProfile.status, 400);

  // Correct currentPassword updates and hashes new password (preserving trailing space without trimming mismatch)
  const updateOk = await apiJson("/api/auth/update-profile", "POST", {
    userId: "ADM-1",
    newName: "Admin Renamed",
    currentPassword: "ChangedPass!789",
    newPassword: "NewSecret!456 ",
  }, token2);
  assert.equal(updateOk.status, 200);
  assert.equal(mockPersons.get("ADM-1").name, "Admin Renamed");
  assert.equal(serverModule.isBcryptHash(mockPersons.get("ADM-1").password), true);
  assert.equal(await bcrypt.compare("NewSecret!456 ", mockPersons.get("ADM-1").password), true);

  // Old password no longer logs in; new password works
  const oldLogin = await apiJson("/api/auth/login", "POST", { email: "admin@company.com", password: "OldSecret!123" });
  assert.equal(oldLogin.status, 401);
  const newLogin = await apiJson("/api/auth/login", "POST", { email: "admin@company.com", password: "NewSecret!456 " });
  assert.equal(newLogin.status, 200);
});

test("PUT /api/admin/accounts/:id keeps hash on blank password, rejects weak password, and hashes valid update", async () => {
  const initialHash = await bcrypt.hash("InitialPass!2026", 10);
  resetMockPersons([
    { id: "SEC-1", name: "Sec Admin", email: "sec@company.com", password: initialHash, role: "admin", department: "Admin", approved: 1, archived: 0, token_version: 1 },
  ]);
  const adminToken = await seedAdminAndLogin();

  // Blank password leaves existing hash intact
  const keepRes = await apiJson("/api/admin/accounts/SEC-1", "PUT", { name: "Sec Updated", password: "" }, adminToken);
  assert.equal(keepRes.status, 200);
  assert.equal(mockPersons.get("SEC-1").password, initialHash);

  // Short non-empty password rejected
  const weakPut = await apiJson("/api/admin/accounts/SEC-1", "PUT", { password: "123" }, adminToken);
  assert.equal(weakPut.status, 400);
  assert.equal(mockPersons.get("SEC-1").password, initialHash);

  // Valid password re-hashed
  const strongPut = await apiJson("/api/admin/accounts/SEC-1", "PUT", { password: "RotatedPass!2026" }, adminToken);
  assert.equal(strongPut.status, 200);
  assert.notEqual(mockPersons.get("SEC-1").password, initialHash);
  assert.equal(await bcrypt.compare("RotatedPass!2026", mockPersons.get("SEC-1").password), true);
});

test("POST /api/db/query requires admin auth for persons mutations, hashes persons.password, and strips password from responses", async () => {
  resetMockPersons([]);

  // Unauthenticated insert into persons must fail with 401
  const unauthInsert = await apiJson("/api/db/query", "POST", {
    action: "insert",
    table: "persons",
    payload: { id: "EMP-UNAUTH", name: "Bad", email: "bad@company.com", password: "PlainInsert!2026", role: "admin" },
  });
  assert.equal(unauthInsert.status, 401);

  const adminToken = await seedAdminAndLogin();

  const insertRes = await apiJson("/api/db/query", "POST", {
    action: "insert",
    table: "persons",
    payload: { id: "EMP-100", name: "Test User", email: "emp100@company.com", password: "PlainInsert!2026", role: "admin" },
    single: true,
  }, adminToken);
  assert.equal(insertRes.status, 200);
  assert.equal(insertRes.json.data.password, undefined);
  assert.equal(serverModule.isBcryptHash(mockPersons.get("EMP-100").password), true);
  assert.equal(await bcrypt.compare("PlainInsert!2026", mockPersons.get("EMP-100").password), true);

  const selectRes = await apiJson("/api/db/query", "POST", {
    action: "select",
    table: "persons",
    filters: [{ column: "id", op: "eq", value: "EMP-100" }],
  }, adminToken);
  assert.equal(selectRes.status, 200);
  assert.equal(selectRes.json.data.length, 1);
  assert.equal(selectRes.json.data[0].password, undefined);

  const updateRes = await apiJson("/api/db/query", "POST", {
    action: "update",
    table: "persons",
    payload: { password: "PlainUpdate!2026" },
    filters: [{ column: "id", op: "eq", value: "EMP-100" }],
  }, adminToken);
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.json.data.password, undefined);
  assert.equal(await bcrypt.compare("PlainUpdate!2026", mockPersons.get("EMP-100").password), true);

  const upsertWeakRes = await apiJson("/api/db/query", "POST", {
    action: "upsert",
    table: "persons",
    payload: { id: "EMP-100", password: "123" },
  }, adminToken);
  assert.equal(upsertWeakRes.status, 400);

  const upsertOkRes = await apiJson("/api/db/query", "POST", {
    action: "upsert",
    table: "persons",
    payload: { id: "EMP-100", password: "PlainUpsert!2026" },
  }, adminToken);
  assert.equal(upsertOkRes.status, 200);
  assert.equal(upsertOkRes.json.data.password, undefined);
  assert.equal(await bcrypt.compare("PlainUpsert!2026", mockPersons.get("EMP-100").password), true);
});

test("scripts/hashExistingPasswords migrates only unhashed rows idempotently", async () => {
  const preHashed = await bcrypt.hash("AlreadySafe!123", 10);
  resetMockPersons([
    { id: "A-1", email: "a1@company.com", role: "admin", password: "plaintextAdminPassword" },
    { id: "A-2", email: "a2@company.com", role: "admin", password: preHashed },
    { id: "E-1", email: "e1@company.com", role: "employee", password: null },
  ]);

  const silentLogger = { log() {} };

  const drySummary = await migratePlaintextPasswords(mockPool, { apply: false, logger: silentLogger });
  assert.deepEqual(drySummary, { totalWithPassword: 2, alreadyHashed: 1, pendingHash: 1, hashedNow: 0 });
  assert.equal(mockPersons.get("A-1").password, "plaintextAdminPassword");

  const applySummary = await migratePlaintextPasswords(mockPool, { apply: true, logger: silentLogger });
  assert.deepEqual(applySummary, { totalWithPassword: 2, alreadyHashed: 1, pendingHash: 1, hashedNow: 1 });
  assert.equal(serverModule.isBcryptHash(mockPersons.get("A-1").password), true);
  assert.equal(await bcrypt.compare("plaintextAdminPassword", mockPersons.get("A-1").password), true);
  assert.equal(mockPersons.get("A-2").password, preHashed);

  const secondPass = await migratePlaintextPasswords(mockPool, { apply: true, logger: silentLogger });
  assert.deepEqual(secondPass, { totalWithPassword: 2, alreadyHashed: 2, pendingHash: 0, hashedNow: 0 });
});
