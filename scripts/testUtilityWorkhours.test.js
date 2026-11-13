const mysql = require("mysql2/promise");
const assert = require("assert");
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const { determineAttendanceStatus, getAttendanceStatus } = require("../src/AdminPage/attendanceUtils");

async function runTests() {
  console.log("=== Testing UTILITY Department Attendance Workhour Settings ===");

  // 1. Unit Tests for determineAttendanceStatus & getAttendanceStatus
  console.log("\n[1/3] Testing JavaScript attendanceUtils logic...");
  const utilitySettings = {
    morning_start: "07:00",
    morning_end: "11:59",
    afternoon_start: "13:00",
    afternoon_end: "17:00",
    on_time_until: "08:00",
    morning_grace_minutes: 0,
    afternoon_grace_minutes: 30,
  };

  const standardSettings = {
    morning_start: "08:00",
    morning_end: "11:59",
    afternoon_start: "13:00",
    afternoon_end: "17:00",
    morning_grace_minutes: 0,
    afternoon_grace_minutes: 30,
  };

  // Test UTILITY unit rules
  assert.strictEqual(determineAttendanceStatus("06:45", "time-in", utilitySettings), "early-in", "UTILITY 06:45 should be early-in");
  assert.strictEqual(determineAttendanceStatus("07:00", "time-in", utilitySettings), "on-time", "UTILITY 07:00 should be on-time");
  assert.strictEqual(determineAttendanceStatus("07:15", "time-in", utilitySettings), "on-time", "UTILITY 07:15 should be on-time");
  assert.strictEqual(determineAttendanceStatus("07:45", "time-in", utilitySettings), "on-time", "UTILITY 07:45 should be on-time");
  assert.strictEqual(determineAttendanceStatus("08:00", "time-in", utilitySettings), "on-time", "UTILITY 08:00 should be on-time");
  assert.strictEqual(determineAttendanceStatus("08:01", "time-in", utilitySettings), "late", "UTILITY 08:01 should be late");
  assert.strictEqual(determineAttendanceStatus("16:50", "time-out", utilitySettings), "early-out", "UTILITY 16:50 should be early-out");
  assert.strictEqual(determineAttendanceStatus("17:00", "time-out", utilitySettings), "on-time", "UTILITY 17:00 should be on-time");
  assert.strictEqual(determineAttendanceStatus("17:25", "time-out", utilitySettings), "on-time", "UTILITY 17:25 should be on-time");
  assert.strictEqual(determineAttendanceStatus("17:35", "time-out", utilitySettings), "overtime", "UTILITY 17:35 should be overtime");

  // Test Standard unit rules
  assert.strictEqual(determineAttendanceStatus("07:15", "time-in", standardSettings), "early-in", "Standard 07:15 should be early-in");
  assert.strictEqual(determineAttendanceStatus("08:00", "time-in", standardSettings), "on-time", "Standard 08:00 should be on-time");
  assert.strictEqual(determineAttendanceStatus("08:01", "time-in", standardSettings), "late", "Standard 08:01 should be late");

  // Test getAttendanceStatus with department resolution
  const royRecord = {
    person_id: "11",
    department: "UTILITY",
    event: "time-in",
    device_time: "2026-11-13 07:12:34",
  };
  assert.strictEqual(getAttendanceStatus(royRecord, standardSettings), "on-time", "Roy (UTILITY) at 07:12 should get on-time badge");

  const otherRecord = {
    person_id: "1",
    department: "IT-TECHNICAL",
    event: "time-in",
    device_time: "2026-11-13 07:12:34",
  };
  assert.strictEqual(getAttendanceStatus(otherRecord, standardSettings), "early-in", "Other dept at 07:12 should get early-in badge");
  console.log("✓ JavaScript attendanceUtils tests passed!");

  // 2. Database Schema Tests
  console.log("\n[2/3] Testing MySQL department_rates schema & UTILITY row...");
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "multifac_attendance",
  });

  const [utilityRows] = await conn.query("SELECT * FROM department_rates WHERE department = 'UTILITY'");
  assert.strictEqual(utilityRows.length, 1, "UTILITY department row must exist in department_rates");
  const u = utilityRows[0];
  assert.strictEqual(Number(u.has_custom_workhours), 1, "UTILITY has_custom_workhours must be 1");
  assert.strictEqual(String(u.morning_start).slice(0, 5), "07:00", "UTILITY morning_start must be 07:00");
  assert.strictEqual(String(u.on_time_until).slice(0, 5), "08:00", "UTILITY on_time_until must be 08:00");
  assert.strictEqual(String(u.afternoon_end).slice(0, 5), "17:00", "UTILITY afternoon_end must be 17:00");
  console.log("✓ MySQL department_rates configuration verified!");

  // 3. MySQL Triggers Real Execution Test
  console.log("\n[3/3] Testing MySQL triggers on attendance inserts...");
  const testIds = [];
  try {
    const testCases = [
      // UTILITY test punches across distinct test dates to avoid daily slot collision
      { dept: "UTILITY", pid: "11", name: "Roy", time: "2026-12-01 06:45:00", expSlot: "morning_time_in", expStatus: "early-in", expEvent: "time-in" },
      { dept: "UTILITY", pid: "11", name: "Roy", time: "2026-12-02 07:00:00", expSlot: "morning_time_in", expStatus: "on-time", expEvent: "time-in" },
      { dept: "UTILITY", pid: "11", name: "Roy", time: "2026-12-03 07:35:00", expSlot: "morning_time_in", expStatus: "on-time", expEvent: "time-in" },
      { dept: "UTILITY", pid: "11", name: "Roy", time: "2026-12-04 08:00:00", expSlot: "morning_time_in", expStatus: "on-time", expEvent: "time-in" },
      { dept: "UTILITY", pid: "11", name: "Roy", time: "2026-12-05 08:05:00", expSlot: "morning_time_in", expStatus: "late", expEvent: "time-in" },
      { dept: "UTILITY", pid: "11", name: "Roy", time: "2026-12-06 16:50:00", expSlot: "afternoon_time_out", expStatus: "early-out", expEvent: "time-out" },
      { dept: "UTILITY", pid: "11", name: "Roy", time: "2026-12-07 17:05:00", expSlot: "afternoon_time_out", expStatus: "on-time", expEvent: "time-out" },
      { dept: "UTILITY", pid: "11", name: "Roy", time: "2026-12-08 17:45:00", expSlot: "afternoon_time_out", expStatus: "overtime", expEvent: "time-out" },

      // Non-UTILITY test punch (should follow global 8:00 AM schedule)
      { dept: "IT-TECHNICAL", pid: "1", name: "Paul Bert", time: "2026-12-09 07:15:00", expSlot: "morning_time_in", expStatus: "early-in", expEvent: "time-in" },
      { dept: "IT-TECHNICAL", pid: "1", name: "Paul Bert", time: "2026-12-10 08:00:00", expSlot: "morning_time_in", expStatus: "on-time", expEvent: "time-in" },
      { dept: "IT-TECHNICAL", pid: "1", name: "Paul Bert", time: "2026-12-11 08:05:00", expSlot: "morning_time_in", expStatus: "late", expEvent: "time-in" },
    ];

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      const testId = 9999000 + i;
      testIds.push(testId);

      await conn.query(
        "INSERT INTO attendance (id, person_id, name, department, device_time, method) VALUES (?, ?, ?, ?, ?, ?)",
        [testId, tc.pid, tc.name, tc.dept, tc.time, "test-suite"]
      );

      const [res] = await conn.query("SELECT event, attendance_slot, status FROM attendance WHERE id = ?", [testId]);
      assert.strictEqual(res.length, 1, `Test row ${testId} must exist`);
      const row = res[0];

      assert.strictEqual(row.event, tc.expEvent, `[${tc.dept} @ ${tc.time}] Event mismatch: expected ${tc.expEvent}, got ${row.event}`);
      assert.strictEqual(row.attendance_slot, tc.expSlot, `[${tc.dept} @ ${tc.time}] Slot mismatch: expected ${tc.expSlot}, got ${row.attendance_slot}`);
      assert.strictEqual(row.status, tc.expStatus, `[${tc.dept} @ ${tc.time}] Status mismatch: expected ${tc.expStatus}, got ${row.status}`);
      console.log(`  ✓ ${tc.dept} at ${tc.time.slice(11)} -> Event: ${row.event}, Slot: ${row.attendance_slot}, Status: ${row.status}`);
    }
  } finally {
    if (testIds.length > 0) {
      await conn.query(`DELETE FROM attendance WHERE id IN (${testIds.join(", ")})`);
      console.log(`Cleaned up ${testIds.length} temporary test records.`);
    }
    await conn.end();
  }

  console.log("\nALL TESTS PASSED SUCCESSFULLY! ✓✓✓");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
