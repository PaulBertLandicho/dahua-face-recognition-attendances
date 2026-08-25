export function isTimeBetween(current, start, end) {
  const now = current.split(":").map(Number);
  const startTime = start.split(":").map(Number);
  const endTime = end.split(":").map(Number);
  const nowMinutes = now[0] * 60 + now[1];
  const startMinutes = startTime[0] * 60 + startTime[1];
  const endMinutes = endTime[0] * 60 + endTime[1];
  return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}

export function toMinutes(currentTime) {
  const [hours, minutes] = currentTime.split(":").map(Number);
  return hours * 60 + minutes;
}

export function determineExpectedEvent(currentTime, lastEvent, settings, lastEventDeviceTimeIso = null) {
  if (!settings) return "time-in";

  const nowMinutes = toMinutes(currentTime);
  const morningStartMinutes = toMinutes(settings.morning_start);
  const morningEndMinutes = toMinutes(settings.morning_end);
  const afternoonStartMinutes = toMinutes(settings.afternoon_start);
  const afternoonEndMinutes = toMinutes(settings.afternoon_end);

  // Morning shift: time-in
  if (nowMinutes >= morningStartMinutes && nowMinutes <= morningEndMinutes) {
    if (!lastEvent || lastEvent === "time-out") return "time-in";
    if (lastEvent === "time-in") return "already-timed-in";
    return "attendance-closed";
  }
  // Morning shift: time-out after morning window
  if (nowMinutes > morningEndMinutes && nowMinutes < afternoonStartMinutes) {
    // Allow time-out even if there was no prior morning time-in,
    // but prevent multiple time-outs in the same window.
    if (!lastEvent) return "time-out";
    if (lastEvent === "time-in") return "time-out";
    if (lastEvent === "time-out") return "attendance-closed";
    return "attendance-closed";
  }
  if (nowMinutes <= morningEndMinutes && lastEvent === "time-in") {
    return "attendance-closed";
  }

  // Afternoon shift: time-in
  if (
    nowMinutes >= afternoonStartMinutes &&
    nowMinutes <= afternoonEndMinutes
  ) {
    // If the most recent event was a morning time-in (i.e. the last time-in occurred
    // during the morning window), allow recording a morning time-out even if the
    // current clock is already in the afternoon. This avoids blocking a legitimate
    // morning "time-out" when the user scans later in the day.
    try {
      if (
        lastEvent === "time-in" &&
        lastEventDeviceTimeIso &&
        typeof lastEventDeviceTimeIso === "string"
      ) {
        const dt = new Date(lastEventDeviceTimeIso);
        if (!isNaN(dt.getTime())) {
          const hhmm = dt.toTimeString().slice(0, 5);
          const lastMinutes = toMinutes(hhmm);
          if (lastMinutes >= morningStartMinutes && lastMinutes <= morningEndMinutes) {
            return "time-out";
          }
        }
      }
    } catch (e) {
      // If any parsing fails, fall back to normal behavior below.
      console.warn("determineExpectedEvent: failed to evaluate lastEventDeviceTimeIso", e);
    }

    // Allow afternoon time-in regardless of previous morning events (including missing morning-out).
    // We'll rely on a short duplicate-window check elsewhere to avoid near-duplicate inserts.
    return "time-in";
  }
  // Afternoon shift: time-out after afternoon window
  if (nowMinutes > afternoonEndMinutes) {
    // Allow time-out even if there was no prior afternoon time-in or any time-in,
    // but prevent multiple time-outs in the same window.
    if (!lastEvent) return "time-out";
    if (lastEvent === "time-in") return "time-out";
    if (lastEvent === "time-out") return "attendance-closed";
    return "time-out"; // Fallback: allow time-out
  }
  // Allow time-out in afternoon window even if no prior time-in
  if (
    nowMinutes >= afternoonStartMinutes &&
    nowMinutes <= afternoonEndMinutes &&
    (!lastEvent || lastEvent === "time-in")
  ) {
    return "time-out";
  }
  if (nowMinutes <= afternoonEndMinutes && lastEvent === "time-in") {
    return "attendance-closed";
  }

  return "attendance-closed";
}

