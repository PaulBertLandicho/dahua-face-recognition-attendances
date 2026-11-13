/**
 * Comprehensive server-side security, RBAC, fail-closed secrets, and face/offline verification tests.
 * Run with: node --test scripts/testServerVerification.test.js
 */
process.env.SKIP_SERVER_LISTEN = "1";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const Module = require("node:module");
const bcrypt = require("bcryptjs");

// Normalized 128-d helper vectors for deterministic Euclidean distance testing
function makeUnitVector(dim0, dim1 = 0, dim2 = 0) {
  const vec = new Array(128).fill(0);
  vec[0] = dim0;
  vec[1] = dim1;
  vec[2] = dim2;
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// Create a vector whose normalized Euclidean distance from e0=[1,0,...] is exact `d` (for 0 <= d < 2)
function makeVectorAtDistanceFromE0(targetDist, orthogonalDim = 1) {
  // For unit vectors a = [1, 0, ...] and b = [cos(t), sin(t), ...]:
  // ||a - b||^2 = 2 - 2*cos(t) = targetDist^2  =>  cos(t) = 1 - targetDist^2 / 2
  const cosT = 1 - (targetDist * targetDist) / 2;
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const vec = new Array(128).fill(0);
  vec[0] = cosT;
  vec[orthogonalDim] = sinT;
  return vec;
}

// In-memory mock MySQL store + query interpreter
const db = {
  persons: [],
  attendance: [],
  settings: [],
  holidays: [],
  department_rates: [],
  expenses: [],
  payroll_periods: [],
  payroll_activity_logs: [],
  payroll_released_history: [],
  cash_advances: [],
  face_token_uses: [],
  dahua_pending_deletions: [],
  dahua_device_status: [],
};

let nextAutoId = 100;
function getNextId() {
  nextAutoId += 1;
  return nextAutoId;
}

function resetDb() {
  db.persons.length = 0;
  db.attendance.length = 0;
  db.settings.length = 0;
  db.holidays.length = 0;
  db.department_rates.length = 0;
  db.expenses.length = 0;
  db.payroll_periods.length = 0;
  db.payroll_activity_logs.length = 0;
  db.payroll_released_history.length = 0;
  db.cash_advances.length = 0;
  db.face_token_uses.length = 0;
  db.dahua_pending_deletions.length = 0;
  db.dahua_device_status.length = 0;
  nextAutoId = 100;

  db.settings.push({
    id: 1,
    morning_start: "08:00:00",
    morning_end: "12:00:00",
    afternoon_start: "13:00:00",
    afternoon_end: "17:00:00",
    morning_grace_minutes: 5,
    afternoon_grace_minutes: 5,
    late_count_limit: 4,
    payroll_period_days: 15,
    company_name: "Test Corp",
  });
}

function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let current = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && str[i - 1] !== "\\") {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (!inSingle) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitTopLevelAnd(str) {
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let current = "";
  const upper = str.toUpperCase();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && str[i - 1] !== "\\") {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (!inSingle) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && upper.slice(i, i + 5) === " AND ") {
        parts.push(current.trim());
        current = "";
        i += 4;
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function countQuestionMarks(str) {
  let count = 0;
  let inSingle = false;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "'" && str[i - 1] !== "\\") inSingle = !inSingle;
    else if (!inSingle && str[i] === "?") count += 1;
  }
  return count;
}

function likeMatch(val, pattern) {
  if (val === null || val === undefined) return false;
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "is").test(String(val));
}

function normalizeCmpVal(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function evaluateCondition(row, condStr, paramsCursor) {
  let expr = condStr.trim();
  while (expr.startsWith("(") && expr.endsWith(")")) {
    // Check if outer parens wrap the whole expression
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < expr.length - 1; i++) {
      if (expr[i] === "(") depth += 1;
      else if (expr[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          wrapsAll = false;
          break;
        }
      }
    }
    if (wrapsAll) expr = expr.slice(1, -1).trim();
    else break;
  }

  // Handle top-level OR inside expression (e.g., archived = 0 OR archived IS NULL)
  const upper = expr.toUpperCase();
  let depth = 0;
  let inSingle = false;
  const orParts = [];
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'" && expr[i - 1] !== "\\") inSingle = !inSingle;
    else if (!inSingle) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && upper.slice(i, i + 4) === " OR ") {
        orParts.push(expr.slice(start, i).trim());
        start = i + 4;
        i += 3;
      }
    }
  }
  if (orParts.length > 0) {
    orParts.push(expr.slice(start).trim());
    // Note: each branch might consume `?` even if an earlier branch returned true; keep cursor exact
    const branchResults = orParts.map((part) => evaluateAndGroup(row, part, paramsCursor));
    return branchResults.some(Boolean);
  }

  return evaluateAtom(row, expr, paramsCursor);
}

function evaluateAndGroup(row, groupStr, paramsCursor) {
  const parts = splitTopLevelAnd(groupStr);
  let allTrue = true;
  for (const part of parts) {
    const ok = evaluateCondition(row, part, paramsCursor);
    if (!ok) allTrue = false;
  }
  return allTrue;
}

function parseSqlLiteral(tok) {
  const t = tok.trim();
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.toUpperCase() === "NULL") return null;
  if (t.toUpperCase() === "TRUE") return 1;
  if (t.toUpperCase() === "FALSE") return 0;
  return t;
}

