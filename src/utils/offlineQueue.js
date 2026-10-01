// Minimal IndexedDB helper for offline attendance queue, persons, and settings
import { toMinutes, determineAttendanceStatus } from "../AdminPage/attendanceUtils";
const DB_NAME = "multifactors_offline";
const DB_VERSION = 1;
const STORE_QUEUE = "queue";
const STORE_PERSONS = "persons";
const STORE_SETTINGS = "settings";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PERSONS)) {
        db.createObjectStore(STORE_PERSONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore(storeName, mode, cb) {
  return openDB().then((db) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = cb(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("IDB transaction error"));
    })
  );
}

export async function enqueueAttendance(item) {
  // item should include: person_id, name, department, event, point, device_time, status, method, photo
  // avoid duplicates in queue within 30s
  const DUP_MS = 30 * 1000;
  const items = await getAllQueue();
  const recentDup = items.find((q) =>
    q.person_id === item.person_id && q.event === item.event && Math.abs(new Date(q.device_time).getTime() - new Date(item.device_time).getTime()) < DUP_MS
  );
  if (recentDup) {
    return { queued: false, reason: "recent duplicate" };
  }

  // Try to avoid same-window duplicates (morning/afternoon) using cached settings
  try {
    const settings = await getSettings();
    if (settings) {
      const toMinutes = (hhmm) => {
        const parts = String(hhmm || "").split(":").map(Number);
        if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
        return parts[0] * 60 + parts[1];
      };

      const parseMinutesFromIso = (iso) => {
        try {
          const dt = new Date(iso);
          if (isNaN(dt.getTime())) return null;
          const hhmm = dt.toTimeString().slice(0,5);
          const [h,m] = hhmm.split(":").map(Number);
          return h * 60 + m;
        } catch (e) { return null; }
      };

      const morningEnd = toMinutes(settings.morning_end);
      const afternoonStart = toMinutes(settings.afternoon_start);
      const afternoonEnd = toMinutes(settings.afternoon_end);

      const itemMinutes = parseMinutesFromIso(item.device_time) || parseMinutesFromIso(new Date().toISOString());

      const inMorningWindow = (m) => m !== null && morningEnd !== null && m <= morningEnd;
      const inAfternoonWindow = (m) => m !== null && afternoonStart !== null && afternoonEnd !== null && m >= afternoonStart && m <= afternoonEnd;
      const inMorningTimeoutWindow = (m) => m !== null && morningEnd !== null && afternoonStart !== null && m > morningEnd && m < afternoonStart;

      const hasQueuedInWindow = (eventName, windowCheck) => {
        return items.some((q) => {
          if (!q || q.person_id !== item.person_id || q.event !== eventName || !q.device_time) return false;
          const qm = parseMinutesFromIso(q.device_time);
          return windowCheck(qm);
        });
      };

      if (item.event === "time-in") {
        if (inMorningWindow(itemMinutes) && hasQueuedInWindow("time-in", inMorningWindow)) {
          return { queued: false, reason: "duplicate_morning_time_in" };
        }
        if (inAfternoonWindow(itemMinutes) && hasQueuedInWindow("time-in", inAfternoonWindow)) {
          return { queued: false, reason: "duplicate_afternoon_time_in" };
        }
      }

      if (item.event === "time-out") {
        if (inMorningTimeoutWindow(itemMinutes) && hasQueuedInWindow("time-out", (m) => inMorningTimeoutWindow(m) || inMorningWindow(m))) {
          return { queued: false, reason: "duplicate_morning_time_out" };
        }
        if ((itemMinutes > afternoonEnd) || inAfternoonWindow(itemMinutes)) {
          if (hasQueuedInWindow("time-out", inAfternoonWindow)) {
            return { queued: false, reason: "duplicate_afternoon_time_out" };
          }
        }
      }
    }
  } catch (e) {
    // ignore settings parse errors and fall back to recent-duplicate only
  }

  const id = await withStore(STORE_QUEUE, "readwrite", (store) => store.add({ ...item, queuedAt: new Date().toISOString() }));
  try {
    // ask the service worker to perform a background sync when possible
    if (typeof requestBackgroundSync === 'function') {
      try { await requestBackgroundSync(); } catch (e) {}
    }
  } catch (e) {}
  return { queued: true, id };
}