export function determineAttendanceStatus(
  currentTime,
  eventToRecord,
  settings,
  hadMorningTimeIn = false
) {
  const nowMinutes = toMinutes(currentTime);
  const morningStart = toMinutes(settings.morning_start);
  const morningEnd = toMinutes(settings.morning_end);
  const afternoonEnd = toMinutes(settings.afternoon_end);
  const morningGrace = Number(settings.morning_grace_minutes) || 15;

  if (nowMinutes > morningEnd) {
    // System is morning-in / afternoon-out based. Any punch in the afternoon is considered the afternoon out.
    if (nowMinutes < afternoonEnd) {
      return "early-out";
    } else if (nowMinutes >= afternoonEnd + 60) {
      return "overtime";
    }
    return "on-time";
  } else {
    // Morning punch (time-in)
    if (nowMinutes <= morningStart + morningGrace) {
      return "on-time";
    } else {
      return "late";
    }
  }

}

export function getAttendanceStatus(record, settings = {}) {
  if (record?.status) return record.status;

  const deviceDate = new Date(record?.device_time);
  if (Number.isNaN(deviceDate.getTime())) return "present";

  try {
    return determineAttendanceStatus(
      deviceDate.toTimeString().slice(0, 5),
      record?.event || "time-in",
      {
        morning_start: settings.morning_start || "08:00",
        morning_end: settings.morning_end || "12:00",
        afternoon_start: settings.afternoon_start || "13:00",
        afternoon_end: settings.afternoon_end || "17:00",
        morning_grace_minutes: settings.morning_grace_minutes,
        afternoon_grace_minutes: settings.afternoon_grace_minutes,
      },
    );
  } catch (error) {
    return "present";
  }
}

function buildBlockedMessage(eventToRecord, settings) {
  if (eventToRecord === "already-timed-in") {
    return "You have already timed in for this work window. Please time out before scanning again.";
  }

  if (eventToRecord === "attendance-closed") {
    return "You have already completed your attendance for this work window, or the attendance window is closed.";
  }

  if (eventToRecord === "time-out") {
    return "You have already timed out for this work window, or the attendance window is closed.";
  }

  if (settings?.morning_start && settings?.afternoon_end) {
    return `Attendance was not recorded because the scan time is outside the configured work hours (${settings.morning_start} - ${settings.afternoon_end}).`;
  }

  return "Attendance was not recorded because the scan does not match the current attendance rules.";
}

