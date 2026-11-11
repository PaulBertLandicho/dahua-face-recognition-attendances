import os

path = "src/AdminPage/attendanceUtils.js"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

target_insert = """    const insertPayload = {
      person_id: person.id,
      name: person.name,
      department: person.department,
      event,
      point: scanPayload?.point || null,
      method,
      device_time: deviceTime,
      status,
      photo: scanPayload?.photoDataUrl || null,
    };
    const noteText = scanPayload?.notes || scanPayload?.note || null;
    if (noteText) {
      insertPayload.notes = noteText;
    }"""

replacement_insert = """    const insertPayload = {
      person_id: person.id,
      name: person.name,
      department: person.department,
      event,
      point: scanPayload?.point || null,
      method,
      device_time: deviceTime,
      status,
      photo: scanPayload?.photoDataUrl || null,
    };
    if (scanPayload?.verification_token) {
      insertPayload.verification_token = scanPayload.verification_token;
    }
    const noteText = scanPayload?.notes || scanPayload?.note || null;
    if (noteText) {
      insertPayload.notes = noteText;
    }"""

target_catch = """    const errorMessage = String(e?.message || e || "");
    if (/duplicate attendance|duplicate scan|duplicate|unique|constraint/i.test(errorMessage)) {"""

replacement_catch = """    const errorMessage = String(e?.message || e || "");
    if (/verification token/i.test(errorMessage)) {
      return {
        inserted: false,
        blocked: true,
        event,
        message: "Face verification expired or invalid. Please scan face again.",
      };
    }
    if (/duplicate attendance|duplicate scan|duplicate|unique|constraint/i.test(errorMessage)) {"""

target_queue = """          photo: scanPayload?.photoDataUrl || null,
          notes: noteText,
        });"""

replacement_queue = """          photo: scanPayload?.photoDataUrl || null,
          notes: noteText,
          verification_token: scanPayload?.verification_token || null,
        });"""

norm = content.replace("\r\n", "\n")
norm_ti = target_insert.replace("\r\n", "\n")
norm_ri = replacement_insert.replace("\r\n", "\n")
norm_tc = target_catch.replace("\r\n", "\n")
norm_rc = replacement_catch.replace("\r\n", "\n")
norm_tq = target_queue.replace("\r\n", "\n")
norm_rq = replacement_queue.replace("\r\n", "\n")

if norm_ti in norm and norm_tc in norm and norm_tq in norm:
    updated = norm.replace(norm_ti, norm_ri, 1)
    updated = updated.replace(norm_tc, norm_rc, 1)
    updated = updated.replace(norm_tq, norm_rq, 1)
    if "\r\n" in content:
        updated = updated.replace("\n", "\r\n")
    with open(path, "w", encoding="utf-8") as f:
        f.write(updated)
    print("SUCCESS: attendanceUtils.js updated with verification_token.")
else:
    print("FAILED: Targets in attendanceUtils.js not found.")