export function getAllQueue() {
  return withStore(STORE_QUEUE, "readonly", (store) => {
    const req = store.getAll();
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  });
}

export function removeQueueItem(id) {
  return withStore(STORE_QUEUE, "readwrite", (store) => store.delete(id));
}

export function clearQueue() {
  return withStore(STORE_QUEUE, "readwrite", (store) => store.clear());
}

export function savePersons(persons) {
  return withStore(STORE_PERSONS, "readwrite", (store) => {
    // clear then add
    const clearReq = store.clear();
    clearReq.onsuccess = () => {
      for (const p of persons || []) {
        try { store.put(p); } catch (e) {}
      }
    };
    return undefined;
  });
}

export function getPersons() {
  return withStore(STORE_PERSONS, "readonly", (store) => {
    const req = store.getAll();
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  });
}

export function saveSettings(settings) {
  return withStore(STORE_SETTINGS, "readwrite", (store) => store.put({ key: "settings", value: settings }));
}

export function getSettings() {
  return withStore(STORE_SETTINGS, "readonly", (store) => {
    const req = store.get("settings");
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result ? req.result.value : null);
      req.onerror = () => rej(req.error);
    });
  });
}

// When offline, auto-generate morning `time-out` entries by inspecting cached
// persons and the current offline queue. For each person who has a morning
// `time-in` queued (or appears to need a morning `time-out`), enqueue a
// `time-out` at the configured `morning_end` time. Returns an array of
// results: { person_id, queued: true|false, reason?: string }
export async function enqueueAutoMorningOuts() {
  const results = [];
  try {
    const settings = await getSettings();
    if (!settings) return results;
    const persons = await getPersons();
    if (!Array.isArray(persons) || persons.length === 0) return results;

    const items = await getAllQueue();

    const parseMinutesFromIso = (iso) => {
      try {
        const dt = new Date(iso);
        if (isNaN(dt.getTime())) return null;
        const hhmm = dt.toTimeString().slice(0,5);
        const [h,m] = hhmm.split(":").map(Number);
        return h * 60 + m;
      } catch (e) { return null; }
    };

    const morningEnd = toMinutes(settings.morning_end);
    const morningStart = toMinutes(settings.morning_start);
    if (morningEnd === null || morningStart === null) return results;

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");

    for (const p of persons) {
      try {
        // Find any queued morning time-in for this person today
        const hasMorningInQueued = items.some((q) => {
          if (!q || q.person_id !== p.id || q.event !== "time-in" || !q.device_time) return false;
          const d = new Date(q.device_time);
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          if (String(y) !== String(year) || m !== month || dd !== day) return false;
          const minutes = parseMinutesFromIso(q.device_time);
          return minutes !== null && minutes <= morningEnd;
        });

        if (!hasMorningInQueued) {
          // nothing to do for this person
          continue;
        }

        // Ensure no morning time-out already queued for today
        const hasMorningOutQueued = items.some((q) => {
          if (!q || q.person_id !== p.id || q.event !== "time-out" || !q.device_time) return false;
          const d = new Date(q.device_time);
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          if (String(y) !== String(year) || m !== month || dd !== day) return false;
          const minutes = parseMinutesFromIso(q.device_time);
          return minutes !== null && minutes > morningStart && minutes <= morningEnd;
        });

        if (hasMorningOutQueued) {
          results.push({ person_id: p.id, queued: false, reason: 'morning_out_already_queued' });
          continue;
        }

        // Build device_time at today's morning_end in local timezone
        const [hStr, mStr] = (settings.morning_end || '11:59').split(':');
        const h = Number(hStr || 11);
        const mm = Number(mStr || 59);
        const outDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mm, 0, 0);
        const deviceTimeIso = outDate.toISOString();

        const status = determineAttendanceStatus(outDate.toTimeString().slice(0,5), 'time-out', settings, true);

        const enqueueRes = await enqueueAttendance({
          person_id: p.id,
          name: p.name,
          department: p.department,
          event: 'time-out',
          point: 'System auto-generated',
          method: 'auto-morning-out-offline',
          device_time: deviceTimeIso,
          status,
          photo: null,
        });

        if (enqueueRes && typeof enqueueRes === 'object' && enqueueRes.queued === false) {
          results.push({ person_id: p.id, queued: false, reason: enqueueRes.reason || 'blocked' });
        } else {
          results.push({ person_id: p.id, queued: true, device_time: deviceTimeIso });
        }
      } catch (e) {
        results.push({ person_id: p.id, queued: false, reason: String(e) });
      }
    }
  } catch (e) {
    // top-level failure
    return [{ error: String(e) }];
  }
  return results;
}