export async function recordAttendanceForPerson({
  supabase,
  person,
  settings,
  scanPayload,
  method = "face-scan",
}) {
  // Lazy import of offline queue to avoid errors in environments without window
  let offlineQueue = null;
  try {
    // eslint-disable-next-line global-require
    offlineQueue = require("../utils/offlineQueue").default;
  } catch (e) {
    offlineQueue = null;
  }

  if (!person?.id) {
    throw new Error("Cannot record attendance without a person id.");
  }

  if (!settings) {
    throw new Error("Work-hours settings are not loaded.");
  }

  const deviceTime = scanPayload?.deviceTime || new Date().toISOString();
  const deviceDate = new Date(deviceTime);
  const currentTime = deviceDate.toTimeString().slice(0, 5);

  // Compute current workday window (local day based on deviceTime) so
  // we only consider today's attendance when deciding already-timed-in.
  const year = deviceDate.getFullYear();
  const month = String(deviceDate.getMonth() + 1).padStart(2, "0");
  const day = String(deviceDate.getDate()).padStart(2, "0");
  const dayStartIso = `${year}-${month}-${day}T00:00:00.000Z`;
  const dayEndIso = `${year}-${month}-${day}T23:59:59.999Z`;

  // Debug output: show current time and settings values
  console.log("DEBUG: Current time for attendance:", currentTime);
  console.log("DEBUG: Settings used:", settings);
  let attData = [];
  try {
    const res = await supabase
      .from("attendance")
      .select("event, device_time")
      .eq("person_id", person.id)
      .gte("device_time", dayStartIso)
      .lte("device_time", dayEndIso)
      .order("device_time", { ascending: false });
    if (res.error) {
      console.warn("recordAttendanceForPerson: reading recent attendance failed, falling back to offline mode", res.error);
      attData = [];
    } else {
      attData = res.data || [];
    }
  } catch (e) {
    console.warn("recordAttendanceForPerson: exception reading recent attendance, using empty data", e);
    attData = [];
  }

  const lastEvent = attData?.[0]?.event || null;
  const lastEventDeviceTimeIso = attData?.[0]?.device_time || null;
  const event = determineExpectedEvent(
    currentTime,
    lastEvent,
    settings,
    lastEventDeviceTimeIso
  );

  // Additional protection: if this is an afternoon time-in, block it when
  // the same person already has an afternoon time-in earlier today.
  try {
    const nowMinutes = toMinutes(currentTime);
    const afternoonStartMinutes = toMinutes(settings.afternoon_start);
    const afternoonEndMinutes = toMinutes(settings.afternoon_end);
    if (event === "time-in" && nowMinutes >= afternoonStartMinutes && nowMinutes <= afternoonEndMinutes) {
      const hasAfternoonTimeIn = Array.isArray(attData) && attData.some((row) => {
        if (!row || row.event !== "time-in" || !row.device_time) return false;
        const dt = new Date(row.device_time);
        const hhmm = dt.toTimeString().slice(0, 5);
        const minutes = toMinutes(hhmm);
        return minutes >= afternoonStartMinutes && minutes <= afternoonEndMinutes;
      });
      if (hasAfternoonTimeIn) {
        return {
          inserted: false,
          blocked: true,
          event: "already-timed-in",
          message: buildBlockedMessage("already-timed-in", settings),
        };
      }
    }
  } catch (e) {
    // if anything goes wrong with the check, fall back to normal flow
    console.warn("Afternoon duplicate check failed:", e);
  }

  // Block only when rules say already-timed-in or attendance-closed;
  // time-out is now allowed even without a prior time-in.
  if (event === "already-timed-in" || event === "attendance-closed") {
    return {
      inserted: false,
      blocked: true,
      event,
      message: buildBlockedMessage(event, settings),
    };
  }

  // Debug output: show last event for this person
  console.log(
    "DEBUG: Last attendance event for person",
    person.id,
    "=",
    attData?.[0]?.event
  );
  // Determine if there was any morning time-in earlier today
  let hadMorningTimeIn = false;
  if (Array.isArray(attData) && attData.length > 0) {
    const morningStartMinutes = toMinutes(settings.morning_start);
    const morningEndMinutes = toMinutes(settings.morning_end);
    for (const row of attData) {
      if (row.event !== "time-in" || !row.device_time) continue;
      const dt = new Date(row.device_time);
      const hhmm = dt.toTimeString().slice(0, 5);
      const minutes = toMinutes(hhmm);
      if (minutes >= morningStartMinutes && minutes <= morningEndMinutes) {
        hadMorningTimeIn = true;
        break;
      }
    }
  }

  // Additional protection: block duplicate same-window events (morning/afternoon)
  try {
    const nowMinutes = toMinutes(currentTime);
    const morningStartMinutes = toMinutes(settings.morning_start);
    const morningEndMinutes = toMinutes(settings.morning_end);
    const afternoonStartMinutes = toMinutes(settings.afternoon_start);
    const afternoonEndMinutes = toMinutes(settings.afternoon_end);

    // Helper to check if attendance rows contain an event in a given window
    const hasEventInWindow = (eventName, startMin, endMin) => {
      if (!Array.isArray(attData)) return false;
      return attData.some((row) => {
        if (!row || row.event !== eventName || !row.device_time) return false;
        const dt = new Date(row.device_time);
        if (isNaN(dt.getTime())) return false;
        const hhmm = dt.toTimeString().slice(0, 5);
        const minutes = toMinutes(hhmm);
        return minutes >= startMin && minutes <= endMin;
      });
    };

    if (event === "time-in") {
      // Morning time-in duplicate
      if (nowMinutes >= morningStartMinutes && nowMinutes <= morningEndMinutes) {
        if (hasEventInWindow("time-in", morningStartMinutes, morningEndMinutes)) {
          return { inserted: false, blocked: true, event, message: "Morning time-in already recorded for this person." };
        }
      }
      // Afternoon time-in duplicate
      if (nowMinutes >= afternoonStartMinutes && nowMinutes <= afternoonEndMinutes) {
        if (hasEventInWindow("time-in", afternoonStartMinutes, afternoonEndMinutes)) {
          return { inserted: false, blocked: true, event, message: "Afternoon time-in already recorded for this person." };
        }
      }
    }

    if (event === "time-out") {
      // Morning time-out duplicate
      if (nowMinutes > morningEndMinutes && nowMinutes < afternoonStartMinutes) {
        if (hasEventInWindow("time-out", morningStartMinutes, morningEndMinutes)) {
          return { inserted: false, blocked: true, event, message: "Morning time-out already recorded for this person." };
        }
      }
      // Afternoon time-out duplicate
      if (nowMinutes > afternoonEndMinutes || (nowMinutes >= afternoonStartMinutes && nowMinutes <= afternoonEndMinutes)) {
        if (hasEventInWindow("time-out", afternoonStartMinutes, afternoonEndMinutes)) {
          return { inserted: false, blocked: true, event, message: "Afternoon time-out already recorded for this person." };
        }
      }
    }
  } catch (e) {
    // ignore and continue
  }

  const status = determineAttendanceStatus(
    currentTime,
    event,
    settings,
    hadMorningTimeIn
  );

  // Prevent duplicate inserts from near-simultaneous scans (race condition):
  // If an attendance with the same person and event was recorded very
  // recently (within DUPLICATE_WINDOW_MS), skip inserting a duplicate.
  const DUPLICATE_WINDOW_MS = 30 * 1000; // 30 seconds
  const duplicateWindowStartIso = new Date(
    deviceDate.getTime() - DUPLICATE_WINDOW_MS
  ).toISOString();

  try {
    let recentDup = [];
    try {
      const res = await supabase
        .from("attendance")
        .select("id, device_time")
        .eq("person_id", person.id)
        .eq("event", event)
        .gte("device_time", duplicateWindowStartIso)
        .order("device_time", { ascending: false })
        .limit(1);
      if (res.error) throw res.error;
      recentDup = res.data || [];
    } catch (e) {
      // If duplicate check fails (likely offline), try to detect duplicates from local queue when possible
      try {
        if (offlineQueue) {
          const queued = await offlineQueue.getAllQueue();
          const found = queued.find((q) => q.person_id === person.id && q.event === event && new Date(q.device_time).getTime() >= new Date(duplicateWindowStartIso).getTime());
          if (found) {
            return { inserted: false, blocked: true, event, message: "Duplicate attendance detected in offline queue — skipping duplicate record." };
          }
        }
      } catch (ee) {}
      recentDup = [];
    }

    if (Array.isArray(recentDup) && recentDup.length > 0) {
      return {
        inserted: false,
        blocked: true,
        event,
        message:
          "Duplicate attendance detected recently — skipping duplicate record.",
      };
    }
  } catch (err) {
    // If duplicate-check fails for some reason, log and continue to attempt insert.
    console.warn("Duplicate check failed, proceeding to insert:", err);
  }

  try {
    const { error } = await supabase.from("attendance").insert({
      person_id: person.id,
      name: person.name,
      department: person.department,
      event,
      point: scanPayload?.point || null,
      method,
      device_time: deviceTime,
      status,
      photo: scanPayload?.photoDataUrl || null,
    });
    if (error) throw error;
    return { inserted: true, blocked: false, event, status };
  } catch (e) {
    const errorMessage = String(e?.message || e || "");
    if (/duplicate attendance|duplicate scan|duplicate|unique|constraint/i.test(errorMessage)) {
      return {
        inserted: false,
        blocked: true,
        event,
        message: "Duplicate attendance detected — skipping duplicate record.",
      };
    }

    // If insert failed (likely network), enqueue to offline queue if available
    console.warn("recordAttendanceForPerson: insert failed, enqueueing offline", e);
    try {
      if (offlineQueue) {
        const qres = await offlineQueue.enqueueAttendance({
          person_id: person.id,
          name: person.name,
          department: person.department,
          event,
          point: scanPayload?.point || null,
          method: method || "face-scan",
          device_time: deviceTime,
          status,
          photo: scanPayload?.photoDataUrl || null,
        });
        // enqueueAttendance may return an object like { queued: false, reason }
        if (qres && typeof qres === 'object' && qres.queued === false) {
          // Did not queue due to duplicate window or recent duplicate
          const reason = qres.reason || 'enqueue_blocked';
          let msg = 'Attendance not queued.';
          if (reason === 'recent duplicate') msg = 'Duplicate scan detected recently; not queued.';
          else if (reason === 'duplicate_morning_time_in') msg = 'Morning time-in already recorded or queued.';
          else if (reason === 'duplicate_afternoon_time_in') msg = 'Afternoon time-in already recorded or queued.';
          else if (reason === 'duplicate_morning_time_out') msg = 'Morning time-out already recorded or queued.';
          else if (reason === 'duplicate_afternoon_time_out') msg = 'Afternoon time-out already recorded or queued.';
          return { inserted: false, blocked: true, event, message: msg };
        }
        return { inserted: true, queued: true, event, status };
      }
    } catch (ee) {
      console.warn("Failed to enqueue offline attendance", ee);
    }
    // Nothing else we can do — rethrow for upstream handling
    throw e;
  }
}