function evaluateAtom(row, expr, paramsCursor) {
  if (expr === "1=0") return false;
  if (expr === "1=1") return true;

  let m = expr.match(/^`?([a-zA-Z0-9_]+)`?\s+IS\s+NOT\s+NULL$/i);
  if (m) return row[m[1]] !== null && row[m[1]] !== undefined;

  m = expr.match(/^`?([a-zA-Z0-9_]+)`?\s+IS\s+NULL$/i);
  if (m) return row[m[1]] === null || row[m[1]] === undefined;

  m = expr.match(/^`?([a-zA-Z0-9_]+)`?\s+IS\s+TRUE$/i);
  if (m) return row[m[1]] === true || row[m[1]] === 1;

  m = expr.match(/^`?([a-zA-Z0-9_]+)`?\s+IS\s+FALSE$/i);
  if (m) return row[m[1]] === false || row[m[1]] === 0;

  m = expr.match(/^`?([a-zA-Z0-9_]+)`?\s+IN\s*\((.+)\)$/is);
  if (m) {
    const col = m[1];
    const items = splitTopLevelCommas(m[2]).map((item) =>
      item === "?" ? paramsCursor.next() : parseSqlLiteral(item)
    );
    return items.some((v) => normalizeCmpVal(row[col]) == normalizeCmpVal(v));
  }

  m = expr.match(/^`?([a-zA-Z0-9_]+)`?\s+LIKE\s+(\?|'[^']*')$/i);
  if (m) {
    const val = m[2] === "?" ? paramsCursor.next() : parseSqlLiteral(m[2]);
    return likeMatch(row[m[1]], val);
  }

  m = expr.match(/^`?([a-zA-Z0-9_]+)`?\s*(=|!=|<>|>=|<=|>|<)\s*(\?|'[^']*'|-?\d+(?:\.\d+)?)$/i);
  if (m) {
    const col = m[1];
    const op = m[2];
    const rhs = m[3] === "?" ? paramsCursor.next() : parseSqlLiteral(m[3]);
    const lhs = row[col];
    if (lhs === null || lhs === undefined) return op === "!=" || op === "<>" ? rhs !== null : false;
    const a = normalizeCmpVal(lhs);
    const b = normalizeCmpVal(rhs);
    if (op === "=") return String(a) === String(b);
    if (op === "!=" || op === "<>") return String(a) !== String(b);
    if (op === ">") return a > b;
    if (op === ">=") return a >= b;
    if (op === "<") return a < b;
    if (op === "<=") return a <= b;
  }

  // Fallback: consume any remaining `?` in unknown expression so subsequent clauses stay aligned
  const qCount = countQuestionMarks(expr);
  for (let i = 0; i < qCount; i++) paramsCursor.next();
  return true;
}

function makeParamsCursor(params, startIdx = 0) {
  let idx = startIdx;
  return {
    next() {
      const v = params[idx];
      idx += 1;
      return v;
    },
    get index() {
      return idx;
    },
  };
}

function filterRows(rows, whereClause, params, startIdx = 0) {
  if (!whereClause) return [...rows];
  return rows.filter((row) => {
    const cursor = makeParamsCursor(params, startIdx);
    return evaluateAndGroup(row, whereClause, cursor);
  });
}

function normalizeTableName(raw) {
  return String(raw || "").replace(/`/g, "").trim();
}

const mockPool = {
  async query(sql, params = []) {
    const trimmed = String(sql || "").trim();
    const upper = trimmed.toUpperCase();

    // Ignore startup DDL & maintenance optimize/cleanup
    if (
      upper.startsWith("CREATE TABLE") ||
      upper.startsWith("ALTER TABLE") ||
      upper.startsWith("SHOW COLUMNS") ||
      upper.startsWith("OPTIMIZE TABLE")
    ) {
      return [[], []];
    }

    // SELECT
    if (upper.startsWith("SELECT ")) {
      const match = trimmed.match(
        /^SELECT\s+([\s\S]+?)\s+FROM\s+`?([a-zA-Z0-9_]+)`?(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\d+))?(?:\s+OFFSET\s+(\d+))?$/i
      );
      if (!match) return [[], []];
      const [, selectExpr, rawTable, whereClause, orderClause, limitStr, offsetStr] = match;
      const table = normalizeTableName(rawTable);
      const sourceRows = db[table] || [];
      let rows = filterRows(sourceRows, whereClause, params, 0);

      // Aggregate COUNT(*)
      const countMatch = selectExpr.trim().match(/^COUNT\(\*\)\s+AS\s+([a-zA-Z0-9_]+)$/i);
      if (countMatch) {
        const alias = countMatch[1];
        return [[{ [alias]: rows.length }], []];
      }

      if (orderClause) {
        const orderSpecs = splitTopLevelCommas(orderClause).map((part) => {
          const [colRaw, dirRaw] = part.trim().split(/\s+/);
          return {
            col: colRaw.replace(/`/g, ""),
            desc: String(dirRaw || "").toUpperCase() === "DESC",
          };
        });
        rows.sort((a, b) => {
          for (const spec of orderSpecs) {
            const va = a[spec.col] ?? "";
            const vb = b[spec.col] ?? "";
            if (va < vb) return spec.desc ? 1 : -1;
            if (va > vb) return spec.desc ? -1 : 1;
          }
          return 0;
        });
      }

      if (offsetStr !== undefined) {
        rows = rows.slice(Number(offsetStr));
      }
      if (limitStr !== undefined) {
        rows = rows.slice(0, Number(limitStr));
      }

      if (selectExpr.trim() === "*") {
        return [rows.map((r) => ({ ...r })), []];
      }

      const cols = splitTopLevelCommas(selectExpr).map((c) => c.replace(/`/g, "").trim());
      const projected = rows.map((r) => {
        const out = {};
        for (const col of cols) {
          out[col] = r[col] !== undefined ? r[col] : null;
        }
        return out;
      });
      return [projected, []];
    }

    // INSERT / INSERT IGNORE / UPSERT
    if (upper.startsWith("INSERT ")) {
      const m = trimmed.match(
        /^INSERT\s+(?:IGNORE\s+)?INTO\s+`?([a-zA-Z0-9_]+)`?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(?:\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\s+[\s\S]+)?$/i
      );
      if (!m) return [{ affectedRows: 0, insertId: 0 }, []];
      const isIgnore = /^INSERT\s+IGNORE\s+/i.test(trimmed);
      const isUpsert = /ON\s+DUPLICATE\s+KEY\s+UPDATE/i.test(trimmed);
      const table = normalizeTableName(m[1]);
      const cols = splitTopLevelCommas(m[2]).map((c) => c.replace(/`/g, "").trim());
      const valueTokens = splitTopLevelCommas(m[3]);

      const cursor = makeParamsCursor(params, 0);
      const row = {};
      cols.forEach((col, i) => {
        const tok = (valueTokens[i] || "?").trim();
        row[col] = tok === "?" ? cursor.next() : parseSqlLiteral(tok);
      });

      const target = db[table] || (db[table] = []);

      // Enforce face_token_uses unique (jti, target_person_id)
      if (table === "face_token_uses") {
        const dup = target.find(
          (r) => String(r.jti) === String(row.jti) && String(r.target_person_id) === String(row.target_person_id)
        );
        if (dup) {
          const err = new Error("Duplicate entry for unique key uniq_face_token_target");
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          throw err;
        }
      }

      // Enforce attendance unique slot conflict (person_id, attendance_work_date, attendance_slot)
      if (table === "attendance" && row.person_id && row.attendance_work_date && row.attendance_slot) {
        const dup = target.find(
          (r) =>
            String(r.person_id) === String(row.person_id) &&
            String(r.attendance_work_date || "") === String(row.attendance_work_date) &&
            String(r.attendance_slot || "") === String(row.attendance_slot)
        );
        if (dup) {
          const err = new Error("Duplicate entry for key 'uniq_person_work_slot'");
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          throw err;
        }
      }

      if (row.id !== undefined && row.id !== null) {
        const existingIdx = target.findIndex((r) => String(r.id) === String(row.id));
        if (existingIdx >= 0) {
          if (isIgnore) return [{ affectedRows: 0, insertId: 0 }, []];
          if (isUpsert) {
            target[existingIdx] = { ...target[existingIdx], ...row };
            return [{ affectedRows: 1, insertId: row.id }, []];
          }
          const err = new Error("Duplicate primary key");
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          throw err;
        }
      }

      const assignedId = row.id !== undefined ? row.id : getNextId();
      const inserted = { id: assignedId, ...row };
      if (table === "persons") {
        if (inserted.token_version === undefined) inserted.token_version = 1;
        if (inserted.approved === undefined) inserted.approved = 1;
        if (inserted.archived === undefined) inserted.archived = 0;
      }
      target.push(inserted);
      return [{ affectedRows: 1, insertId: assignedId }, []];
    }

    // UPDATE
    if (upper.startsWith("UPDATE ")) {
      const m = trimmed.match(/^UPDATE\s+`?([a-zA-Z0-9_]+)`?\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
      if (!m) return [{ affectedRows: 0 }, []];
      const [, rawTable, setClause, whereClause] = m;
      const table = normalizeTableName(rawTable);
      const target = db[table] || [];

      const assignments = splitTopLevelCommas(setClause);
      let paramIdx = 0;
      const parsedAssigns = assignments.map((part) => {
        const eqPos = part.indexOf("=");
        const col = part.slice(0, eqPos).replace(/`/g, "").trim();
        const rhs = part.slice(eqPos + 1).trim();
        if (rhs === "?") {
          const val = params[paramIdx];
          paramIdx += 1;
          return { col, kind: "value", val };
        }
        const qCount = countQuestionMarks(rhs);
        paramIdx += qCount;
        return { col, kind: "expr", rhs };
      });

      const matching = filterRows(target, whereClause, params, paramIdx);
      for (const row of matching) {
        for (const a of parsedAssigns) {
          if (a.kind === "value") {
            row[a.col] = a.val;
          } else if (/COALESCE\(\s*token_version\s*,\s*1\s*\)\s*\+\s*1/i.test(a.rhs)) {
            row[a.col] = Number(row.token_version || 1) + 1;
          } else if (/photo\s*=\s*NULL/i.test(`${a.col}=${a.rhs}`)) {
            row[a.col] = null;
          }
        }
      }
      return [{ affectedRows: matching.length }, []];
    }

    // DELETE
    if (upper.startsWith("DELETE ")) {
      const m = trimmed.match(/^DELETE\s+FROM\s+`?([a-zA-Z0-9_]+)`?(?:\s+WHERE\s+([\s\S]+))?$/i);
      if (!m) return [{ affectedRows: 0 }, []];
      const [, rawTable, whereClause] = m;
      const table = normalizeTableName(rawTable);
      if (table === "face_token_uses" && whereClause && /expires_at/i.test(whereClause)) {
        return [{ affectedRows: 0 }, []];
      }
      const target = db[table] || [];
      if (!whereClause) {
        const count = target.length;
        target.length = 0;
        return [{ affectedRows: count }, []];
      }
      const remaining = [];
      let deletedCount = 0;
      for (const row of target) {
        const cursor = makeParamsCursor(params, 0);
        if (evaluateAndGroup(row, whereClause, cursor)) {
          deletedCount += 1;
        } else {
          remaining.push(row);
        }
      }
      db[table] = remaining;
      return [{ affectedRows: deletedCount }, []];
    }

    return [[], []];
  },
  async getConnection() {
    return {
      query: mockPool.query,
      release() {},
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "mysql2/promise") {
    return {
      createPool: () => mockPool,
    };
  }
  return originalLoad.apply(this, arguments);
};

// Clear cached server exports just in case
delete require.cache[require.resolve("../server.js")];

const origSetInterval = global.setInterval;
const serverTimers = [];
global.setInterval = (...args) => {
  const handle = origSetInterval(...args);
  if (handle && typeof handle.unref === "function") handle.unref();
  serverTimers.push(handle);
  return handle;
};

const {
  app,
  signStaffJwt,
  verifyStaffJwtToken,
  signFaceToken,
  verifyFaceToken,
  clearAuthUserCache,
  clearEligiblePersonsCache,
  faceTokenUsesMemory,
} = require("../server.js");

global.setInterval = origSetInterval;
Module._load = originalLoad;

// Snapshot original environment variables touched by tests
const ORIG_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  AUTH_TOKEN_SECRET: process.env.AUTH_TOKEN_SECRET,
  FACE_TOKEN_SECRET: process.env.FACE_TOKEN_SECRET,
  SYNC_SERVICE_TOKEN: process.env.SYNC_SERVICE_TOKEN,
  ATTENDANCE_IMPORT_TOKEN: process.env.ATTENDANCE_IMPORT_TOKEN,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let server;
let baseUrl;

async function requestJson(method, path, { headers = {}, body } = {}) {
  const reqHeaders = {
    "Content-Type": "application/json",
    Connection: "close",
    ...headers,
  };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (e) {
    json = { _raw: raw };
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: json,
  };
}

function seedPerson({
  id,
  name,
  email,
  password = "Password123!",
  role = "employee",
  department = "Operations",
  approved = 1,
  archived = 0,
  token_version = 1,
  daily_rate = 950,
  sss_number = "12-3456789-0",
  descriptor = null,
}) {
  const hash = password ? bcrypt.hashSync(password, 4) : null;
  const row = {
    id,
    name,
    email,
    password: hash,
    role,
    department,
    approved,
    archived,
    token_version,
    daily_rate,
    hourly_rate: Number((daily_rate / 8).toFixed(2)),
    late_penalty: 0,
    sss_number,
    pagibig_number: "9999-1111",
    philhealth_number: "8888-2222",
    phone: "09171234567",
    descriptor: descriptor ? JSON.stringify(descriptor) : null,
  };
  db.persons.push(row);
  return row;
}

async function loginAndGetToken(email, password = "Password123!") {
  const res = await requestJson("POST", "/api/auth/login", { body: { email, password } });
  assert.equal(res.status, 200, `Expected login 200 for ${email}, got ${res.status}: ${JSON.stringify(res.body)}`);
  const token = res.body?.data?.session?.access_token || res.body?.session?.access_token || res.body?.access_token;
  assert.ok(token, `Expected access_token in login response: ${JSON.stringify(res.body)}`);
  return token;
}

function formatLocalTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

describe("Server-Side Verification, Fail-Closed Secrets, RBAC & Face/Offline Sync", () => {
  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    for (const t of serverTimers) clearInterval(t);
    restoreEnv();
    http.globalAgent.destroy();
    if (server) {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    resetDb();
    clearAuthUserCache();
    clearEligiblePersonsCache();
    faceTokenUsesMemory.clear();
    process.env.NODE_ENV = "test";
    process.env.AUTH_TOKEN_SECRET = "unit-test-auth-secret-please-keep-long";
    process.env.FACE_TOKEN_SECRET = "unit-test-face-secret-please-keep-long";
    delete process.env.SYNC_SERVICE_TOKEN;
    delete process.env.ATTENDANCE_IMPORT_TOKEN;
  });

  afterEach(() => {
    restoreEnv();
  });

  it("fails closed (503) in NODE_ENV=production when AUTH_TOKEN_SECRET or FACE_TOKEN_SECRET are missing", async () => {
    const faceVec = makeVectorAtDistanceFromE0(0.0);
    seedPerson({ id: "P1", name: "Admin One", email: "admin@test.local", role: "admin", descriptor: faceVec });

    process.env.NODE_ENV = "production";
    delete process.env.AUTH_TOKEN_SECRET;
    delete process.env.FACE_TOKEN_SECRET;

    const loginRes = await requestJson("POST", "/api/auth/login", {
      body: { email: "admin@test.local", password: "Password123!" },
    });
    assert.equal(loginRes.status, 503);

    const verifyRes = await requestJson("POST", "/api/face/verify", {
      body: { descriptor: faceVec },
    });
    assert.equal(verifyRes.status, 503);

    assert.throws(() => signStaffJwt({ id: "P1", role: "admin", token_version: 1 }), /AUTH_TOKEN_SECRET/);
    assert.throws(() => signFaceToken({ pid: "P1", jti: "jti-1", exp: Date.now() + 60000 }), /FACE_TOKEN_SECRET/);

    // Verify fails with 503 status when secret is missing
    process.env.AUTH_TOKEN_SECRET = "temp-secret";
    const tempJwt = signStaffJwt({ id: "P1", role: "admin", token_version: 1 });
    delete process.env.AUTH_TOKEN_SECRET;
    const sessionRes = await requestJson("GET", "/api/auth/session", {
      headers: { Authorization: `Bearer ${tempJwt}` },
    });
    assert.equal(sessionRes.status, 503);
  });

  it("enforces staff JWT validation, X-Auth-Token fallback, tampering rejection, expiration, logout & account-update revocation, and active role checks", async () => {
    seedPerson({ id: "A1", name: "Super Admin", email: "admin@test.local", role: "admin" });
    seedPerson({ id: "A2", name: "Archived Admin", email: "oldadmin@test.local", role: "admin", archived: 1 });
    seedPerson({ id: "S1", name: "Former Sec", email: "sec@test.local", role: "secretary" });
    seedPerson({ id: "E1", name: "Regular Worker", email: "worker@test.local", role: "employee" });
    seedPerson({ id: "A3", name: "Second Admin", email: "admin2@test.local", role: "admin" });

    // Non-staff / unapproved / archived / secretary login blocked
    assert.equal((await requestJson("POST", "/api/auth/login", { body: { email: "worker@test.local", password: "Password123!" } })).status, 403);
    assert.equal((await requestJson("POST", "/api/auth/login", { body: { email: "sec@test.local", password: "Password123!" } })).status, 403);
    assert.equal((await requestJson("POST", "/api/auth/login", { body: { email: "oldadmin@test.local", password: "Password123!" } })).status, 403);

    const adminToken = await loginAndGetToken("admin@test.local");
    const admin2Token = await loginAndGetToken("admin2@test.local");

    // Both Bearer and X-Auth-Token work for /api/auth/session
    const sBearer = await requestJson("GET", "/api/auth/session", { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(sBearer.status, 200);
    assert.equal(sBearer.body.data.user.role, "admin");
    assert.equal(sBearer.body.data.user.password, undefined);

    const sFallback = await requestJson("GET", "/api/auth/session", { headers: { "X-Auth-Token": adminToken } });
    assert.equal(sFallback.status, 200);
    assert.equal(sFallback.body.data.user.id, "A1");

    // Tampered token rejected
    const parts = adminToken.split(".");
    const tampered = `${parts[0]}.${parts[1]}.tampered_signature_xyz`;
    assert.equal((await requestJson("GET", "/api/auth/session", { headers: { Authorization: `Bearer ${tampered}` } })).status, 401);

    // Expired JWT rejected (mint HS256 JWT with past exp using AUTH_TOKEN_SECRET)
    const expHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const expNow = Math.floor(Date.now() / 1000);
    const expPayload = Buffer.from(JSON.stringify({
      typ: "staff",
      sub: "A1",
      email: "admin@test.local",
      name: "Admin",
      role: "admin",
      tv: 1,
      jti: crypto.randomUUID(),
      iat: expNow - 120,
      exp: expNow - 60,
    })).toString("base64url");
    const expSigningInput = `${expHeader}.${expPayload}`;
    const expSig = crypto
      .createHmac("sha256", process.env.AUTH_TOKEN_SECRET)
      .update(expSigningInput)
      .digest("base64url");
    const expiredJwt = `${expSigningInput}.${expSig}`;
    const verifiedExpired = verifyStaffJwtToken(expiredJwt);
    assert.equal(verifiedExpired.valid, false);
    assert.equal(verifiedExpired.status, 401);
    assert.equal((await requestJson("GET", "/api/auth/session", { headers: { Authorization: `Bearer ${expiredJwt}` } })).status, 401);

    // PUT /api/admin/accounts/:id increments target user's token_version on role/approval/password change & revokes existing token
    const updateRes = await requestJson("PUT", "/api/admin/accounts/A3", {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { approved: 0 },
    });
    assert.equal(updateRes.status, 200);
    assert.equal((await requestJson("GET", "/api/auth/session", { headers: { Authorization: `Bearer ${admin2Token}` } })).status, 403);

    // POST /api/auth/logout bumps own token_version & revokes adminToken immediately
    const logoutRes = await requestJson("POST", "/api/auth/logout", { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(logoutRes.status, 200);
    assert.equal((await requestJson("GET", "/api/auth/session", { headers: { Authorization: `Bearer ${adminToken}` } })).status, 401);
  });

  it("enforces route RBAC across anonymous, non-admin, admin, and fail-closed service sync tokens", async () => {
    seedPerson({ id: "A1", name: "Admin", email: "admin@test.local", role: "admin" });

    const adminToken = await loginAndGetToken("admin@test.local");

    // 1. Anonymous gets 401 on protected routes
    for (const [method, path, body] of [
      ["GET", "/api/auth/session"],
      ["GET", "/api/admin/accounts"],
      ["GET", "/api/device/status"],
      ["GET", "/api/maintenance/storage-stats"],
      ["POST", "/api/payroll/rebuild", {}],
      ["POST", "/api/attendance/import", { records: [] }],
      ["GET", "/api/dahua/pending-deletions"],
      ["DELETE", "/api/dahua/attendance", { personId: "E1", deviceTime: "2026-11-12 08:00:00" }],
    ]) {
      const r = await requestJson(method, path, { body });
      assert.equal(r.status, 401, `Expected 401 for anonymous ${method} ${path}, got ${r.status}`);
    }

    // 2. Rejecting secretary account creation (admin-only)
    const createSecRes = await requestJson("POST", "/api/admin/accounts", {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { name: "Test Sec", email: "testsec@test.local", role: "secretary", password: "Password123!" },
    });
    assert.equal(createSecRes.status, 400);
    assert.match(createSecRes.body.error.message, /only 'admin' role is permitted/i);

    // 3. Admin allowed on admin-only & operational attendance delete & service-capable routes
    const adminDeleteAttendance = await requestJson("DELETE", "/api/dahua/attendance", {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { personId: "E1", deviceTime: "2026-11-12 08:00:00" },
    });
    assert.equal(adminDeleteAttendance.status, 200);

    assert.equal((await requestJson("GET", "/api/admin/accounts", { headers: { Authorization: `Bearer ${adminToken}` } })).status, 200);
    assert.equal((await requestJson("GET", "/api/maintenance/storage-stats", { headers: { Authorization: `Bearer ${adminToken}` } })).status, 200);
    assert.equal((await requestJson("POST", "/api/maintenance/optimize-tables", { headers: { Authorization: `Bearer ${adminToken}` }, body: {} })).status, 200);
    assert.equal((await requestJson("GET", "/api/dahua/pending-deletions", { headers: { Authorization: `Bearer ${adminToken}` } })).status, 200);

    // 4. Service token endpoints fail closed when SYNC_SERVICE_TOKEN is unset, reject wrong tokens, accept matching X-Sync-Token
    const badServiceNoEnv = await requestJson("POST", "/api/attendance/import", {
      headers: { "X-Sync-Token": "some-token" },
      body: { records: [] },
    });
    assert.equal(badServiceNoEnv.status, 401);

    process.env.SYNC_SERVICE_TOKEN = "bridge-secret-xyz-123";
    const badServiceWrongToken = await requestJson("POST", "/api/attendance/import", {
      headers: { "X-Sync-Token": "wrong-token" },
      body: { records: [] },
    });
    assert.equal(badServiceWrongToken.status, 401);

    const goodServiceToken = await requestJson("POST", "/api/attendance/import", {
      headers: { "X-Sync-Token": "bridge-secret-xyz-123" },
      body: { records: [] },
    });
    assert.equal(goodServiceToken.status, 200);
  });

  it("hardens /api/db/query against unauthenticated access, bad columns/ops, empty deletes/updates, and non-admin mutations", async () => {
    seedPerson({ id: "A1", name: "Admin", email: "admin@test.local", role: "admin" });
    seedPerson({ id: "E1", name: "Employee PII", email: "emp@test.local", role: "employee", daily_rate: 1200, sss_number: "99-8888777-6" });

    db.holidays.push({ id: 1, department: null, date: "2026-11-12", type: "Regular", description: "National Day" });
    db.attendance.push({
      id: 1,
      person_id: "E1",
      name: "Employee PII",
      event: "time-in",
      device_time: formatLocalTimestamp(new Date()),
      attendance_work_date: formatLocalTimestamp(new Date()).slice(0, 10),
      attendance_slot: "morning_time_in",
      notes: "Normal",
    });

    const adminToken = await loginAndGetToken("admin@test.local");

    // Anonymous blocked on persons, settings, payroll tables
    assert.equal((await requestJson("POST", "/api/db/query", { body: { action: "select", table: "persons" } })).status, 401);
    assert.equal((await requestJson("POST", "/api/db/query", { body: { action: "select", table: "settings" } })).status, 401);
    assert.equal((await requestJson("POST", "/api/db/query", { body: { action: "select", table: "payroll_periods" } })).status, 401);

    // Invalid table / column / op / empty-filter update & delete
    assert.equal((await requestJson("POST", "/api/db/query", { headers: { Authorization: `Bearer ${adminToken}` }, body: { action: "select", table: "users_secret" } })).status, 400);
    assert.equal((await requestJson("POST", "/api/db/query", { headers: { Authorization: `Bearer ${adminToken}` }, body: { action: "select", table: "persons", select: "nonexistent_col" } })).status, 400);
    assert.equal((await requestJson("POST", "/api/db/query", { headers: { Authorization: `Bearer ${adminToken}` }, body: { action: "select", table: "persons", filters: [{ column: "id", op: "regex", value: ".*" }] } })).status, 400);
    assert.equal((await requestJson("POST", "/api/db/query", { headers: { Authorization: `Bearer ${adminToken}` }, body: { action: "update", table: "holidays", payload: { description: "Oops" }, filters: [] } })).status, 400);
    assert.equal((await requestJson("POST", "/api/db/query", { headers: { Authorization: `Bearer ${adminToken}` }, body: { action: "delete", table: "holidays", filters: [] } })).status, 400);

    // Admin cannot query password or token_version, and SELECT * strips both
    assert.equal((await requestJson("POST", "/api/db/query", { headers: { Authorization: `Bearer ${adminToken}` }, body: { action: "select", table: "persons", select: "id,password" } })).status, 403);
    assert.equal((await requestJson("POST", "/api/db/query", { headers: { Authorization: `Bearer ${adminToken}` }, body: { action: "select", table: "persons", select: "id,token_version" } })).status, 403);
    const adminStarRes = await requestJson("POST", "/api/db/query", {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { action: "select", table: "persons", select: "*" },
    });
    assert.equal(adminStarRes.status, 200);
    assert.equal(adminStarRes.body.data[0].password, undefined);
    assert.equal(adminStarRes.body.data[0].token_version, undefined);

    // Attempting to write role: 'secretary' via /api/db/query fails with validation error
    const secRoleWrite = await requestJson("POST", "/api/db/query", {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { action: "update", table: "persons", payload: { role: "secretary" }, filters: [{ column: "id", op: "eq", value: "E1" }] },
    });
    assert.equal(secRoleWrite.status, 400);
    assert.match(secRoleWrite.body.error.message, /allowed roles: admin, employee/i);

    const adminNullHolidays = await requestJson("POST", "/api/db/query", {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { action: "select", table: "holidays", filters: [{ column: "department", op: "is", value: null }] },
    });
    assert.equal(adminNullHolidays.status, 200);
    assert.equal(adminNullHolidays.body.data.length, 1);

    const adminSettingsRes = await requestJson("POST", "/api/db/query", {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { action: "select", table: "settings" },
    });
    assert.equal(adminSettingsRes.status, 200);

    const adminAttendanceUpdate = await requestJson("POST", "/api/db/query", {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        action: "update",
        table: "attendance",
        payload: { notes: "Reviewed by Admin" },
        filters: [{ column: "id", op: "eq", value: 1 }],
      },
    });
    assert.equal(adminAttendanceUpdate.status, 200);
    assert.equal(db.attendance[0].notes, "Reviewed by Admin");
  });

  it("supports passwordless /scan flow: non-PII scan-context, 0.38 face threshold, replay lock, 20 partner limit, method & drift checks, and offline quarantine", async () => {
    const vecE1 = makeVectorAtDistanceFromE0(0.0);
    const vecPartner = makeVectorAtDistanceFromE0(1.2, 2); // Orthogonal / distinct face
    seedPerson({ id: "E1", name: "Alice Scanner", email: "alice@test.local", role: "employee", descriptor: vecE1 });
    seedPerson({ id: "E2", name: "Bob Partner", email: "bob@test.local", role: "employee", descriptor: vecPartner });
    seedPerson({ id: "E3", name: "Archived Person", email: "arch@test.local", role: "employee", archived: 1, descriptor: makeVectorAtDistanceFromE0(1.5, 3) });

    // Seed extra partner persons up to 22 for testing MAX_PARTNER_PUNCHES_PER_TOKEN (= 20)
    for (let i = 1; i <= 21; i++) {
      seedPerson({ id: `P${i}`, name: `Partner ${i}`, email: `p${i}@test.local`, role: "employee" });
    }

    // 1. /api/face/scan-context returns non-PII active directory + settings
    const ctxRes = await requestJson("GET", "/api/face/scan-context");
    assert.equal(ctxRes.status, 200);
    assert.equal(ctxRes.body.success, true);
    assert.ok(ctxRes.body.settings);
    assert.ok(!ctxRes.body.persons.some((p) => p.id === "E3"), "Archived person must not be in scan-context");
    const aliceCtx = ctxRes.body.persons.find((p) => p.id === "E1");
    assert.ok(aliceCtx);
    assert.equal(aliceCtx.email, undefined);
    assert.equal(aliceCtx.password, undefined);
    assert.equal(aliceCtx.descriptor, undefined);
    assert.equal(aliceCtx.daily_rate, undefined);

    // 2. /api/face/verify matches at distance 0.35 (inside 0.38 threshold, beyond old 0.32 threshold)
    const probeDist035 = makeVectorAtDistanceFromE0(0.35, 1);
    const verifyRes = await requestJson("POST", "/api/face/verify", {
      body: { descriptor: probeDist035 },
    });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.body.matched, true);
    assert.equal(verifyRes.body.person.id, "E1");
    assert.ok(verifyRes.body.distance > 0.32 && verifyRes.body.distance <= 0.38);
    assert.ok(verifyRes.body.token);

    const faceToken = verifyRes.body.token;
    const tokenInfo = verifyFaceToken(faceToken);
    assert.equal(tokenInfo.valid, true);

    // 3. Unscoped /scan attendance select is rejected (403); scoped with X-Face-Token is allowed (200)
    const unscopedSelect = await requestJson("POST", "/api/db/query", {
      headers: { "X-Face-Token": faceToken },
      body: { action: "select", table: "attendance" },
    });
    assert.equal(unscopedSelect.status, 403);

    const scopedSelect = await requestJson("POST", "/api/db/query", {
      headers: { "X-Face-Token": faceToken },
      body: { action: "select", table: "attendance", filters: [{ column: "person_id", op: "eq", value: "E1" }] },
    });
    assert.equal(scopedSelect.status, 200);

    // 4. Rejects disallowed method ('admin-entry') & excessive clock drift (> 15m)
    const nowStr = formatLocalTimestamp(new Date());
    const badMethodRes = await requestJson("POST", "/api/db/query", {
      headers: { "X-Face-Token": faceToken },
      body: {
        action: "insert",
        table: "attendance",
        payload: {
          person_id: "E1",
          name: "Alice Scanner",
          event: "time-in",
          method: "admin-entry",
          device_time: nowStr,
          attendance_work_date: nowStr.slice(0, 10),
          attendance_slot: "morning_time_in",
          verification_token: faceToken,
        },
      },
    });
    assert.equal(badMethodRes.status, 403);

    const oldDrift = formatLocalTimestamp(new Date(Date.now() - 25 * 60 * 1000));
    const badDriftRes = await requestJson("POST", "/api/db/query", {
      headers: { "X-Face-Token": faceToken },
      body: {
        action: "insert",
        table: "attendance",
        payload: {
          person_id: "E1",
          name: "Alice Scanner",
          event: "time-in",
          method: "face-scan",
          device_time: oldDrift,
          attendance_work_date: oldDrift.slice(0, 10),
          attendance_slot: "morning_time_in",
          verification_token: faceToken,
        },
      },
    });
    assert.equal(badDriftRes.status, 400);

    // 5. Valid live punch stamps authoritative Verified by:, strips inline & pipe-separated forged markers, and preserves legitimate note text
    const validPunch = await requestJson("POST", "/api/db/query", {
      headers: { "X-Face-Token": faceToken },
      body: {
        action: "insert",
        table: "attendance",
        payload: {
          person_id: "E1",
          name: "Alice Scanner",
          event: "time-in",
          method: "face-scan",
          device_time: nowStr,
          attendance_work_date: nowStr.slice(0, 10),
          attendance_slot: "morning_time_in",
          notes: "GPS ok. Verified by: Fake Admin (999) [face-verified] | [offline-unverified]",
          verification_token: faceToken,
        },
      },
    });
    assert.equal(validPunch.status, 200);
    assert.equal(db.attendance.length, 1);
    assert.match(db.attendance[0].notes, /^Verified by: Alice Scanner \(ID E1\)/);
    assert.ok(db.attendance[0].notes.includes("GPS ok."));
    assert.ok(!db.attendance[0].notes.includes("Fake Admin"));
    assert.ok(!db.attendance[0].notes.includes("[face-verified]"));
    assert.ok(!db.attendance[0].notes.includes("[offline-unverified]"));

    // 6. Replay with the same (jti, target_person_id = "E1") is blocked (409)
    const replaySamePerson = await requestJson("POST", "/api/db/query", {
      headers: { "X-Face-Token": faceToken },
      body: {
        action: "insert",
        table: "attendance",
        payload: {
          person_id: "E1",
          name: "Alice Scanner",
          event: "time-out",
          method: "face-scan",
          device_time: nowStr,
          attendance_work_date: nowStr.slice(0, 10),
          attendance_slot: "morning_time_out",
          verification_token: faceToken,
        },
      },
    });
    assert.equal(replaySamePerson.status, 409);

    // 7. Partner punches work up to 20 total uses per faceToken, then 21st is blocked (429)
    // Used 1 of 20 so far (E1); use 19 more partner IDs (P1..P19) -> 20 total
    for (let i = 1; i <= 19; i++) {
      const partnerPunch = await requestJson("POST", "/api/db/query", {
        headers: { "X-Face-Token": faceToken },
        body: {
          action: "insert",
          table: "attendance",
          payload: {
            person_id: `P${i}`,
            name: `Partner ${i}`,
            event: "time-in",
            method: "field-site",
            device_time: nowStr,
            attendance_work_date: nowStr.slice(0, 10),
            attendance_slot: "morning_time_in",
            verification_token: faceToken,
          },
        },
      });
      assert.equal(partnerPunch.status, 200, `Partner punch ${i} should succeed`);
    }
    // 21st target (P20) exceeds MAX_PARTNER_PUNCHES_PER_TOKEN = 20
    const partner21 = await requestJson("POST", "/api/db/query", {
      headers: { "X-Face-Token": faceToken },
      body: {
        action: "insert",
        table: "attendance",
        payload: {
          person_id: "P20",
          name: "Partner 20",
          event: "time-in",
          method: "field-site",
          device_time: nowStr,
          attendance_work_date: nowStr.slice(0, 10),
          attendance_slot: "morning_time_in",
          verification_token: faceToken,
        },
      },
    });
    assert.equal(partner21.status, 429);

    // 8. POST /api/face/offline-sync quarantines unauthenticated items, ignores client method spoofing, & enforces photo/timestamp/duplicate guards
    const offlineSyncRes = await requestJson("POST", "/api/face/offline-sync", {
      body: {
        items: [
          {
            id: "q-valid",
            person_id: "E2",
            name: "Bob Partner",
            event: "time-in",
            method: "admin-entry",
            device_time: nowStr,
            attendance_work_date: nowStr.slice(0, 10),
            attendance_slot: "morning_time_in",
            photo: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
            notes: "Offline GPS. Verified by: Spoofed | [OFFLINE-UNVERIFIED - Fake]",
          },
          {
            id: "q-no-photo",
            person_id: "P21",
            name: "Partner 21",
            event: "time-in",
            method: "face-scan",
            device_time: nowStr,
            attendance_work_date: nowStr.slice(0, 10),
            attendance_slot: "morning_time_in",
          },
          {
            id: "q-bad-ts",
            person_id: "P21",
            name: "Partner 21",
            event: "time-in",
            method: "face-scan",
            device_time: "not-a-valid-timestamp",
            attendance_work_date: nowStr.slice(0, 10),
            attendance_slot: "morning_time_in",
            photo: "data:image/jpeg;base64,/9j/4AAQ",
          },
          {
            id: "q-dup-slot",
            person_id: "E2",
            name: "Bob Partner",
            event: "time-in",
            method: "face-scan",
            device_time: nowStr,
            attendance_work_date: nowStr.slice(0, 10),
            attendance_slot: "morning_time_in",
            photo: "data:image/jpeg;base64,/9j/4AAQ",
          },
        ],
      },
    });
    assert.equal(offlineSyncRes.status, 200);
    assert.equal(offlineSyncRes.body.synced, 1);
    const byId = Object.fromEntries(offlineSyncRes.body.results.map((r) => [r.id, r]));
    assert.equal(byId["q-valid"].status, "synced");
    assert.equal(byId["q-valid"].unverified, true);
    assert.equal(byId["q-no-photo"].status, "rejected");
    assert.equal(byId["q-no-photo"].reason, "photo_proof_required");
    assert.equal(byId["q-bad-ts"].status, "rejected");
    assert.equal(byId["q-dup-slot"].status, "dropped_duplicate");

    const bobOfflineRow = db.attendance.find((r) => r.person_id === "E2");
    assert.ok(bobOfflineRow);
    assert.equal(bobOfflineRow.method, "field-site");
    assert.ok(bobOfflineRow.notes.includes("[OFFLINE-UNVERIFIED - Pending Review]"));
    assert.ok(bobOfflineRow.notes.includes("Offline GPS."));
    assert.ok(!bobOfflineRow.notes.includes("Spoofed"));
    assert.ok(!bobOfflineRow.notes.includes("Fake"));
  });
});