export async function syncQueue(supabase) {
  if (!supabase) throw new Error("Supabase client required for sync");
  const items = await getAllQueue();
  const results = [];

  // Try to read cached settings for windowed duplicate checks
  let cachedSettings = null;
  try {
    cachedSettings = await getSettings();
  } catch (e) { /* ignore */ }

  const toMinutes = (hhmm) => {
    if (!hhmm) return null;
    const parts = String(hhmm).split(":").map(Number);
    if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
    return parts[0] * 60 + parts[1];
  };

  const parseMinutesFromIso = (iso) => {
    try {
      const dt = new Date(iso);
      if (isNaN(dt.getTime())) return null;
      const hhmm = dt.toTimeString().slice(0,5);
      const [h,m] = hhmm.split(":").map(Number);
      return h * 60 + m;
    } catch (e) { return null; }
  };

  for (const it of items) {
    try {
      const payload = {
        person_id: it.person_id,
        name: it.name,
        department: it.department,
        event: it.event,
        point: it.point || null,
        method: it.method || "offline-queue",
        device_time: it.device_time,
        status: it.status,
        photo: it.photo || null,
      };

      // Server-side pre-checks: look for obvious duplicates on the server
      try {
        const d = new Date(it.device_time);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const dayStartIso = `${year}-${month}-${day}T00:00:00.000Z`;
        const dayEndIso = `${year}-${month}-${day}T23:59:59.999Z`;

        const { data: existing, error: readErr } = await supabase
          .from("attendance")
          .select("id,event,device_time")
          .eq("person_id", it.person_id)
          .gte("device_time", dayStartIso)
          .lte("device_time", dayEndIso);

        if (readErr) {
          // Can't evaluate duplicates — let insert attempt proceed
          console.warn("syncQueue: failed to read existing attendance for dup-check", readErr.message || readErr);
        } else if (Array.isArray(existing) && existing.length > 0) {
          // Recent duplicate within 30s is considered duplicate
          const DUP_MS = 30 * 1000;
          const hasRecent = existing.some((r) => Math.abs(new Date(r.device_time).getTime() - new Date(it.device_time).getTime()) < DUP_MS && r.event === it.event);
          if (hasRecent) {
            await removeQueueItem(it.id);
            const msg = "server_recent_duplicate";
            console.info(`syncQueue: dropping queued item ${it.id} — ${msg}`);
            results.push({ id: it.id, success: false, dropped: true, reason: msg });
            continue;
          }

          // If any same-day event of same type exists, drop it (same-day fallback)
          const hasSameEvent = existing.some((r) => r.event === it.event);
          if (hasSameEvent) {
            await removeQueueItem(it.id);
            const msg = "server_same_day_event";
            console.info(`syncQueue: dropping queued item ${it.id} — ${msg}`);
            results.push({ id: it.id, success: false, dropped: true, reason: msg });
            continue;
          }

          // If settings present, perform windowed checks similar to client logic
          try {
            if (cachedSettings) {
              const morningEnd = toMinutes(cachedSettings.morning_end);
              const afternoonStart = toMinutes(cachedSettings.afternoon_start);
              const afternoonEnd = toMinutes(cachedSettings.afternoon_end);
              const itemMinutes = parseMinutesFromIso(it.device_time) || parseMinutesFromIso(new Date().toISOString());

              const inMorningWindow = (m) => m !== null && morningEnd !== null && m <= morningEnd;
              const inAfternoonWindow = (m) => m !== null && afternoonStart !== null && afternoonEnd !== null && m >= afternoonStart && m <= afternoonEnd;
              const inMorningTimeoutWindow = (m) => m !== null && morningEnd !== null && afternoonStart !== null && m > morningEnd && m < afternoonStart;

              const existsInWindow = (eventName, windowCheck) => existing.some((r) => {
                if (!r || r.event !== eventName || !r.device_time) return false;
                const rm = parseMinutesFromIso(r.device_time);
                return windowCheck(rm);
              });

              if (it.event === "time-in") {
                if (inMorningWindow(itemMinutes) && existsInWindow("time-in", inMorningWindow)) {
                  await removeQueueItem(it.id);
                  const msg = "server_duplicate_morning_time_in";
                  console.info(`syncQueue: dropping queued item ${it.id} — ${msg}`);
                  results.push({ id: it.id, success: false, dropped: true, reason: msg });
                  continue;
                }
                if (inAfternoonWindow(itemMinutes) && existsInWindow("time-in", inAfternoonWindow)) {
                  await removeQueueItem(it.id);
                  const msg = "server_duplicate_afternoon_time_in";
                  console.info(`syncQueue: dropping queued item ${it.id} — ${msg}`);
                  results.push({ id: it.id, success: false, dropped: true, reason: msg });
                  continue;
                }
              }

              if (it.event === "time-out") {
                if (inMorningTimeoutWindow(itemMinutes) && existsInWindow("time-out", (m) => inMorningTimeoutWindow(m) || inMorningWindow(m))) {
                  await removeQueueItem(it.id);
                  const msg = "server_duplicate_morning_time_out";
                  console.info(`syncQueue: dropping queued item ${it.id} — ${msg}`);
                  results.push({ id: it.id, success: false, dropped: true, reason: msg });
                  continue;
                }
                if ((itemMinutes > (afternoonEnd || 0)) || inAfternoonWindow(itemMinutes)) {
                  if (existsInWindow("time-out", inAfternoonWindow)) {
                    await removeQueueItem(it.id);
                    const msg = "server_duplicate_afternoon_time_out";
                    console.info(`syncQueue: dropping queued item ${it.id} — ${msg}`);
                    results.push({ id: it.id, success: false, dropped: true, reason: msg });
                    continue;
                  }
                }
              }
            }
          } catch (e) {
            // ignore window check errors
          }
        }
      } catch (dupCheckErr) {
        console.warn("syncQueue: server duplicate-check failed, proceeding to insert:", dupCheckErr.message || dupCheckErr);
      }

      const { error } = await supabase.from("attendance").insert(payload);
      if (!error) {
        await removeQueueItem(it.id);
        results.push({ id: it.id, success: true });
      } else {
        // If server rejects due to duplicate/constraint, drop it
        if (error.message && /duplicate|constraint|unique/i.test(error.message)) {
          await removeQueueItem(it.id);
          results.push({ id: it.id, success: false, dropped: true, error: error.message });
        } else {
          results.push({ id: it.id, success: false, error: error.message });
        }
      }
    } catch (e) {
      results.push({ id: it.id, success: false, error: e.message || String(e) });
    }
  }
  return results;
}

// Helper to request background sync via service worker if available
export async function requestBackgroundSync() {
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
      const reg = await navigator.serviceWorker.ready;
      if (reg.sync) {
        try { await reg.sync.register('sync-offline-queue'); return { registered: true }; } catch (e) { return { registered: false, error: String(e) }; }
      }
    }
  } catch (e) {}
  return { registered: false };
}

const OFFLINE_QUEUE = {
  enqueueAttendance,
  getAllQueue,
  removeQueueItem,
  clearQueue,
  savePersons,
  getPersons,
  saveSettings,
  getSettings,
  syncQueue,
  // Enqueue auto-generated morning 'time-out' entries using cached persons/settings
  // This is intended for offline use: it scans cached queued attendance for today's
  // morning `time-in` events and enqueues corresponding `time-out` entries at
  // the configured `morning_end` time. It returns an array of result objects.
  enqueueAutoMorningOuts,
};

export default OFFLINE_QUEUE;