// Automatically generate `time-out` (Morning Out) entries at the configured
// morning end (defaults to 11:59) for persons who have a morning `time-in`
// but no corresponding `time-out` yet. Returns an array of results.
export async function autoGenerateMorningOut({ supabase, settings }) {
  if (!supabase) throw new Error('Supabase client required');
  if (!settings) throw new Error('Work-hours settings required');

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  // Use morning_end as configured, default to 11:59
  const outHHMM = settings.morning_end || '11:59';
  const [oh, om] = outHHMM.split(':').map(Number);
  const outDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), oh, om, 0, 0);
  const outIso = outDate.toISOString();

  const dayStartIso = `${year}-${month}-${day}T00:00:00.000Z`;
  const dayEndIso = `${year}-${month}-${day}T23:59:59.999Z`;

  const { data: persons, error: personsErr } = await supabase.from('persons').select('id, name, department');
  if (personsErr) throw personsErr;

  const results = [];

  for (const p of persons || []) {
    try {
      const { data: att, error: attErr } = await supabase
        .from('attendance')
        .select('id,event,device_time,photo')
        .eq('person_id', p.id)
        .gte('device_time', dayStartIso)
        .lte('device_time', dayEndIso)
        .order('device_time', { ascending: true });
      if (attErr) {
        console.warn('autoGenerateMorningOut: failed reading attendance for', p.id, attErr);
        continue;
      }

      const morningStartMin = toMinutes(settings.morning_start);
      const morningEndMin = toMinutes(settings.morning_end);
      let morningInRow = null;
      let hasMorningOut = false;

      if (Array.isArray(att)) {
        for (const r of att) {
          if (!r || !r.device_time) continue;
          const dt = new Date(r.device_time);
          const hhmm = dt.toTimeString().slice(0,5);
          const minutes = toMinutes(hhmm);
          if (r.event === 'time-in' && minutes >= morningStartMin && minutes <= morningEndMin) {
            if (!morningInRow) morningInRow = r;
          }
          if (r.event === 'time-out' && morningInRow) {
            const dtOut = new Date(r.device_time);
            if (dtOut.getTime() >= new Date(morningInRow.device_time).getTime()) {
              hasMorningOut = true;
            }
          }
        }
      }

      if (morningInRow && !hasMorningOut) {
        // Prevent near-duplicate inserts
        const DUPLICATE_WINDOW_MS = 30 * 1000;
        const dupWindowIso = new Date(outDate.getTime() - DUPLICATE_WINDOW_MS).toISOString();
        const { data: recentDup } = await supabase
          .from('attendance')
          .select('id')
          .eq('person_id', p.id)
          .eq('event', 'time-out')
          .gte('device_time', dupWindowIso)
          .order('device_time', { ascending: false })
          .limit(1);
        if (Array.isArray(recentDup) && recentDup.length > 0) {
          results.push({ person_id: p.id, inserted: false, reason: 'recent duplicate' });
          continue;
        }

        const currentTime = outDate.toTimeString().slice(0,5);
        const status = determineAttendanceStatus(currentTime, 'time-out', settings, true);

        const { error: insErr } = await supabase.from('attendance').insert({
          person_id: p.id,
          name: p.name,
          department: p.department,
          event: 'time-out',
          point: 'System auto-generated',
          method: 'auto-morning-out',
          device_time: outIso,
          status,
          photo: morningInRow.photo || null,
        });
        if (insErr) {
          console.warn('autoGenerateMorningOut: failed to insert for', p.id, insErr);
          results.push({ person_id: p.id, inserted: false, reason: insErr.message });
        } else {
          results.push({ person_id: p.id, inserted: true });
        }
      }
    } catch (e) {
      console.error('autoGenerateMorningOut: error for person', p.id, e);
    }
  }

  return results;
}
