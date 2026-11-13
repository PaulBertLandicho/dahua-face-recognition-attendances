require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const express = require("express");
const cors = require("cors");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

let ffmpeg = null;
try {
  ffmpeg = require("fluent-ffmpeg");
} catch (e) {
  console.warn("fluent-ffmpeg not loaded:", e.message);
}

const app = express();

// High-efficiency Gzip/Brotli response compression to minimize cPanel bandwidth
let compression = null;
try {
  compression = require("compression");
  app.use(compression({
    level: 6,
    threshold: 1024,
  }));
  console.log("[Bandwidth Optimization] Compression middleware enabled.");
} catch (e) {
  console.warn("compression package not loaded:", e.message);
}

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Auth-Token",
    "X-Face-Token",
    "X-Attendance-Import-Token",
    "X-Sync-Token",
  ],
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const PORT = Number(process.env.PORT || 4000);
const STREAM_STALE_MS = 5000;

// Password Hashing Configuration (bcrypt via pure-JS bcryptjs for cPanel compatibility)
const BCRYPT_SALT_ROUNDS = Math.min(
  14,
  Math.max(10, Number(process.env.BCRYPT_SALT_ROUNDS || 12) || 12)
);
const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const ALLOW_LEGACY_PLAINTEXT_UPGRADE =
  String(process.env.ALLOW_LEGACY_PLAINTEXT_UPGRADE ?? "true").toLowerCase() !== "false";
const MIN_PASSWORD_LENGTH = Math.max(4, Number(process.env.MIN_PASSWORD_LENGTH || 8) || 8);

// Dahua Configuration
const RTSP_URL = process.env.DAHUA_RTSP_URL;
const DAHUA_DEVICE_IP = process.env.DAHUA_DEVICE_IP || "192.168.111.222";
const DAHUA_DEVICE_PORT = Number(process.env.DAHUA_DEVICE_PORT || 80);
const DAHUA_USERNAME = process.env.DAHUA_USERNAME || "admin";
const DAHUA_PASSWORD = process.env.DAHUA_PASSWORD || "";
const DAHUA_REQUEST_TIMEOUT_MS = Number(process.env.DAHUA_REQUEST_TIMEOUT_MS || 30000);
const AUTO_SYNC_ATTENDANCE_MINUTES = Number(process.env.AUTO_SYNC_ATTENDANCE_MINUTES || 0);

// Dahua Local Connector Configuration (optional, for network isolation fix)
const DAHUA_CONNECTOR_URL = process.env.DAHUA_CONNECTOR_URL || null;
const USE_LOCAL_CONNECTOR = !!DAHUA_CONNECTOR_URL;
if (USE_LOCAL_CONNECTOR) {
  console.log(`[Dahua] Using local connector at: ${DAHUA_CONNECTOR_URL}`);
} else {
  console.log(`[Dahua] Using direct connection to ${DAHUA_DEVICE_IP}:${DAHUA_DEVICE_PORT}`);
}

const hlsDir = path.join(__dirname, "hls");
if (!fs.existsSync(hlsDir)) {
  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch (e) {}
}

let ffmpegCommand = null;
const streamState = {
  status: "idle",
  lastError: null,
  lastStartAt: null,
  pid: null,
};

// MySQL Database Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "+08:00",
  dateStrings: true,
});

pool.query(`
  CREATE TABLE IF NOT EXISTS dahua_pending_deletions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(50) NOT NULL DEFAULT 'attendance',
    person_id VARCHAR(191) NOT NULL,
    device_time VARCHAR(100) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => {
  // Automatically remove any completed or stale records so the table does not accumulate clutter
  return pool.query("DELETE FROM dahua_pending_deletions WHERE status = 'completed' OR created_at < NOW() - INTERVAL 2 DAY");
}).catch((err) => console.warn("dahua_pending_deletions table init warning:", err.message));

// Initialize Dahua Device Monitoring and Sync Tracking table
pool.query(`
  CREATE TABLE IF NOT EXISTS dahua_device_status (
    id INT PRIMARY KEY DEFAULT 1,
    device_name VARCHAR(191) NOT NULL DEFAULT 'Multifactors Biometric Station',
    model VARCHAR(191) NOT NULL DEFAULT 'DHI-ASA3213GL-MW',
    ip_address VARCHAR(100) NOT NULL DEFAULT '192.168.111.222',
    port INT NOT NULL DEFAULT 80,
    connection_status VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    last_successful_sync DATETIME NULL,
    last_failed_sync DATETIME NULL,
    last_failed_reason TEXT NULL,
    last_attendance_sync DATETIME NULL,
    last_person_sync DATETIME NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
`).then(async () => {
  await pool.query(`
    INSERT IGNORE INTO dahua_device_status (id, device_name, model, ip_address, port, connection_status)
    VALUES (1, 'Multifactors Biometric Station', 'DHI-ASA3213GL-MW', '${DAHUA_DEVICE_IP}', ${DAHUA_DEVICE_PORT}, 'Unknown')
  `);
}).catch((err) => console.warn("dahua_device_status table init warning:", err.message));

// Initialize Expenses table for payroll deductions
pool.query(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    person_id VARCHAR(191) NOT NULL,
    period VARCHAR(100) NULL,
    item_name VARCHAR(255) NOT NULL,
    amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    expense_date DATE NULL,
    note TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_expenses_person (person_id),
    INDEX idx_expenses_period (period)
  )
`).catch((err) => console.warn("expenses table init warning:", err.message));

async function recordDeviceSyncStatus({ type, success, error = null }) {
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (success) {
      if (type === 'person') {
        await pool.query(
          "UPDATE dahua_device_status SET last_successful_sync = ?, last_person_sync = ?, connection_status = 'Online', last_failed_reason = NULL WHERE id = 1",
          [now, now]
        );
      } else if (type === 'attendance') {
        await pool.query(
          "UPDATE dahua_device_status SET last_successful_sync = ?, last_attendance_sync = ?, connection_status = 'Online', last_failed_reason = NULL WHERE id = 1",
          [now, now]
        );
      } else {
        await pool.query(
          "UPDATE dahua_device_status SET last_successful_sync = ?, connection_status = 'Online', last_failed_reason = NULL WHERE id = 1",
          [now]
        );
      }
    } else {
      await pool.query(
        "UPDATE dahua_device_status SET last_failed_sync = ?, last_failed_reason = ?, connection_status = 'Error' WHERE id = 1",
        [now, String(error || 'Sync operation failed')]
      );
    }
  } catch (e) {
    console.warn("recordDeviceSyncStatus warning:", e.message);
  }
}

// Ensure employer share and custom attendance workhour columns exist in department_rates
(async () => {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM department_rates");
    const colNames = (cols || []).map((c) => c.Field);
    if (!colNames.includes("sss_employer")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN sss_employer DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER philhealth");
    }
    if (!colNames.includes("pag_ibig_employer")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN pag_ibig_employer DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER sss_employer");
    }
    if (!colNames.includes("philhealth_employer")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN philhealth_employer DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER pag_ibig_employer");
    }
    if (!colNames.includes("has_custom_workhours")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN has_custom_workhours TINYINT(1) NOT NULL DEFAULT 0 AFTER special_holiday_rate");
    }
    if (!colNames.includes("morning_start")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN morning_start TIME NULL DEFAULT NULL AFTER has_custom_workhours");
    }
    if (!colNames.includes("morning_end")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN morning_end TIME NULL DEFAULT NULL AFTER morning_start");
    }
    if (!colNames.includes("afternoon_start")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN afternoon_start TIME NULL DEFAULT NULL AFTER morning_end");
    }
    if (!colNames.includes("afternoon_end")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN afternoon_end TIME NULL DEFAULT NULL AFTER afternoon_start");
    }
    if (!colNames.includes("on_time_until")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN on_time_until TIME NULL DEFAULT NULL AFTER afternoon_end");
    }

    // Initialize UTILITY department with specific attendance work hours (Time-in 7:00 AM, 7:00-8:00 on-time badge, Time-out 5:00 PM)
    await pool.query(`
      UPDATE department_rates
         SET has_custom_workhours = 1,
             morning_start = COALESCE(morning_start, '07:00:00'),
             morning_end = COALESCE(morning_end, '11:59:00'),
             afternoon_start = COALESCE(afternoon_start, '13:00:00'),
             afternoon_end = COALESCE(afternoon_end, '17:00:00'),
             on_time_until = COALESCE(on_time_until, '08:00:00')
       WHERE department = 'UTILITY'
    `);
  } catch (e) {
    console.warn("Department rates workhour columns check warning:", e.message);
  }
})();

// Ensure description/note column exists in holidays table
(async () => {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM holidays");
    const colNames = (cols || []).map((c) => c.Field);
    if (!colNames.includes("description")) {
      await pool.query("ALTER TABLE holidays ADD COLUMN description VARCHAR(255) NULL AFTER type");
    }
  } catch (e) {
    console.warn("Holidays description column check warning:", e.message);
  }
})();

// Ensure late tier deduction columns exist in settings table
(async () => {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM settings");
    const colNames = (cols || []).map((c) => c.Field);
    if (!colNames.includes("late_base_fee")) {
      await pool.query("ALTER TABLE settings ADD COLUMN late_base_fee DECIMAL(10,2) NOT NULL DEFAULT 40.00");
    }
    if (!colNames.includes("late_per_minute_fee")) {
      await pool.query("ALTER TABLE settings ADD COLUMN late_per_minute_fee DECIMAL(10,2) NOT NULL DEFAULT 1.00");
    }
    if (!colNames.includes("late_tier_minor_fee")) {
      await pool.query("ALTER TABLE settings ADD COLUMN late_tier_minor_fee DECIMAL(10,2) NOT NULL DEFAULT 10.00");
    }
    if (!colNames.includes("late_tier_mid_fee")) {
      await pool.query("ALTER TABLE settings ADD COLUMN late_tier_mid_fee DECIMAL(10,2) NOT NULL DEFAULT 25.00");
    }
    if (!colNames.includes("late_tier_major_mode")) {
      await pool.query("ALTER TABLE settings ADD COLUMN late_tier_major_mode VARCHAR(50) NOT NULL DEFAULT 'employee_hourly'");
    }
    if (!colNames.includes("late_tier_major_fee")) {
      await pool.query("ALTER TABLE settings ADD COLUMN late_tier_major_fee DECIMAL(10,2) NOT NULL DEFAULT 50.00");
    }
  } catch (e) {
    console.warn("Settings late tier columns check warning:", e.message);
  }
})();

// Ensure ot_status and notes columns exist in attendance table
(async () => {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM attendance");
    const colNames = (cols || []).map((c) => c.Field);
    if (!colNames.includes("ot_status")) {
      await pool.query("ALTER TABLE attendance ADD COLUMN ot_status VARCHAR(20) NOT NULL DEFAULT 'pending' AFTER status");
    }
    if (!colNames.includes("notes")) {
      await pool.query("ALTER TABLE attendance ADD COLUMN notes TEXT NULL AFTER photo");
    }
  } catch (e) {
    console.warn("Attendance columns check warning:", e.message);
  }
  try {
    const [pCols] = await pool.query("SHOW COLUMNS FROM payroll_periods");
    const pColNames = (pCols || []).map((c) => c.Field);
    if (!pColNames.includes("waive_early_in")) {
      await pool.query("ALTER TABLE payroll_periods ADD COLUMN waive_early_in TINYINT(1) NOT NULL DEFAULT 0 AFTER net");
    }
    if (!pColNames.includes("waive_overtime")) {
      await pool.query("ALTER TABLE payroll_periods ADD COLUMN waive_overtime TINYINT(1) NOT NULL DEFAULT 0 AFTER waive_early_in");
    }
  } catch (e) {
    console.warn("payroll_periods waive columns check warning:", e.message);
  }
  try {
    const [personCols] = await pool.query("SHOW COLUMNS FROM persons");
    const personColNames = (personCols || []).map((c) => c.Field);
    if (!personColNames.includes("token_version")) {
      await pool.query("ALTER TABLE persons ADD COLUMN token_version INT NOT NULL DEFAULT 1");
    }
  } catch (e) {
    console.warn("persons token_version check warning:", e.message);
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS face_token_uses (
        jti VARCHAR(64) NOT NULL,
        verifier_pid VARCHAR(191) NOT NULL,
        target_person_id VARCHAR(191) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (jti, target_person_id),
        INDEX idx_face_token_uses_created (created_at)
      )
    `);
  } catch (e) {
    console.warn("face_token_uses table init warning:", e.message);
  }
})();

// Ensure attendance slot triggers allow early-in scans before morning_start and auto-calculate status with department-specific workhour support
(async () => {
  try {
    await pool.query("DROP TRIGGER IF EXISTS attendance_before_insert_slot");
    await pool.query(`
      CREATE TRIGGER attendance_before_insert_slot
      BEFORE INSERT ON attendance
      FOR EACH ROW
      BEGIN
        DECLARE configured_morning_start TIME DEFAULT '08:00:00';
        DECLARE configured_morning_end TIME DEFAULT '11:59:00';
        DECLARE configured_afternoon_start TIME DEFAULT '13:00:00';
        DECLARE configured_afternoon_end TIME DEFAULT '17:00:00';
        DECLARE configured_morning_grace INT DEFAULT 0;
        DECLARE configured_afternoon_grace INT DEFAULT 0;
        DECLARE configured_on_time_until TIME DEFAULT NULL;

        DECLARE emp_dept VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NEW.department;
        DECLARE dept_m_start TIME DEFAULT NULL;
        DECLARE dept_m_end TIME DEFAULT NULL;
        DECLARE dept_a_start TIME DEFAULT NULL;
        DECLARE dept_a_end TIME DEFAULT NULL;
        DECLARE dept_on_time_until TIME DEFAULT NULL;
        DECLARE dept_has_custom INT DEFAULT 0;

        -- 1. Load global settings
        SELECT COALESCE(morning_start, '08:00:00'),
               COALESCE(morning_end, '11:59:00'),
               COALESCE(afternoon_start, '13:00:00'),
               COALESCE(afternoon_end, '17:00:00'),
               COALESCE(morning_grace_minutes, 0),
               COALESCE(afternoon_grace_minutes, 0)
          INTO configured_morning_start, configured_morning_end, configured_afternoon_start, configured_afternoon_end, configured_morning_grace, configured_afternoon_grace
          FROM settings ORDER BY id LIMIT 1;

        -- 2. Resolve department if not specified on the record
        IF (emp_dept IS NULL OR emp_dept = '') AND NEW.person_id IS NOT NULL THEN
          SELECT department INTO emp_dept FROM persons WHERE id = NEW.person_id LIMIT 1;
          IF emp_dept IS NOT NULL AND (NEW.department IS NULL OR NEW.department = '') THEN
            SET NEW.department = emp_dept;
          END IF;
        END IF;

        -- 3. Check for department-specific attendance workhours (e.g. UTILITY: 7:00 AM start, 7:00-8:00 AM on-time)
        IF emp_dept IS NOT NULL AND emp_dept != '' THEN
          SELECT morning_start, morning_end, afternoon_start, afternoon_end, on_time_until, COALESCE(has_custom_workhours, 0)
            INTO dept_m_start, dept_m_end, dept_a_start, dept_a_end, dept_on_time_until, dept_has_custom
            FROM department_rates
           WHERE department = emp_dept LIMIT 1;

          IF dept_has_custom = 1 OR dept_m_start IS NOT NULL THEN
            IF dept_m_start IS NOT NULL THEN
              SET configured_morning_start = dept_m_start;
            END IF;
            IF dept_m_end IS NOT NULL THEN
              SET configured_morning_end = dept_m_end;
            END IF;
            IF dept_a_start IS NOT NULL THEN
              SET configured_afternoon_start = dept_a_start;
            END IF;
            IF dept_a_end IS NOT NULL THEN
              SET configured_afternoon_end = dept_a_end;
            END IF;
            IF dept_on_time_until IS NOT NULL THEN
              SET configured_on_time_until = dept_on_time_until;
            END IF;
          END IF;
        END IF;

        IF TIME(NEW.device_time) < '03:00:00' THEN
          SET NEW.event = 'time-out';
          SET NEW.attendance_slot = 'afternoon_time_out';
          SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time - INTERVAL 1 DAY));
          SET NEW.status = 'overtime';
        ELSEIF NEW.event = 'time-out' OR TIME(NEW.device_time) > configured_morning_end THEN
          SET NEW.event = 'time-out';
          SET NEW.attendance_slot = 'afternoon_time_out';
          SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time));
          IF NEW.status IS NULL OR NEW.status = '' OR NEW.status = 'present' OR NEW.status = 'on-time' THEN
            IF TIME(NEW.device_time) < configured_afternoon_end THEN
              SET NEW.status = 'early-out';
            ELSEIF TIME(NEW.device_time) >= ADDTIME(configured_afternoon_end, SEC_TO_TIME((configured_afternoon_grace + 1) * 60)) THEN
              SET NEW.status = 'overtime';
            ELSE
              SET NEW.status = 'on-time';
            END IF;
          END IF;
        ELSEIF TIME(NEW.device_time) <= configured_morning_end THEN
          SET NEW.event = 'time-in';
          SET NEW.attendance_slot = 'morning_time_in';
          SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time));
          IF NEW.status IS NULL OR NEW.status = '' OR NEW.status = 'present' OR NEW.status = 'on-time' THEN
            IF configured_on_time_until IS NOT NULL THEN
              -- Department-specific on-time window (e.g. UTILITY: 7:00 - 8:00 AM)
              IF TIME(NEW.device_time) < configured_morning_start THEN
                SET NEW.status = 'early-in';
              ELSEIF TIME(NEW.device_time) <= ADDTIME(configured_on_time_until, SEC_TO_TIME((configured_morning_grace + 1) * 60 - 1)) THEN
                SET NEW.status = 'on-time';
              ELSE
                SET NEW.status = 'late';
              END IF;
            ELSE
              -- Global settings
              IF TIME(NEW.device_time) <= '07:30:59' AND TIME(NEW.device_time) < configured_morning_start THEN
                SET NEW.status = 'early-in';
              ELSEIF TIME(NEW.device_time) < ADDTIME(configured_morning_start, SEC_TO_TIME((configured_morning_grace + 1) * 60)) THEN
                SET NEW.status = 'on-time';
              ELSE
                SET NEW.status = 'late';
              END IF;
            END IF;
          END IF;
        ELSE
          SET NEW.attendance_slot = NULL;
          SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time));
        END IF;
      END
    `);

    await pool.query("DROP TRIGGER IF EXISTS attendance_before_update_slot");
    await pool.query(`
      CREATE TRIGGER attendance_before_update_slot
      BEFORE UPDATE ON attendance
      FOR EACH ROW
      BEGIN
        DECLARE configured_morning_start TIME DEFAULT '08:00:00';
        DECLARE configured_morning_end TIME DEFAULT '11:59:00';
        DECLARE configured_afternoon_start TIME DEFAULT '13:00:00';
        DECLARE configured_afternoon_end TIME DEFAULT '17:00:00';
        DECLARE configured_morning_grace INT DEFAULT 0;
        DECLARE configured_afternoon_grace INT DEFAULT 0;
        DECLARE configured_on_time_until TIME DEFAULT NULL;

        DECLARE emp_dept VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NEW.department;
        DECLARE dept_m_start TIME DEFAULT NULL;
        DECLARE dept_m_end TIME DEFAULT NULL;
        DECLARE dept_a_start TIME DEFAULT NULL;
        DECLARE dept_a_end TIME DEFAULT NULL;
        DECLARE dept_on_time_until TIME DEFAULT NULL;
        DECLARE dept_has_custom INT DEFAULT 0;

        -- 1. Load global settings
        SELECT COALESCE(morning_start, '08:00:00'),
               COALESCE(morning_end, '11:59:00'),
               COALESCE(afternoon_start, '13:00:00'),
               COALESCE(afternoon_end, '17:00:00'),
               COALESCE(morning_grace_minutes, 0),
               COALESCE(afternoon_grace_minutes, 0)
          INTO configured_morning_start, configured_morning_end, configured_afternoon_start, configured_afternoon_end, configured_morning_grace, configured_afternoon_grace
          FROM settings ORDER BY id LIMIT 1;

        -- 2. Resolve department if not specified on the record
        IF (emp_dept IS NULL OR emp_dept = '') AND NEW.person_id IS NOT NULL THEN
          SELECT department INTO emp_dept FROM persons WHERE id = NEW.person_id LIMIT 1;
          IF emp_dept IS NOT NULL AND (NEW.department IS NULL OR NEW.department = '') THEN
            SET NEW.department = emp_dept;
          END IF;
        END IF;

        -- 3. Check for department-specific attendance workhours (e.g. UTILITY: 7:00 AM start, 7:00-8:00 AM on-time)
        IF emp_dept IS NOT NULL AND emp_dept != '' THEN
          SELECT morning_start, morning_end, afternoon_start, afternoon_end, on_time_until, COALESCE(has_custom_workhours, 0)
            INTO dept_m_start, dept_m_end, dept_a_start, dept_a_end, dept_on_time_until, dept_has_custom
            FROM department_rates
           WHERE department = emp_dept LIMIT 1;

          IF dept_has_custom = 1 OR dept_m_start IS NOT NULL THEN
            IF dept_m_start IS NOT NULL THEN
              SET configured_morning_start = dept_m_start;
            END IF;
            IF dept_m_end IS NOT NULL THEN
              SET configured_morning_end = dept_m_end;
            END IF;
            IF dept_a_start IS NOT NULL THEN
              SET configured_afternoon_start = dept_a_start;
            END IF;
            IF dept_a_end IS NOT NULL THEN
              SET configured_afternoon_end = dept_a_end;
            END IF;
            IF dept_on_time_until IS NOT NULL THEN
              SET configured_on_time_until = dept_on_time_until;
            END IF;
          END IF;
        END IF;

        IF TIME(NEW.device_time) < '03:00:00' THEN
          SET NEW.event = 'time-out';
          SET NEW.attendance_slot = 'afternoon_time_out';
          SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time - INTERVAL 1 DAY));
          SET NEW.status = 'overtime';
        ELSEIF NEW.event = 'time-out' OR TIME(NEW.device_time) > configured_morning_end THEN
          SET NEW.event = 'time-out';
          SET NEW.attendance_slot = 'afternoon_time_out';
          SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time));
          IF NEW.status IS NULL OR NEW.status = '' OR NEW.status = OLD.status OR OLD.event != 'time-out' OR NEW.status = 'present' OR NEW.status = 'on-time' THEN
            IF TIME(NEW.device_time) < configured_afternoon_end THEN
              SET NEW.status = 'early-out';
            ELSEIF TIME(NEW.device_time) >= ADDTIME(configured_afternoon_end, SEC_TO_TIME((configured_afternoon_grace + 1) * 60)) THEN
              SET NEW.status = 'overtime';
            ELSE
              SET NEW.status = 'on-time';
            END IF;
          END IF;
        ELSEIF TIME(NEW.device_time) <= configured_morning_end THEN
          SET NEW.event = 'time-in';
          SET NEW.attendance_slot = 'morning_time_in';
          SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time));
          IF NEW.status IS NULL OR NEW.status = '' OR NEW.status = OLD.status OR OLD.event != 'time-in' OR NEW.status = 'present' OR NEW.status = 'on-time' THEN
            IF configured_on_time_until IS NOT NULL THEN
              -- Department-specific on-time window (e.g. UTILITY: 7:00 - 8:00 AM)
              IF TIME(NEW.device_time) < configured_morning_start THEN
                SET NEW.status = 'early-in';
              ELSEIF TIME(NEW.device_time) <= ADDTIME(configured_on_time_until, SEC_TO_TIME((configured_morning_grace + 1) * 60 - 1)) THEN
                SET NEW.status = 'on-time';
              ELSE
                SET NEW.status = 'late';
              END IF;
            ELSE
              -- Global settings
              IF TIME(NEW.device_time) <= '07:30:59' AND TIME(NEW.device_time) < configured_morning_start THEN
                SET NEW.status = 'early-in';
              ELSEIF TIME(NEW.device_time) < ADDTIME(configured_morning_start, SEC_TO_TIME((configured_morning_grace + 1) * 60)) THEN
                SET NEW.status = 'on-time';
              ELSE
                SET NEW.status = 'late';
              END IF;
            END IF;
          END IF;
        ELSE
          SET NEW.attendance_slot = NULL;
          SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time));
        END IF;
      END
    `);
  } catch (e) {
    console.warn("Attendance trigger update warning:", e.message);
  }
})();

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// ==========================================
// DAHUA HELPER FUNCTIONS
// ==========================================
function parseDigestChallenge(header) {
  return Object.fromEntries(
    [...header.matchAll(/([a-z]+)=(?:"([^"]*)"|([^,]+))/gi)].map((match) => [
      match[1].toLowerCase(),
      match[2] || match[3].trim(),
    ])
  );
}

function digestResponse(method, requestPath, challenge) {
  const ha1 = crypto.createHash("md5").update(`${DAHUA_USERNAME}:${challenge.realm}:${DAHUA_PASSWORD}`).digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${requestPath}`).digest("hex");
  const qop = challenge.qop && challenge.qop.split(",")[0].trim();
  const cnonce = crypto.randomBytes(16).toString("hex");
  const nonceCount = "00000001";
  if (qop) {
    const response = crypto.createHash("md5").update(`${ha1}:${challenge.nonce}:${nonceCount}:${cnonce}:${qop}:${ha2}`).digest("hex");
    return { response, cnonce, nonceCount, qop };
  }
  return crypto.createHash("md5").update(`${ha1}:${challenge.nonce}:${ha2}`).digest("hex");
}

function requestDahua(requestPath, method = "GET", authorization = null, body = null) {
  const transport = DAHUA_DEVICE_PORT === 443 ? https : http;
  return new Promise((resolve, reject) => {
    const requestBody = body == null ? null : JSON.stringify(body);
    const request = transport.request(
      {
        hostname: DAHUA_DEVICE_IP,
        port: DAHUA_DEVICE_PORT,
        path: requestPath,
        method,
        timeout: DAHUA_REQUEST_TIMEOUT_MS,
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          ...(requestBody ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(requestBody) } : {}),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ response, body }));
      }
    );
    request.on("timeout", () => {
      const target = `${DAHUA_DEVICE_IP}:${DAHUA_DEVICE_PORT}`;
      const isPrivateLanAddress = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(DAHUA_DEVICE_IP);
      const networkHint = isPrivateLanAddress
        ? " This is a private LAN address; a cPanel server cannot reach it unless cPanel is connected to the same LAN or VPN. Run the local connector on the Dahua network, or configure a publicly reachable/VPN endpoint."
        : " Check that the Dahua endpoint is reachable from this server and that the port is open.";
      request.destroy(new Error(`Dahua request timed out connecting to ${target}.${networkHint}`));
    });
    request.on("error", reject);
    request.end(requestBody);
  });
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

async function requestDahuaJsonWithDigest(requestPath, method, payload) {
  const first = await requestDahua(requestPath, method, null, payload);
  if (first.response.statusCode !== 401) {
    if (first.response.statusCode < 200 || first.response.statusCode >= 300) throw new Error(`Dahua RPC request failed with HTTP ${first.response.statusCode}.`);
    return first;
  }
  const challengeHeader = first.response.headers["www-authenticate"];
  if (!challengeHeader) throw new Error("Dahua device did not provide authentication details.");
  const challenge = parseDigestChallenge(challengeHeader);
  const digest = digestResponse(method, requestPath, challenge);
  const fields = [
    `username="${DAHUA_USERNAME}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${requestPath}"`,
    `response="${digest.response || digest}"`,
  ];
  if (digest.qop) fields.push(`qop=${digest.qop}`, `nc=${digest.nonceCount}`, `cnonce="${digest.cnonce}"`);
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) fields.push(`algorithm=${challenge.algorithm}`);

  const authenticated = await requestDahua(requestPath, method, `Digest ${fields.join(", ")}`, payload);
  if (authenticated.response.statusCode < 200 || authenticated.response.statusCode >= 300) {
    const details = authenticated.body && authenticated.body.trim();
    throw new Error(`Dahua RPC request failed with HTTP ${authenticated.response.statusCode}${details ? `: ${details}` : "."}`);
  }
  return authenticated;
}

async function getDahuaUsers(requestedUserIds = null) {
  // Use connector if available
  if (USE_LOCAL_CONNECTOR) {
    return await getDahuaUsersViaConnector(requestedUserIds);
  }

  const firstLogin = await requestDahuaJsonWithDigest("/RPC2_Login", "POST", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: "", clientType: "Web3.0" },
    id: 1,
  });
  const firstData = JSON.parse(firstLogin.body || "{}");
  const loginParams = firstData.params || {};
  const passwordHash = md5(`${DAHUA_USERNAME}:${loginParams.realm}:${DAHUA_PASSWORD}`);
  const loginPassword = passwordHash.toUpperCase();
  const session = firstData.session || 0;
  const secondLogin = await requestDahuaJsonWithDigest("/RPC2_Login", "POST", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: loginPassword, clientType: "Web3.0", authorityType: "Default" },
    id: 2,
    session,
  });
  const secondData = JSON.parse(secondLogin.body || "{}");
  const activeSession = secondData.session || session;
  const users = [];
  const batches = requestedUserIds
    ? Array.from({ length: Math.ceil(requestedUserIds.length / 10) }, (_, index) => requestedUserIds.slice(index * 10, index * 10 + 10))
    : Array.from({ length: 100 }, (_, index) => Array.from({ length: 10 }, (_, offset) => String(index * 10 + offset + 1)));
  for (const userIds of batches) {
    const usersResponse = await requestDahuaJsonWithDigest("/RPC2", "POST", {
      method: "AccessUser.list",
      params: { UserIDList: userIds },
      id: users.length + 3,
      session: activeSession,
    });
    const usersData = JSON.parse(usersResponse.body || "{}");
    const batch = usersData?.params?.Users || usersData?.error?.detail?.Users || [];
    users.push(...batch.filter(Boolean));
  }

  // Also fetch enrolled face photos from Dahua AccessFace.list
  if (users.length > 0) {
    const allUserIds = users.map((u) => String(u.UserID || u.id)).filter(Boolean);
    const photoMap = {};
    for (let i = 0; i < allUserIds.length; i += 10) {
      const chunk = allUserIds.slice(i, i + 10);
      try {
        const faceRes = await requestDahuaJsonWithDigest("/RPC2", "POST", {
          method: "AccessFace.list",
          params: { UserIDList: chunk },
          id: users.length + 100 + i,
          session: activeSession,
        });
        const parsed = JSON.parse(faceRes.body || "{}");
        const faceList = parsed?.params?.FaceDataList || parsed?.error?.detail?.FaceDataList || [];
        for (const item of faceList) {
          if (item && item.UserID && Array.isArray(item.PhotoData) && item.PhotoData.length > 0) {
            const b64 = item.PhotoData[0];
            if (b64 && typeof b64 === "string" && b64.length > 50) {
              photoMap[String(item.UserID)] = b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
            }
          }
        }
      } catch (e) {}
    }
    for (const u of users) {
      const uid = String(u.UserID || u.id);
      if (photoMap[uid]) {
        u.registration_photo = photoMap[uid];
      }
    }
  }

  return users;
}

async function requestDahuaWithDigest(requestPath) {
  const first = await requestDahua(requestPath);
  if (first.response.statusCode !== 401) return first.body;
  const challengeHeader = first.response.headers["www-authenticate"];
  const challenge = parseDigestChallenge(challengeHeader);
  const digest = digestResponse("GET", requestPath, challenge);
  const fields = [
    `username="${DAHUA_USERNAME}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${requestPath}"`,
    `response="${digest.response || digest}"`,
  ];
  if (digest.qop) fields.push(`qop=${digest.qop}`, `nc=${digest.nonceCount}`, `cnonce="${digest.cnonce}"`);
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) fields.push(`algorithm=${challenge.algorithm}`);
  const authorization = `Digest ${fields.join(", ")}`;
  const authenticated = await requestDahua(requestPath, "GET", authorization);
  return authenticated.body;
}

function parseDahuaRows(body) {
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^(?:records|users)\[(\d+)\]\.([^=]+)=(.*)$/);
    if (!match) continue;
    const [, index, field, value] = match;
    rows[index] = rows[index] || {};
    rows[index][field] = value.trim();
  }
  return rows.filter(Boolean);
}

function firstValue(row, names) {
  return names.map((name) => row[name]).find((value) => value !== undefined && value !== "") || null;
}

function errorMessage(error, fallback = "Unknown error") {
  if (error instanceof Error && error.message) return error.message;
  const connectionError = error?.code === "ECONNREFUSED" ? error : error?.errors?.find((item) => item?.code === "ECONNREFUSED");
  if (connectionError?.code === "ECONNREFUSED") {
    const target = connectionError.address && connectionError.port ? ` ${connectionError.address}:${connectionError.port}` : "";
    return `Database connection was refused${target}. Check DB_HOST, DB_PORT, and that the Database service is running.`;
  }
  if (typeof error === "string" && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : fallback;
  } catch (serializationError) {
    return fallback;
  }
}

function normalizeDahuaDeviceTime(value, targetTimezone = process.env.DAHUA_TIMEZONE || "Asia/Manila") {
  if (!value) return null;
  const text = String(value).trim();
  const pad = (n) => String(n).padStart(2, "0");

  const numeric = Number(text);
  if (/^\d{10,13}$/.test(text)) {
    const ms = text.length === 10 ? numeric * 1000 : numeric;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;

    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: targetTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const parts = Object.fromEntries(
        formatter.formatToParts(d).map((p) => [p.type, p.value])
      );
      const hourStr = parts.hour === "24" ? "00" : parts.hour;
      return `${parts.year}-${parts.month}-${parts.day} ${hourStr}:${parts.minute}:${parts.second}`;
    } catch (e) {
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  }

  const normalizedText = text.replace(/[\/]/g, "-");
  const match = normalizedText.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}-${pad(match[2])}-${pad(match[3])} ${pad(match[4])}:${match[5]}:${match[6]}`;
  }

  const parsed = new Date(normalizedText);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: targetTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = Object.fromEntries(
      formatter.formatToParts(parsed).map((p) => [p.type, p.value])
    );
    const hourStr = parts.hour === "24" ? "00" : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day} ${hourStr}:${parts.minute}:${parts.second}`;
  } catch (e) {
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
  }
}

function mapDahuaAttendanceEvent(record) {
  const type = String(firstValue(record, ["Type", "type"]) || "").toLowerCase();
  if (type.includes("exit") || type.includes("out") || type.includes("leave")) return "time-out";
  return "time-in";
}

function mapDahuaAttendanceMethod(value) {
  const method = String(value || "").toLowerCase();
  const methods = { "15": "face", "21": "fingerprint", "3": "card", "4": "password" };
  return methods[method] || (method || "device");
}

function parseHHMMToMinutes(value, fallback = 0) {
  if (!value || typeof value !== "string") return fallback;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
  return hours * 60 + minutes;
}

function getPreviousDateStr(dateStr) {
  if (!dateStr) return dateStr;
  const [y, m, d] = dateStr.split("-").map(Number);
  const prev = new Date(y, m - 1, d - 1);
  const py = prev.getFullYear();
  const pm = String(prev.getMonth() + 1).padStart(2, "0");
  const pd = String(prev.getDate()).padStart(2, "0");
  return `${py}-${pm}-${pd}`;
}

function getWorkDateFromDeviceTime(deviceTime, event = null) {
  const match = String(deviceTime).match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return String(deviceTime).slice(0, 10);
  const dateStr = match[1];
  const hour = Number(match[2]);
  if (hour < 3) {
    return getPreviousDateStr(dateStr);
  }
  return dateStr;
}

function dedupeDahuaAttendanceByPersonDay(records, settings = null) {
  const safeRecords = (records || []).filter((record) => record && record.person_id && record.device_time);
  if (!safeRecords.length) return [];

  const morningStart = parseHHMMToMinutes(settings?.morning_start || "08:00", 8 * 60);
  const morningEnd = parseHHMMToMinutes(settings?.morning_end || "11:59", 11 * 60 + 59);
  const afternoonStart = parseHHMMToMinutes(settings?.afternoon_start || "13:00", 13 * 60);
  const afternoonEnd = parseHHMMToMinutes(settings?.afternoon_end || "17:00", 17 * 60);
  const morningGrace = Number.isFinite(Number(settings?.morning_grace_minutes))
    ? Number(settings.morning_grace_minutes)
    : 0;
  const afternoonGrace = Number.isFinite(Number(settings?.afternoon_grace_minutes))
    ? Number(settings.afternoon_grace_minutes)
    : 0;

  // Helper: extract HH:MM minutes from a local time string "YYYY-MM-DD HH:MM:SS"
  function minutesFromLocalTime(deviceTime) {
    const match = String(deviceTime).match(/(\d{2}):(\d{2}):(\d{2})$/);
    if (match) return Number(match[1]) * 60 + Number(match[2]);
    // Fallback for unexpected formats
    const d = new Date(deviceTime);
    return Number.isNaN(d.getTime()) ? -1 : d.getHours() * 60 + d.getMinutes();
  }

  // Helper: extract date portion "YYYY-MM-DD" from a local time string
  function dateFromLocalTime(deviceTime) {
    const match = String(deviceTime).match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }

  const byPersonDay = new Map();
  for (const record of safeRecords) {
    const dateStr = dateFromLocalTime(record.device_time);
    if (!dateStr) continue;
    const mins = minutesFromLocalTime(record.device_time);
    if (mins < 0) continue;

    // Assign event and status by time window
    let event;
    let status;
    let targetDateStr = dateStr;
    let effectiveMins = mins;

    // Overnight checkout past midnight (< 03:00 AM) always applies to PREVIOUS day's afternoon out overtime
    if (mins < 3 * 60) {
      event = "time-out";
      status = "overtime";
      targetDateStr = getPreviousDateStr(dateStr);
      effectiveMins = 24 * 60 + mins;
    } else if (mins <= morningEnd) {
      // 03:00 AM to morningEnd: Morning shift time-in (Early-in starting at 3:00 AM to 7:00 AM)
      event = "time-in";
      if (mins >= 3 * 60 && mins <= 7 * 60 + 30 && mins < morningStart) {
        status = "early-in";
      } else if (mins <= morningStart + morningGrace) {
        status = "on-time";
      } else {
        status = "late";
      }
    } else {
      // Any scan after morningEnd (> 11:59 AM) is a time-out
      event = "time-out";
      if (mins < afternoonEnd) {
        status = "early-out";
      } else if (mins > afternoonEnd + afternoonGrace) {
        status = "overtime";
      } else {
        status = "on-time";
      }
    }

    const dateKey = `${record.person_id}|${targetDateStr}`;
    const bucket = byPersonDay.get(dateKey) || [];
    bucket.push({
      ...record,
      _dateStr: targetDateStr,
      _minutes: effectiveMins,
      event,
      status,
    });
    byPersonDay.set(dateKey, bucket);
  }

  const finalRecords = [];
  for (const bucket of byPersonDay.values()) {
    // Morning In: FIRST scan in the morning window (earliest time)
    const morningInCandidates = bucket
      .filter((record) => record.event === "time-in")
      .sort((a, b) => a._minutes - b._minutes);

    // Afternoon Out: LAST scan in the afternoon window (latest time)
    const afternoonOutCandidates = bucket
      .filter((record) => record.event === "time-out")
      .sort((a, b) => a._minutes - b._minutes);

    const morningIn = morningInCandidates[0];
    let afternoonOut = afternoonOutCandidates.length ? afternoonOutCandidates[afternoonOutCandidates.length - 1] : null;

    // If the employee has 2+ morning scans (e.g. 05:54 AM in and 10:00 AM out) and no afternoon out scan,
    // treat the last morning scan as their Time Out (Early Out) so it isn't lost or overwritten.
    if (!afternoonOut && morningInCandidates.length >= 2) {
      const lastMorningScan = morningInCandidates[morningInCandidates.length - 1];
      if (lastMorningScan._minutes - morningIn._minutes >= 5) {
        afternoonOut = {
          ...lastMorningScan,
          event: "time-out",
          status: "early-out",
        };
      }
    }

    if (morningIn) finalRecords.push(morningIn);
    if (afternoonOut) finalRecords.push(afternoonOut);
  }

  return finalRecords;
}

async function getSettingsRow() {
  const [rows] = await pool.query("SELECT * FROM settings ORDER BY id LIMIT 1");
  return rows[0] || null;
}

async function generatePayrollPeriodsFromAttendance(attendanceRows = []) {
  if (!Array.isArray(attendanceRows) || !attendanceRows.length) {
    const [allAttendance] = await pool.query(
      "SELECT * FROM attendance WHERE archived = 0 ORDER BY device_time ASC"
    );
    attendanceRows = allAttendance;
  }

  if (!attendanceRows.length) return { created: 0, updated: 0 };

  const settings = await getSettingsRow();
  const periodDays = Number(settings?.payroll_period_days || 15);
  const uniquePersonIds = [...new Set(attendanceRows.map((row) => row.person_id).filter(Boolean))];
  if (!uniquePersonIds.length) return { created: 0, updated: 0 };

  const [personsRows] = await pool.query(
    "SELECT * FROM persons WHERE id IN (?) ORDER BY name ASC",
    [uniquePersonIds]
  );
  const personById = new Map(personsRows.map((person) => [person.id, person]));

  let created = 0;
  let updated = 0;

  for (const personId of uniquePersonIds) {
    const person = personById.get(personId);
    if (!person) continue;

    const [rows] = await pool.query(
      "SELECT * FROM attendance WHERE person_id = ? AND archived = 0 ORDER BY device_time ASC",
      [personId]
    );
    if (!rows.length) continue;

    const [historyRows] = await pool.query(
      "SELECT period FROM payroll_released_history WHERE person_id = ?",
      [personId]
    );
    const releasedPeriods = new Set(historyRows.map(r => r.period));

    const earliestDate = new Date(rows[0].device_time);
    const latestDate = new Date(rows[rows.length - 1].device_time);
    let cursor = new Date(earliestDate);
    cursor.setHours(0, 0, 0, 0);

    while (cursor <= latestDate) {
      const periodEnd = new Date(cursor);
      periodEnd.setDate(periodEnd.getDate() + periodDays - 1);
      periodEnd.setHours(23, 59, 59, 999);

      const periodStartYmd = cursor.toISOString().slice(0, 10);
      const periodEndYmd = periodEnd.toISOString().slice(0, 10);
      const periodKey = `${periodStartYmd}_to_${periodEndYmd}`;

      if (releasedPeriods.has(periodKey)) {
        cursor.setDate(cursor.getDate() + periodDays);
        continue;
      }

      const periodAttendance = rows.filter((record) => {
        const dt = new Date(record.device_time);
        return dt >= cursor && dt <= periodEnd;
      });

      if (periodAttendance.length) {
        const uniqueDates = new Set(
          periodAttendance
            .map((record) => record.attendance_work_date ? String(record.attendance_work_date).slice(0, 10) : getWorkDateFromDeviceTime(record.device_time))
            .filter(Boolean)
        );

        const morningStart = Number((settings?.morning_start || "08:00").split(":")[0] || 8) * 60 + Number((settings?.morning_start || "08:00").split(":")[1] || 0);
        const morningGrace = Number.isFinite(Number(settings?.morning_grace_minutes))
          ? Number(settings.morning_grace_minutes)
          : 0;
        const afternoonStart = Number((settings?.afternoon_start || "13:00").split(":")[0] || 13) * 60 + Number((settings?.afternoon_start || "13:00").split(":")[1] || 0);
        const afternoonGrace = Number(settings?.afternoon_grace_minutes || 15);
        const afternoonEnd = Number((settings?.afternoon_end || "17:00").split(":")[0] || 17) * 60 + Number((settings?.afternoon_end || "17:00").split(":")[1] || 0);

        const lateBaseFee = Number(settings?.late_base_fee ?? 40);
        const latePerMinuteFee = Number(settings?.late_per_minute_fee ?? 1);

        let lateCount = 0;
        let totalLateDeduction = 0;
        let daysPresent = 0;
        
        for (const dateKey of uniqueDates) {
          const byDate = periodAttendance.filter((record) => {
            const wDate = record.attendance_work_date ? String(record.attendance_work_date).slice(0, 10) : getWorkDateFromDeviceTime(record.device_time);
            return wDate === dateKey;
          });
          byDate.sort((a, b) => new Date(a.device_time) - new Date(b.device_time));
          const morningRecord = byDate.find((record) => {
            const h = new Date(record.device_time).getHours();
            return h >= 3 && h < 12;
          }) || null;
          const afternoonRecord = [...byDate].reverse().find((record) => {
            const h = new Date(record.device_time).getHours();
            return h < 3 || h >= 12;
          }) || null;

          // Only count the day as present if they have BOTH morning in and afternoon out
          if (morningRecord && afternoonRecord) {
            daysPresent += 1;
            
            // Only apply late penalties for days they are actually paid for
            const morningDt = new Date(morningRecord.device_time);
            const morningMinutes = morningDt.getHours() * 60 + morningDt.getMinutes();
            if (morningMinutes > morningStart + morningGrace) {
              lateCount += 1;
              const minsLate = Math.max(1, morningMinutes - morningStart);
              totalLateDeduction += lateBaseFee + minsLate * latePerMinuteFee;
            }
          }
        }

        const departmentRate = await pool.query(
          "SELECT * FROM department_rates WHERE department = ? LIMIT 1",
          [person.department || ""]
        );
        const rate = departmentRate[0]?.[0] || {};
        const dailyRate = Number(person.daily_rate ?? rate.daily_rate ?? 0);
        const latePenalty = Number(person.late_penalty ?? rate.late_penalty ?? lateBaseFee);
        const sss = Number(rate.sss ?? 0);
        const pagIbig = Number(rate.pag_ibig ?? 0);
        const philhealth = Number(rate.philhealth ?? 0);
        const cashAdvance = Number(person.cash_advance ?? 0);

        totalLateDeduction = Number(totalLateDeduction.toFixed(2));
        const totalDeductions = sss + pagIbig + philhealth + cashAdvance + totalLateDeduction;
        const gross = dailyRate * daysPresent;
        let net = gross - totalDeductions;
        
        // Prevent negative net pay
        if (net < 0) net = 0;

        const payload = {
          person_id: person.id,
          period: periodKey,
          days_present: Number(daysPresent || 0),
          daily_rate: Number(dailyRate || 0),
          late_penalty: Number(latePenalty || 0),
          late_count: Number(lateCount || 0),
          gross: Number(gross || 0),
          total_late_deduction: Number(totalLateDeduction || 0),
          total_deductions: Number(totalDeductions || 0),
          net: Number(net || 0),
          released: 0,
        };

        const [result] = await pool.query(
          `INSERT INTO payroll_periods
            (id, person_id, period, days_present, daily_rate, late_penalty, late_count, gross, total_late_deduction, total_deductions, net, released, created_at, updated_at)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
            days_present = VALUES(days_present),
            daily_rate = VALUES(daily_rate),
            late_penalty = VALUES(late_penalty),
            late_count = VALUES(late_count),
            gross = VALUES(gross),
            total_late_deduction = VALUES(total_late_deduction),
            total_deductions = VALUES(total_deductions),
            net = VALUES(net),
            updated_at = NOW()`,
          [
            payload.person_id,
            payload.period,
            payload.days_present,
            payload.daily_rate,
            payload.late_penalty,
            payload.late_count,
            payload.gross,
            payload.total_late_deduction,
            payload.total_deductions,
            payload.net,
            payload.released,
          ]
        );

        if (result && result.affectedRows) {
          if (result.insertId || result.warningStatus === 0) {
            created += 1;
          } else {
            updated += 1;
          }
        }
      }

      cursor.setDate(cursor.getDate() + periodDays);
    }
  }

  return { created, updated };
}

async function regeneratePayrollPeriodsIfNeeded() {
  try {
    const result = await generatePayrollPeriodsFromAttendance();
    if (result.created || result.updated) {
      console.log(`[Payroll] Generated payroll periods: created=${result.created}, updated=${result.updated}`);
    }
  } catch (error) {
    console.error("[Payroll] Auto-generation failed:", error.message);
  }
}

// ==========================================
// LOCAL CONNECTOR HELPER FUNCTIONS
// ==========================================
// These functions route Dahua requests through the local connector if configured

async function requestDahuaViaConnector(method, path, payload = null) {
  if (!USE_LOCAL_CONNECTOR) throw new Error("Local connector not configured");
  
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      path,
      method,
      payload,
    });

    const parsedUrl = new URL(DAHUA_CONNECTOR_URL);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    
    const request = transport.request(
      {
        method: "POST",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: "/dahua/rpc",
        timeout: DAHUA_REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            const result = JSON.parse(body || "{}");
            resolve(result);
          } catch (e) {
            reject(new Error(`Invalid JSON response from connector: ${body}`));
          }
        });
      }
    );
    
    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`Connector request timed out after ${DAHUA_REQUEST_TIMEOUT_MS}ms`));
    });
    
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

async function requestDahuaGetViaConnector(path) {
  if (!USE_LOCAL_CONNECTOR) throw new Error("Local connector not configured");
  
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(DAHUA_CONNECTOR_URL);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const fullPath = `/dahua/get?path=${encodeURIComponent(path)}`;
    
    const request = transport.request(
      {
        method: "GET",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: fullPath,
        timeout: DAHUA_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(body));
      }
    );
    
    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`Connector GET request timed out after ${DAHUA_REQUEST_TIMEOUT_MS}ms`));
    });
    
    request.on("error", reject);
    request.end();
  });
}

async function getDahuaUsersViaConnector(requestedUserIds = null) {
  const firstLogin = await requestDahuaViaConnector("POST", "/RPC2_Login", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: "", clientType: "Web3.0" },
    id: 1,
  });
  if (!firstLogin.success) throw new Error(firstLogin.error || "Failed to login to Dahua via connector");
  
  const firstData = JSON.parse(firstLogin.body || "{}");
  const loginParams = firstData.params || {};
  const passwordHash = md5(`${DAHUA_USERNAME}:${loginParams.realm}:${DAHUA_PASSWORD}`);
  const loginPassword = passwordHash.toUpperCase();
  const session = firstData.session || 0;
  
  const secondLogin = await requestDahuaViaConnector("POST", "/RPC2_Login", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: loginPassword, clientType: "Web3.0", authorityType: "Default" },
    id: 2,
    session,
  });
  if (!secondLogin.success) throw new Error(secondLogin.error || "Failed to authenticate with Dahua via connector");
  
  const secondData = JSON.parse(secondLogin.body || "{}");
  const activeSession = secondData.session || session;
  const users = [];
  
  const batches = requestedUserIds
    ? Array.from({ length: Math.ceil(requestedUserIds.length / 10) }, (_, index) => requestedUserIds.slice(index * 10, index * 10 + 10))
    : Array.from({ length: 100 }, (_, index) => Array.from({ length: 10 }, (_, offset) => String(index * 10 + offset + 1)));
  
  for (const userIds of batches) {
    const usersResponse = await requestDahuaViaConnector("POST", "/RPC2", {
      method: "AccessUser.list",
      params: { UserIDList: userIds },
      id: users.length + 3,
      session: activeSession,
    });
    if (!usersResponse.success) throw new Error(usersResponse.error || "Failed to get users from Dahua via connector");
    
    const usersData = JSON.parse(usersResponse.body || "{}");
    const batch = usersData?.params?.Users || usersData?.error?.detail?.Users || [];
    users.push(...batch.filter(Boolean));
  }
  return users;
}

// ==========================================
// PASSWORD HASHING & AUTH HELPERS
// ==========================================

/** Return true if value is already a standard bcrypt ($2a$/$2b$/$2y$) hash. */
function isBcryptHash(value) {
  return typeof value === "string" && BCRYPT_HASH_REGEX.test(value);
}

/** Validate plaintext password length and bcrypt 72-byte UTF-8 ceiling. */
function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.trim().length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (Buffer.byteLength(password, "utf8") > 72) {
    return "Password must not exceed 72 bytes.";
  }
  return null;
}

/** Hash a plaintext password with bcryptjs using BCRYPT_SALT_ROUNDS. */
async function hashPassword(plainPassword) {
  return bcrypt.hash(String(plainPassword), BCRYPT_SALT_ROUNDS);
}

/** Constant-time equality check used strictly for migrating legacy plaintext passwords. */
function timingSafePlaintextEquals(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Verify candidate password against stored hash (or legacy plaintext when migration is enabled). */
async function verifyUserPassword(plainPassword, storedPassword) {
  if (!plainPassword || !storedPassword || typeof plainPassword !== "string") {
    return { valid: false, needsRehash: false };
  }
  const stored = String(storedPassword);
  if (isBcryptHash(stored)) {
    const valid = await bcrypt.compare(plainPassword, stored);
    return { valid, needsRehash: false };
  }
  if (ALLOW_LEGACY_PLAINTEXT_UPGRADE) {
    const valid = timingSafePlaintextEquals(plainPassword, stored);
    return { valid, needsRehash: valid };
  }
  return { valid: false, needsRehash: false };
}

/** Look up a person record by id or trimmed email for auth/profile endpoints. */
async function findPersonForAuth({ userId, email }) {
  if (userId) {
    const [rows] = await pool.query("SELECT * FROM persons WHERE id = ? LIMIT 1", [userId]);
    return rows[0] || null;
  }
  if (email) {
    const [rows] = await pool.query("SELECT * FROM persons WHERE email = ? LIMIT 1", [String(email).trim()]);
    return rows[0] || null;
  }
  return null;
}

/** Require and verify currentPassword whenever changing an existing account password. */
async function verifyCurrentPasswordForChange(user, currentPassword) {
  if (!user.password) {
    return { ok: false, message: "Account password is not initialized. Contact an administrator." };
  }
  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    return { ok: false, message: "Current password is required." };
  }
  const { valid } = await verifyUserPassword(currentPassword, user.password);
  if (!valid) {
    return { ok: false, message: "Current password does not match our records." };
  }
  return { ok: true, message: null };
}

// ==========================================
// SERVER-SIDE JWT AUTH & RBAC MIDDLEWARE
// ==========================================
const EPHEMERAL_DEV_AUTH_SECRET = crypto.randomBytes(32).toString("hex");
const EPHEMERAL_DEV_FACE_SECRET = crypto.randomBytes(32).toString("hex");
const STAFF_TOKEN_TTL_SECONDS = Math.max(300, Number(process.env.AUTH_TOKEN_TTL_SECONDS || 12 * 3600) || 12 * 3600);
const VALID_STAFF_ROLES = new Set(["admin"]);
const AUTH_CACHE_TTL_MS = 5000;
const authUserCache = new Map();
const authRateLimits = new Map();

function isProductionEnv() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function getAuthTokenSecret() {
  const configured = String(process.env.AUTH_TOKEN_SECRET || process.env.JWT_SECRET || "").trim();
  if (configured) return configured;
  return isProductionEnv() ? null : EPHEMERAL_DEV_AUTH_SECRET;
}

function getFaceTokenSecret() {
  const configured = String(process.env.FACE_TOKEN_SECRET || "").trim();
  if (configured) return configured;
  return isProductionEnv() ? null : EPHEMERAL_DEV_FACE_SECRET;
}

function getSyncServiceSecret() {
  return String(process.env.SYNC_SERVICE_TOKEN || process.env.ATTENDANCE_IMPORT_TOKEN || "").trim();
}

function normalizeStaffRole(rawRole) {
  const normalized = String(rawRole || "").trim().toLowerCase();
  return VALID_STAFF_ROLES.has(normalized) ? normalized : null;
}

function isAccountActive(user) {
  if (!user) return false;
  if (user.archived === 1 || user.archived === true) return false;
  if (user.approved === 0 || user.approved === false) return false;
  return true;
}

function clearAuthUserCache(userId = null) {
  if (userId) {
    authUserCache.delete(String(userId));
  } else {
    authUserCache.clear();
  }
}

function buildSessionUser(user) {
  const role = normalizeStaffRole(user.role) || user.role || "employee";
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    department: user.department,
    role,
    user_metadata: {
      role,
      name: user.name,
    },
    app_metadata: {
      role,
    },
  };
}

/** Mint compact HS256 staff session JWT signed with AUTH_TOKEN_SECRET. */
function signStaffJwt(user) {
  const secret = getAuthTokenSecret();
  if (!secret) {
    throw new Error("AUTH_TOKEN_SECRET is required in production.");
  }
  const role = normalizeStaffRole(user.role);
  if (!role) {
    throw new Error("Only active staff accounts can obtain session tokens.");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify({
    typ: "staff",
    sub: String(user.id),
    email: user.email || "",
    name: user.name || "",
    role,
    tv: Number(user.token_version || 1),
    jti: crypto.randomUUID(),
    iat: nowSec,
    exp: nowSec + STAFF_TOKEN_TTL_SECONDS,
  })).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sigB64}`;
}

/** Verify HS256 staff session JWT signature, structure, purpose, and expiration. */
function verifyStaffJwtToken(token) {
  const secret = getAuthTokenSecret();
  if (!secret) {
    return { valid: false, status: 503, code: "SERVER_MISCONFIGURED", error: "Server auth secret is not configured." };
  }
  if (!token || typeof token !== "string") {
    return { valid: false, status: 401, code: "TOKEN_MISSING", error: "Authentication token is required." };
  }
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { valid: false, status: 401, code: "TOKEN_MALFORMED", error: "Invalid token format." };
  }
  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch (e) {
    return { valid: false, status: 401, code: "TOKEN_MALFORMED", error: "Invalid token header." };
  }
  if (!header || header.alg !== "HS256" || header.typ !== "JWT") {
    return { valid: false, status: 401, code: "TOKEN_INVALID", error: "Unsupported token header." };
  }

  const expectedSig = crypto.createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url");
  const sigBuf = Buffer.from(sigB64);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, status: 401, code: "TOKEN_INVALID", error: "Invalid token signature." };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (e) {
    return { valid: false, status: 401, code: "TOKEN_MALFORMED", error: "Invalid token payload." };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload || payload.typ !== "staff" || !payload.sub || !VALID_STAFF_ROLES.has(payload.role)) {
    return { valid: false, status: 401, code: "TOKEN_INVALID", error: "Invalid session claims." };
  }
  if (!payload.exp || nowSec >= Number(payload.exp)) {
    return { valid: false, status: 401, code: "TOKEN_EXPIRED", error: "Session expired. Please sign in again." };
  }
  return { valid: true, payload };
}

function extractBearerToken(req) {
  const authHeader = req.headers?.authorization || "";
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const fallbackHeader = req.headers?.["x-auth-token"];
  if (typeof fallbackHeader === "string" && fallbackHeader.trim()) {
    return fallbackHeader.trim();
  }
  return null;
}

async function fetchActiveStaffRecord(userId) {
  const key = String(userId);
  const cached = authUserCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }
  const [rows] = await pool.query("SELECT * FROM persons WHERE id = ? LIMIT 1", [key]);
  const user = rows?.[0] || null;
  authUserCache.set(key, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  return user;
}

/** Validate incoming staff JWT against live DB record and token_version. */
async function resolveStaffSession(req) {
  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "Authentication required." };
  }
  const verified = verifyStaffJwtToken(token);
  if (!verified.valid) {
    return { ok: false, status: verified.status, code: verified.code, error: verified.error };
  }
  const dbUser = await fetchActiveStaffRecord(verified.payload.sub);
  if (!dbUser) {
    return { ok: false, status: 401, code: "TOKEN_REVOKED", error: "Account no longer exists." };
  }
  if (!isAccountActive(dbUser)) {
    return { ok: false, status: 403, code: "ACCOUNT_DISABLED", error: "Account is disabled or archived." };
  }
  const liveRole = normalizeStaffRole(dbUser.role);
  if (!liveRole || liveRole !== verified.payload.role) {
    return { ok: false, status: 401, code: "TOKEN_REVOKED", error: "Account privileges changed. Please sign in again." };
  }
  const liveTokenVersion = Number(dbUser.token_version || 1);
  if (liveTokenVersion !== Number(verified.payload.tv || 1)) {
    return { ok: false, status: 401, code: "TOKEN_REVOKED", error: "Session revoked. Please sign in again." };
  }
  return { ok: true, user: { ...dbUser, role: liveRole }, claims: verified.payload };
}

async function requireStaffAuth(req, res, next) {
  try {
    const resolved = await resolveStaffSession(req);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: { message: resolved.error, code: resolved.code } });
    }
    req.staffUser = resolved.user;
    req.staffClaims = resolved.claims;
    return next();
  } catch (err) {
    console.error("Auth verification error:", err.message);
    return res.status(500).json({ error: { message: "Authentication check failed." } });
  }
}

function requireAdmin(req, res, next) {
  return requireStaffAuth(req, res, () => {
    if (req.staffUser?.role !== "admin") {
      return res.status(403).json({ error: { message: "Administrator privileges required.", code: "FORBIDDEN" } });
    }
    return next();
  });
}

async function requireAdminOrServiceToken(req, res, next) {
  const clientServiceToken = String(req.headers["x-sync-token"] || req.headers["x-attendance-import-token"] || "").trim();
  if (clientServiceToken) {
    const expectedSecret = getSyncServiceSecret();
    if (!expectedSecret || !timingSafePlaintextEquals(clientServiceToken, expectedSecret)) {
      return res.status(401).json({ error: { message: "Invalid service sync token.", code: "INVALID_SERVICE_TOKEN" } });
    }
    req.isServiceClient = true;
    return next();
  }
  return requireAdmin(req, res, next);
}

function checkAuthRateLimit(ip, email = "") {
  const now = Date.now();
  const key = `${ip || "unknown"}:${String(email || "").trim().toLowerCase()}`;
  const entry = authRateLimits.get(key) || { count: 0, resetTime: now + 5 * 60 * 1000 };
  if (now > entry.resetTime) {
    entry.count = 1;
    entry.resetTime = now + 5 * 60 * 1000;
  } else {
    entry.count += 1;
  }
  authRateLimits.set(key, entry);
  return entry.count <= 30;
}

if (isProductionEnv() && (!process.env.AUTH_TOKEN_SECRET || !process.env.FACE_TOKEN_SECRET)) {
  console.error("[SECURITY WARNING] AUTH_TOKEN_SECRET and/or FACE_TOKEN_SECRET is unset while NODE_ENV=production. Protected token operations will fail closed until configured.");
}

// ==========================================
// AUTHENTICATION API ROUTES (MySQL)
// ==========================================
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || typeof password !== "string" || !password) {
    return res.status(400).json({ error: { message: "Email and password are required." } });
  }

  const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
  if (!checkAuthRateLimit(clientIp, email)) {
    return res.status(429).json({ error: { message: "Too many login attempts. Please wait a few minutes and try again." } });
  }

  if (!getAuthTokenSecret()) {
    return res.status(503).json({ error: { message: "Server authentication secret is not configured." } });
  }

  try {
    const [rows] = await pool.query(
      "SELECT * FROM persons WHERE email = ? LIMIT 1",
      [String(email).trim()]
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ error: { message: "Invalid email or password." } });
    }

    const user = rows[0];
    const { valid, needsRehash } = await verifyUserPassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: { message: "Invalid email or password." } });
    }

    if (!isAccountActive(user)) {
      return res.status(403).json({ error: { message: "Account is suspended or archived." } });
    }

    const staffRole = normalizeStaffRole(user.role);
    if (!staffRole) {
      return res.status(403).json({ error: { message: "This account does not have staff portal access." } });
    }

    if (needsRehash) {
      try {
        const upgradedHash = await hashPassword(password);
        await pool.query("UPDATE persons SET password = ? WHERE id = ?", [upgradedHash, user.id]);
      } catch (rehashErr) {
        console.warn("Legacy password rehash warning:", rehashErr.message);
      }
    }

    const sessionUser = buildSessionUser({ ...user, role: staffRole });
    const accessToken = signStaffJwt({ ...user, role: staffRole });
    const session = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: STAFF_TOKEN_TTL_SECONDS,
      user: sessionUser,
    };

    return res.json({ data: { user: sessionUser, session }, error: null });
  } catch (err) {
    console.error("Auth login error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Database login failed." } });
  }
});

app.get("/api/auth/session", requireStaffAuth, async (req, res) => {
  const sessionUser = buildSessionUser(req.staffUser);
  return res.json({ data: { user: sessionUser }, error: null });
});

app.post("/api/auth/logout", requireStaffAuth, async (req, res) => {
  try {
    await pool.query("UPDATE persons SET token_version = COALESCE(token_version, 1) + 1 WHERE id = ?", [req.staffUser.id]).catch(() => {});
    clearAuthUserCache(req.staffUser.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message || "Failed to log out cleanly." } });
  }
});

app.post("/api/auth/change-password", requireStaffAuth, async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body || {};
  if (userId && String(userId) !== String(req.staffUser.id)) {
    return res.status(403).json({ error: { message: "You can only change your own password." } });
  }
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    return res.status(400).json({ error: { message: strengthError } });
  }

  try {
    const user = await findPersonForAuth({ userId: req.staffUser.id });
    if (!user) {
      return res.status(404).json({ error: { message: "User account not found." } });
    }

    const verifyResult = await verifyCurrentPasswordForChange(user, currentPassword);
    if (!verifyResult.ok) {
      return res.status(400).json({ error: { message: verifyResult.message } });
    }

    const hashedPassword = await hashPassword(newPassword);
    const nextTokenVersion = Number(user.token_version || 1) + 1;
    await pool.query("UPDATE persons SET password = ?, token_version = ? WHERE id = ?", [hashedPassword, nextTokenVersion, user.id]);
    clearAuthUserCache(user.id);

    const freshToken = signStaffJwt({ ...user, token_version: nextTokenVersion });
    return res.json({
      success: true,
      message: "Password updated successfully.",
      access_token: freshToken,
    });
  } catch (err) {
    console.error("Change password error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to update password." } });
  }
});

app.post("/api/auth/update-profile", requireStaffAuth, async (req, res) => {
  const { userId, newName, newEmail, currentPassword, newPassword } = req.body || {};
  if (userId && String(userId) !== String(req.staffUser.id)) {
    return res.status(403).json({ error: { message: "You can only update your own account profile." } });
  }

  try {
    const user = await findPersonForAuth({ userId: req.staffUser.id });
    if (!user) {
      return res.status(404).json({ error: { message: "User account not found." } });
    }

    // Check duplicate email if email is being changed
    const targetEmail = newEmail ? String(newEmail).trim() : user.email;
    if (newEmail && targetEmail !== user.email) {
      const [dup] = await pool.query("SELECT id FROM persons WHERE email = ? AND id != ? LIMIT 1", [targetEmail, user.id]);
      if (dup && dup.length > 0) {
        return res.status(400).json({ error: { message: "Email address is already in use by another account." } });
      }
    }

    // If changing password, enforce strength policy and verify current password
    let updatedPassword = user.password;
    let nextTokenVersion = Number(user.token_version || 1);
    const isChangingPassword = newPassword !== undefined && newPassword !== null && newPassword !== "";
    if (isChangingPassword) {
      const strengthError = validatePasswordStrength(newPassword);
      if (strengthError) {
        return res.status(400).json({ error: { message: strengthError } });
      }
      const verifyResult = await verifyCurrentPasswordForChange(user, currentPassword);
      if (!verifyResult.ok) {
        return res.status(400).json({ error: { message: verifyResult.message } });
      }
      updatedPassword = await hashPassword(newPassword);
      nextTokenVersion += 1;
    }

    const updatedName = newName !== undefined && String(newName).trim().length > 0 ? String(newName).trim() : user.name;

    await pool.query(
      "UPDATE persons SET name = ?, email = ?, password = ?, token_version = ? WHERE id = ?",
      [updatedName, targetEmail, updatedPassword, nextTokenVersion, user.id]
    );
    clearAuthUserCache(user.id);
    clearEligiblePersonsCache();

    const updatedUser = buildSessionUser({ ...user, name: updatedName, email: targetEmail });
    const freshToken = isChangingPassword || targetEmail !== user.email || updatedName !== user.name
      ? signStaffJwt({ ...user, name: updatedName, email: targetEmail, token_version: nextTokenVersion })
      : null;

    return res.json({
      success: true,
      message: "Account settings updated successfully.",
      user: updatedUser,
      ...(freshToken ? { access_token: freshToken } : {}),
    });
  } catch (err) {
    console.error("Update profile error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to update profile." } });
  }
});

// Admin Accounts Manager Routes (Admin only)
app.get("/api/admin/accounts", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email, role, department, phone_number, approved, created_at FROM persons WHERE role = 'admin' OR (email IS NOT NULL AND email != '' AND role = 'admin') ORDER BY name ASC"
    );
    return res.json({ accounts: rows || [] });
  } catch (err) {
    console.error("Get admin accounts error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to load accounts." } });
  }
});

app.post("/api/admin/accounts", requireAdmin, async (req, res) => {
  const { name, email, role = "admin", department = "Admin", password = "", phone_number = "" } = req.body || {};
  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: { message: "Email is required." } });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: { message: "Full name is required." } });
  }
  const staffRole = normalizeStaffRole(role);
  if (!staffRole) {
    return res.status(400).json({ error: { message: "Invalid account role. Only 'admin' role is permitted." } });
  }
  const strengthError = validatePasswordStrength(password);
  if (strengthError) {
    return res.status(400).json({ error: { message: strengthError } });
  }

  try {
    const [existing] = await pool.query("SELECT id FROM persons WHERE email = ? LIMIT 1", [String(email).trim()]);
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: { message: "An account with this email address already exists." } });
    }

    const hashedPassword = await hashPassword(password);
    const newId = `ACC-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
    await pool.query(
      `INSERT INTO persons (id, name, email, password, role, department, phone_number, approved, token_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, NOW())`,
      [newId, String(name).trim(), String(email).trim(), hashedPassword, staffRole, department || "Admin", phone_number || null]
    );
    clearEligiblePersonsCache();

    return res.json({
      success: true,
      account: { id: newId, name: String(name).trim(), email: String(email).trim(), role: staffRole, department: department || "Admin", approved: 1 }
    });
  } catch (err) {
    console.error("Create account error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to create account." } });
  }
});

app.put("/api/admin/accounts/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, email, role, department, password, approved, phone_number } = req.body || {};

  try {
    const [existing] = await pool.query("SELECT * FROM persons WHERE id = ? LIMIT 1", [id]);
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: { message: "Account not found." } });
    }
    const targetUser = existing[0];

    let normalizedRoleUpdate;
    if (role !== undefined) {
      normalizedRoleUpdate = normalizeStaffRole(role);
      if (!normalizedRoleUpdate) {
        return res.status(400).json({ error: { message: "Invalid account role. Only 'admin' role is permitted." } });
      }
    }

    const demotingOrDisablingLastAdmin =
      targetUser.role === "admin" &&
      ((normalizedRoleUpdate !== undefined && normalizedRoleUpdate !== "admin") || approved === false || approved === 0);

    if (demotingOrDisablingLastAdmin) {
      const [adminCountRows] = await pool.query("SELECT COUNT(*) as count FROM persons WHERE role = 'admin' AND approved != 0 AND (archived = 0 OR archived IS NULL)");
      if (Number(adminCountRows?.[0]?.count || 0) <= 1) {
        return res.status(400).json({ error: { message: "Cannot demote or disable the only remaining active administrator account." } });
      }
    }

    if (email) {
      const [duplicate] = await pool.query("SELECT id FROM persons WHERE email = ? AND id != ? LIMIT 1", [String(email).trim(), id]);
      if (duplicate && duplicate.length > 0) {
        return res.status(400).json({ error: { message: "Email is already taken by another account." } });
      }
    }

    const updates = [];
    const params = [];
    let shouldRevokeSessions = false;

    if (name !== undefined) { updates.push("name = ?"); params.push(String(name).trim()); }
    if (email !== undefined) { updates.push("email = ?"); params.push(String(email).trim()); }
    if (normalizedRoleUpdate !== undefined) {
      updates.push("role = ?");
      params.push(normalizedRoleUpdate);
      if (normalizedRoleUpdate !== targetUser.role) shouldRevokeSessions = true;
    }
    if (department !== undefined) { updates.push("department = ?"); params.push(department); }
    if (password !== undefined && password !== null && password !== "") {
      const strengthError = validatePasswordStrength(password);
      if (strengthError) {
        return res.status(400).json({ error: { message: strengthError } });
      }
      updates.push("password = ?");
      params.push(await hashPassword(password));
      shouldRevokeSessions = true;
    }
    if (approved !== undefined) {
      updates.push("approved = ?");
      params.push(approved ? 1 : 0);
      if (!approved) shouldRevokeSessions = true;
    }
    if (phone_number !== undefined) { updates.push("phone_number = ?"); params.push(phone_number); }
    if (shouldRevokeSessions) {
      updates.push("token_version = COALESCE(token_version, 1) + 1");
    }

    if (updates.length > 0) {
      params.push(id);
      await pool.query(`UPDATE persons SET ${updates.join(", ")} WHERE id = ?`, params);
      clearAuthUserCache(id);
      clearEligiblePersonsCache();
    }

    return res.json({ success: true, message: "Account updated successfully." });
  } catch (err) {
    console.error("Update account error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to update account." } });
  }
});

app.delete("/api/admin/accounts/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (String(req.staffUser.id) === String(id)) {
    return res.status(400).json({ error: { message: "Cannot delete your own currently active administrator account." } });
  }

  try {
    const [existing] = await pool.query("SELECT * FROM persons WHERE id = ? LIMIT 1", [id]);
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: { message: "Account not found." } });
    }

    if (existing[0].role === "admin") {
      const [adminCountRows] = await pool.query("SELECT COUNT(*) as count FROM persons WHERE role = 'admin'");
      const count = adminCountRows[0]?.count || 0;
      if (count <= 1) {
        return res.status(400).json({ error: { message: "Cannot delete the only remaining administrator account." } });
      }
    }

    await pool.query("DELETE FROM persons WHERE id = ?", [id]);
    clearAuthUserCache(id);
    clearEligiblePersonsCache();
    return res.json({ success: true, message: "Account deleted successfully." });
  } catch (err) {
    console.error("Delete account error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to delete account." } });
  }
});

// ==========================================
// DAHUA SYNC ROUTES (MySQL)
// ==========================================
app.post(["/api/users/import", "/api/dahua/push-users"], requireAdminOrServiceToken, async (req, res) => {
  try {
    const rawUsers = Array.isArray(req.body?.users) ? req.body.users : [];
    if (!rawUsers.length) {
      return res.json({ count: 0, message: "No users were provided in payload." });
    }

    let insertedOrUpdatedCount = 0;
    for (const u of rawUsers) {
      const id = String(u.id || u.UserID || u.userID || "").trim();
      if (!id) continue;
      const name = u.name || u.UserName || u.userName || null;
      const department = u.department || u.Department || null;
      const phone = u.phone_number || u.Phone || null;
      const address = u.address || u.Address || null;
      const sex = u.sex || u.Sex || null;

      const photo = u.registration_photo || null;

      await pool.query(
        `INSERT INTO persons (id, name, department, phone_number, address, sex, registration_photo)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = COALESCE(NULLIF(VALUES(name), ''), name),
           department = COALESCE(NULLIF(VALUES(department), ''), department),
           phone_number = COALESCE(NULLIF(VALUES(phone_number), ''), phone_number),
           address = COALESCE(NULLIF(VALUES(address), ''), address),
           sex = COALESCE(NULLIF(VALUES(sex), ''), sex),
           registration_photo = COALESCE(VALUES(registration_photo), registration_photo)`,
        [id, name, department, phone, address, sex, photo]
      );
      insertedOrUpdatedCount += 1;
    }

    clearEligiblePersonsCache();
    return res.json({
      received: rawUsers.length,
      count: insertedOrUpdatedCount,
      message: `Successfully synced ${insertedOrUpdatedCount} from Dahua user(s).`
    });
  } catch (err) {
    console.error("User import error:", err.message);
    return res.status(500).json({ error: `User import failed: ${err.message}` });
  }
});

app.post("/api/dahua/sync-users", requireAdmin, async (req, res) => {
  try {
    const users = await getDahuaUsers();
    const payload = users.map((user) => ({
      id: firstValue(user, ["UserID", "userID", "ID", "userId"]),
      name: firstValue(user, ["UserName", "userName", "Name", "name"]),
      department: firstValue(user, ["Department", "department", "Group", "group"]),
      phone_number: firstValue(user, ["Phone", "phone", "PhoneNumber"]),
      address: firstValue(user, ["Address", "address"]),
      sex: firstValue(user, ["Sex", "sex"]),
      registration_photo: user.registration_photo || null,
    })).filter((user) => user.id);

    if (!payload.length) return res.json({ count: 0, message: "No users were returned by the Dahua device." });

    let insertedOrUpdatedCount = 0;
    for (const u of payload) {
      await pool.query(
        `INSERT INTO persons (id, name, department, phone_number, address, sex, registration_photo)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = COALESCE(NULLIF(VALUES(name), ''), name),
           department = COALESCE(NULLIF(VALUES(department), ''), department),
           phone_number = COALESCE(NULLIF(VALUES(phone_number), ''), phone_number),
           address = COALESCE(NULLIF(VALUES(address), ''), address),
           sex = COALESCE(NULLIF(VALUES(sex), ''), sex),
           registration_photo = COALESCE(VALUES(registration_photo), registration_photo)`,
        [u.id, u.name || null, u.department || null, u.phone_number || null, u.address || null, u.sex || null, u.registration_photo || null]
      );
      insertedOrUpdatedCount += 1;
    }

    await recordDeviceSyncStatus({ type: 'person', success: true });

    return res.json({
      count: insertedOrUpdatedCount,
      message: `Synced ${insertedOrUpdatedCount} user(s) from Dahua.`
    });
  } catch (err) {
    await recordDeviceSyncStatus({ type: 'person', success: false, error: err.message });
    const connectorUrl = DAHUA_CONNECTOR_URL || "";
    const isPrivateIp = /192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|localhost|127\.0\.0\.1/.test(connectorUrl || DAHUA_DEVICE_IP);

    if (isPrivateIp && (err.message.includes("ECONNREFUSED") || err.message.includes("timed out") || err.message.includes("ENOTFOUND"))) {
      try {
        const [rows] = await pool.query("SELECT COUNT(*) as total FROM persons WHERE archived = 0 OR archived IS NULL");
        const totalCount = rows[0]?.total || 0;
        return res.json({
          count: totalCount,
          message: `Registered persons refreshed. Currently managing ${totalCount} active person(s).`
        });
      } catch (dbErr) {
        return res.json({
          count: 0,
          message: "Registered persons refreshed from database."
        });
      }
    }

    const message = errorMessage(err, "The Dahua device returned an invalid response or the database operation failed.");
    console.error("Dahua user sync error:", err);
    return res.status(502).json({ error: `Dahua user sync failed: ${message}` });
  }
});

async function deleteDahuaUserOnDevice(personId) {
  if (!personId) return false;
  const targetIdStr = String(personId).trim();

  try {
    const finderQuery = `/cgi-bin/recordFinder.cgi?action=find&name=AccessUser&count=1000`;
    let finderBody = "";

    if (USE_LOCAL_CONNECTOR) {
      finderBody = await requestDahuaGetViaConnector(finderQuery);
    } else {
      finderBody = await requestDahuaWithDigest(finderQuery);
    }

    let targetRecNo = null;
    if (finderBody) {
      const records = parseDahuaRows(finderBody);
      const match = records.find(
        (r) =>
          r &&
          (String(r.UserID) === targetIdStr ||
            String(r.UserID) === String(Number(targetIdStr)))
      );
      if (match && match.RecNo) {
        targetRecNo = match.RecNo;
      }
    }

    if (targetRecNo) {
      const removeQuery = `/cgi-bin/recordUpdater.cgi?action=remove&name=AccessUser&recno=${targetRecNo}`;
      console.log(`[Dahua User Force Delete] Found RecNo ${targetRecNo} for UserID ${targetIdStr}, Sending: ${removeQuery}`);

      if (USE_LOCAL_CONNECTOR) {
        const resText = await requestDahuaGetViaConnector(removeQuery);
        console.log(`[Dahua User Force Delete Result]:`, resText);
      } else {
        const body = await requestDahuaWithDigest(removeQuery);
        console.log(`[Dahua User Force Delete Direct Result]:`, body);
      }
    } else {
      console.warn(`[Dahua User Force Delete] Could not find AccessUser record for UserID ${targetIdStr} on Dahua device.`);
    }

    return true;
  } catch (err) {
    console.warn(`[Dahua User Force Delete Error]:`, err.message);
    return false;
  }
}

app.delete("/api/dahua/person", requireAdmin, async (req, res) => {
  const { personId, hardDelete } = req.body || {};
  if (!personId) {
    return res.status(400).json({ error: "personId is required." });
  }
  try {
    // 1. Force delete user from Dahua physical device
    try {
      console.log(`[Dahua Person Force Delete] Requesting authenticated deletion of user ${personId} from physical Dahua device...`);
      await deleteDahuaUserOnDevice(personId);
      console.log(`[Dahua Person Force Delete] Successfully requested deletion of user ${personId} on physical Dahua device.`);
    } catch (dahuaErr) {
      console.warn(`[Dahua Person Force Delete] Physical device deletion warning for user ${personId}:`, dahuaErr.message);
    }

    // 2. Perform DB deletion (or archive if hardDelete is false)
    if (hardDelete) {
      await pool.query("DELETE FROM persons WHERE id = ?", [personId]);
    } else {
      await pool.query("UPDATE persons SET archived = 1, token_version = COALESCE(token_version, 1) + 1 WHERE id = ?", [personId]);
    }
    clearAuthUserCache(personId);
    clearEligiblePersonsCache();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(["/api/attendance/import", "/attendance/import", "/api/dahua/import", "/dahua/import"], requireAdminOrServiceToken, async (req, res) => {
  try {
    const rawRecords = Array.isArray(req.body?.records) ? req.body.records : [];
    if (!rawRecords.length) {
      return res.json({ count: 0, received: 0, message: "No attendance records were provided in payload." });
    }

    const settingsRow = await pool.query("SELECT * FROM settings ORDER BY id LIMIT 1");
    const settings = settingsRow[0]?.[0] || null;

    const formattedRecords = rawRecords.map((r) => ({
      person_id: String(r.person_id || r.UserID || r.userID || r.CardNo || "").trim(),
      name: r.name || r.CardName || r.Name || null,
      event: mapDahuaAttendanceEvent(r),
      point: r.point || r.AttendancePoint || r.Point || null,
      method: mapDahuaAttendanceMethod(r.method || r.Method),
      device_time: normalizeDahuaDeviceTime(r.device_time || r.CreateTime || r.Time),
    })).filter((r) => r.person_id && r.device_time);

    const payload = dedupeDahuaAttendanceByPersonDay(formattedRecords, settings);

    if (!payload.length) {
      return res.json({ count: 0, received: rawRecords.length, message: "No new attendance records were found after deduplication." });
    }

    let insertedCount = 0;
    const insertedAttendance = [];
    for (const record of payload) {
      try {
        const formattedTime = record.device_time;
        const workDate = getWorkDateFromDeviceTime(formattedTime, record.event);
        const rawDate = formattedTime.slice(0, 10);

        // Preserve existing ot_status if any record for this person/workDate was already approved or denied
        let preservedOtStatus = "pending";
        try {
          const [existingOtRows] = await pool.query(
            "SELECT ot_status FROM attendance WHERE person_id = ? AND (attendance_work_date = ? OR (attendance_work_date IS NULL AND device_time LIKE ?)) AND ot_status IN ('approved', 'denied') LIMIT 1",
            [record.person_id, workDate, `${rawDate}%`]
          );
          if (existingOtRows && existingOtRows[0]?.ot_status) {
            preservedOtStatus = existingOtRows[0].ot_status;
          }
        } catch (e) {}

        // Delete any previously inserted shifted timestamp for the same person and event on this work shift (never delete admin-entry)
        await pool.query(
          "DELETE FROM attendance WHERE person_id = ? AND ((event = ? AND (attendance_work_date = ? OR (attendance_work_date IS NULL AND device_time LIKE ?)) AND device_time != ?) OR (device_time = ? AND event != ?)) AND (method IS NULL OR method != 'admin-entry')",
          [record.person_id, record.event, workDate, `${rawDate}%`, formattedTime, formattedTime, record.event]
        ).catch(() => {});

        if (record.person_id) {
          await pool.query(
            "INSERT IGNORE INTO persons (id, name) VALUES (?, ?)",
            [record.person_id, record.name || `User ${record.person_id}`]
          ).catch(() => {});
        }
        const [result] = await pool.query(
          "INSERT IGNORE INTO attendance (person_id, name, event, point, method, device_time, status, ot_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [record.person_id, record.name, record.event, record.point, record.method, formattedTime, record.status || null, preservedOtStatus]
        );
        if (result.affectedRows > 0) {
          insertedCount += 1;
          insertedAttendance.push({
            person_id: record.person_id,
            name: record.name,
            event: record.event,
            method: record.method,
            device_time: formattedTime,
          });
        }
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') console.error("Import attendance insert error:", err.message);
      }
    }

    if (insertedAttendance.length) {
      const payrollResult = await generatePayrollPeriodsFromAttendance(insertedAttendance);
      console.log(`[Payroll] Auto-generated after attendance import: created=${payrollResult.created}, updated=${payrollResult.updated}`);
    }

    return res.json({
      received: rawRecords.length,
      count: insertedCount,
      message: insertedCount ? `Successfully imported ${insertedCount} attendance scan(s).` : "No new attendance records were inserted (all existing)."
    });
  } catch (err) {
    console.error("Attendance import error:", err.message);
    return res.status(500).json({ error: `Attendance import failed: ${err.message}` });
  }
});

app.post("/api/dahua/sync-attendance", requireStaffAuth, async (req, res) => {
  try {
    const limit = Math.max(Number(req.body?.limit || 5000), 1000);
    const query = `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=${limit}`;

    let records;
    if (USE_LOCAL_CONNECTOR) {
      const result = await requestDahuaGetViaConnector(query);
      records = parseDahuaRows(result);
    } else {
      records = parseDahuaRows(await requestDahuaWithDigest(query));
    }

    const settingsRow = await pool.query("SELECT * FROM settings ORDER BY id LIMIT 1");
    const settings = settingsRow[0]?.[0] || null;

    const payload = dedupeDahuaAttendanceByPersonDay(
      records.map((record) => ({
        person_id: firstValue(record, ["UserID", "userID", "CardNo"]),
        name: firstValue(record, ["CardName", "Name", "name"]) || null,
        event: mapDahuaAttendanceEvent(record),
        point: firstValue(record, ["AttendancePoint", "Point", "point"]),
        method: mapDahuaAttendanceMethod(firstValue(record, ["Method", "method"])),
        device_time: normalizeDahuaDeviceTime(firstValue(record, ["CreateTime", "Time", "time"])),
      })),
      settings
    ).filter((record) => record.device_time && record.person_id);

    if (!payload.length) return res.json({ count: 0, message: "No attendance records were returned after deduplication." });

    let insertedCount = 0;
    const insertedAttendance = [];
    for (const record of payload) {
      try {
        // device_time is already in "YYYY-MM-DD HH:MM:SS" local format from normalizeDahuaDeviceTime
        const formattedTime = record.device_time;
        const workDate = getWorkDateFromDeviceTime(formattedTime, record.event);
        const rawDate = formattedTime.slice(0, 10);
        let preservedOtStatus = "pending";
        try {
          const [existingOtRows] = await pool.query(
            "SELECT ot_status FROM attendance WHERE person_id = ? AND (attendance_work_date = ? OR (attendance_work_date IS NULL AND device_time LIKE ?)) AND ot_status IN ('approved', 'denied') LIMIT 1",
            [record.person_id, workDate, `${rawDate}%`]
          );
          if (existingOtRows && existingOtRows[0]?.ot_status) {
            preservedOtStatus = existingOtRows[0].ot_status;
          }
        } catch (e) {}
        await pool.query(
          "DELETE FROM attendance WHERE person_id = ? AND ((event = ? AND (attendance_work_date = ? OR (attendance_work_date IS NULL AND device_time LIKE ?)) AND device_time != ?) OR (device_time = ? AND event != ?)) AND (method IS NULL OR method != 'admin-entry')",
          [record.person_id, record.event, workDate, `${rawDate}%`, formattedTime, formattedTime, record.event]
        ).catch(() => {});
        if (record.person_id) {
          await pool.query(
            "INSERT IGNORE INTO persons (id, name) VALUES (?, ?)",
            [record.person_id, record.name || `User ${record.person_id}`]
          ).catch(() => {});
        }
        const [result] = await pool.query(
          "INSERT IGNORE INTO attendance (person_id, name, event, point, method, device_time, status, ot_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [record.person_id, record.name, record.event, record.point, record.method, formattedTime, record.status || null, preservedOtStatus]
        );
        if (result.affectedRows > 0) {
          insertedCount += 1;
          insertedAttendance.push({
            person_id: record.person_id,
            name: record.name,
            event: record.event,
            method: record.method,
            device_time: formattedTime,
          });
        }
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') console.error("Insert attendance error:", err.message);
      }
    }

    if (insertedAttendance.length) {
      const payrollResult = await generatePayrollPeriodsFromAttendance(insertedAttendance);
      console.log(`[Payroll] Auto-generated after Dahua sync: created=${payrollResult.created}, updated=${payrollResult.updated}`);
    }

    await recordDeviceSyncStatus({ type: 'attendance', success: true });

    return res.json({ count: insertedCount, message: insertedCount ? `Inserted ${insertedCount} deduplicated attendance scan(s).` : "No new attendance records were found after deduplication." });
  } catch (err) {
    console.error("Dahua attendance sync error:", err.message);
    await recordDeviceSyncStatus({ type: 'attendance', success: false, error: err.message });
    const connectorUrl = DAHUA_CONNECTOR_URL || "";
    const isPrivateIp = /192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|localhost|127\.0\.0\.1/.test(connectorUrl || DAHUA_DEVICE_IP);

    if (isPrivateIp && (err.message.includes("ECONNREFUSED") || err.message.includes("timed out") || err.message.includes("ENOTFOUND"))) {
      try {
        const [rows] = await pool.query("SELECT COUNT(*) as total FROM attendance");
        const totalCount = rows[0]?.total || 0;
        return res.json({
          count: 0,
          message: `Attendance is synced in the background via local sync agent. Currently storing ${totalCount} attendance records.`
        });
      } catch (dbErr) {
        return res.json({
          count: 0,
          message: "Attendance records refreshed. Local sync agent is active."
        });
      }
    }

    return res.status(502).json({ error: `Dahua attendance sync failed: ${err.message}` });
  }
});

// ==========================================
// DAHUA BIOMETRIC DEVICE MONITORING ROUTES
// ==========================================
app.get("/api/device/monitoring", requireAdmin, async (req, res) => {
  try {
    const [statusRows] = await pool.query("SELECT * FROM dahua_device_status WHERE id = 1 LIMIT 1");
    const statusData = statusRows?.[0] || {};

    const [personCountRows] = await pool.query("SELECT COUNT(*) as total FROM persons WHERE archived = 0 OR archived IS NULL");
    const personCount = personCountRows?.[0]?.total || 0;

    const [attendanceCountRows] = await pool.query("SELECT COUNT(*) as total FROM attendance WHERE archived = 0 OR archived IS NULL");
    const attendanceCount = attendanceCountRows?.[0]?.total || 0;

    const deviceName = statusData.device_name || process.env.DAHUA_DEVICE_NAME || "Multifactors Biometric Station";
    const model = statusData.model || "DHI-ASA3213GL-MW";
    const ipAddress = statusData.ip_address || DAHUA_DEVICE_IP;
    const port = Number(statusData.port || DAHUA_DEVICE_PORT || 80);

    const devices = [
      {
        id: "dahua-primary",
        name: deviceName,
        model: model,
        ipAddress: ipAddress,
        port: port,
        connectionStatus: statusData.connection_status || "Unknown",
        lastSuccessfulSync: statusData.last_successful_sync || null,
        lastFailedSync: statusData.last_failed_sync || null,
        lastFailedReason: statusData.last_failed_reason || null,
        lastAttendanceSync: statusData.last_attendance_sync || null,
        lastPersonSync: statusData.last_person_sync || null,
        numberOfPersons: Number(personCount),
        numberOfAttendanceRecords: Number(attendanceCount),
        streamOnline: streamState.status === "running",
        useLocalConnector: USE_LOCAL_CONNECTOR,
        updatedAt: statusData.updated_at || null,
      }
    ];

    return res.json({
      devices,
      summary: {
        totalDevices: devices.length,
        onlineDevices: devices.filter(d => d.connectionStatus === "Online").length,
        totalPersons: Number(personCount),
        totalAttendance: Number(attendanceCount),
      }
    });
  } catch (err) {
    console.error("Device monitoring query error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to load device monitoring data." } });
  }
});

app.post("/api/device/test-connection", requireAdmin, async (req, res) => {
  const startTime = Date.now();
  try {
    let resultData = null;
    if (USE_LOCAL_CONNECTOR) {
      const resp = await requestDahuaViaConnector("GET", "/cgi-bin/magicBox.cgi?action=getSystemInfo");
      resultData = resp?.body || resp;
    } else {
      resultData = await requestDahuaWithDigest("/cgi-bin/magicBox.cgi?action=getSystemInfo");
    }

    const latencyMs = Date.now() - startTime;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    let detectedModel = "DHI-ASA3213GL-MW";
    let detectedVersion = null;
    if (typeof resultData === "string") {
      const modelMatch = resultData.match(/appType=([^\r\n]+)/i) || resultData.match(/deviceType=([^\r\n]+)/i);
      if (modelMatch) detectedModel = modelMatch[1].trim();
      const verMatch = resultData.match(/version=([^\r\n]+)/i);
      if (verMatch) detectedVersion = verMatch[1].trim();
    }

    await pool.query(
      "UPDATE dahua_device_status SET connection_status = 'Online', model = ?, last_successful_sync = COALESCE(last_successful_sync, ?), last_failed_reason = NULL WHERE id = 1",
      [detectedModel, now]
    );

    return res.json({
      success: true,
      status: "Online",
      latencyMs,
      model: detectedModel,
      firmware: detectedVersion,
      message: `Connection established! Dahua terminal responded in ${latencyMs}ms.`
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const isConnRefused = err.message.includes("ECONNREFUSED") || err.message.includes("timed out") || err.message.includes("ENOTFOUND");
    const status = isConnRefused ? "Offline" : "Error";

    await pool.query(
      "UPDATE dahua_device_status SET connection_status = ?, last_failed_sync = ?, last_failed_reason = ? WHERE id = 1",
      [status, now, err.message]
    ).catch(() => {});

    return res.json({
      success: false,
      status: status,
      latencyMs,
      message: `Connection test failed: ${err.message}`
    });
  }
});

app.get("/api/device/status", requireAdmin, async (req, res) => {
  try {
    const raw = await requestDahuaWithDigest("/cgi-bin/magicBox.cgi?action=getSystemInfo");
    return res.json({
      status: "online",
      online: true,
      deviceIp: DAHUA_DEVICE_IP,
      devicePort: DAHUA_DEVICE_PORT,
      systemInfo: raw,
    });
  } catch (err) {
    return res.json({
      status: "offline",
      online: false,
      deviceIp: DAHUA_DEVICE_IP,
      devicePort: DAHUA_DEVICE_PORT,
      error: err.message,
    });
  }
});

app.post("/api/payroll/rebuild", requireAdmin, async (req, res) => {
  try {
    const reset = Boolean(req.body?.reset);
    if (reset) {
      await pool.query("DELETE FROM payroll_periods");
    }

    const result = await generatePayrollPeriodsFromAttendance();
    return res.json({
      ok: true,
      reset,
      created: Number(result.created || 0),
      updated: Number(result.updated || 0),
      message: reset
        ? "Payroll periods were reset and rebuilt from attendance data."
        : "Payroll periods were rebuilt from attendance data.",
    });
  } catch (error) {
    console.error("[Payroll] Rebuild failed:", error.message);
    return res.status(500).json({
      ok: false,
      error: error.message || "Payroll rebuild failed.",
    });
  }
});

app.delete("/api/dahua/attendance", requireStaffAuth, async (req, res) => {
  const { personId, deviceTime, dbId } = req.body || {};
  if (!personId || !deviceTime) {
    return res.status(400).json({ error: "personId and deviceTime are required." });
  }
  try {
    const formattedLocalTime = normalizeDahuaDeviceTime(deviceTime);
    const targetTimestampSec = Math.floor(new Date(deviceTime).getTime() / 1000);
    
    // 1. Force delete from Dahua physical device
    try {
      const query = `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=10000`;
      let bodyText = "";
      
      if (USE_LOCAL_CONNECTOR) {
        const response = await requestDahuaViaConnector("GET", query);
        bodyText = response?.body || "";
      } else {
        bodyText = await requestDahuaWithDigest(query);
      }

      if (bodyText) {
        const records = parseDahuaRows(bodyText);
        
        // Find matching record on Dahua device by unix timestamp or formatted local time
        const match = records.find((r) => {
          const rRecNo = r.RecNo;
          if (!rRecNo) return false;
          
          const rPerson = firstValue(r, ["UserID", "userID", "CardNo"]);
          const rTimeRaw = firstValue(r, ["CreateTime", "Time", "time"]);
          if (!rTimeRaw) return false;

          // Check person match (if person ID is populated on record)
          if (rPerson && String(rPerson) !== String(personId)) {
            return false;
          }

          // Epoch timestamp comparison (robust against timezone/string formatting differences)
          const rSec = Number(rTimeRaw);
          if (!isNaN(rSec) && rSec > 1000000000) {
            if (Math.abs(rSec - targetTimestampSec) <= 3) return true;
          }

          // String local time comparison fallback
          const rNormalized = normalizeDahuaDeviceTime(rTimeRaw);
          if (rNormalized && formattedLocalTime && rNormalized === formattedLocalTime) {
            return true;
          }

          return false;
        });

        if (match && match.RecNo) {
          console.log(`[Dahua Force Delete] Found matching record on physical device (RecNo: ${match.RecNo})`);
          const removeQuery = `/cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlCardRec&recno=${match.RecNo}`;
          if (USE_LOCAL_CONNECTOR) {
            await requestDahuaViaConnector("GET", removeQuery);
          } else {
            await requestDahuaWithDigest(removeQuery);
          }
          console.log(`[Dahua Force Delete] Successfully removed RecNo ${match.RecNo} from physical device.`);
        } else {
          console.warn(`[Dahua Force Delete] Could not find matching physical record on device for user=${personId}, time=${deviceTime}`);
        }
      }
    } catch (dahuaErr) {
      console.warn("[Dahua Force Delete] Device deletion warning:", dahuaErr.message);
      // Do not throw here so local database delete still succeeds
    }

    // 2. Delete from local database (by dbId if provided, or by person_id & device_time)
    if (dbId) {
      await pool.query("DELETE FROM attendance WHERE id = ?", [dbId]);
    } else {
      await pool.query(
        "DELETE FROM attendance WHERE person_id = ? AND device_time = ?",
        [personId, formattedLocalTime || deviceTime]
      );
    }

    // Queue physical deletion for local-sync-agent
    try {
      await pool.query(
        "INSERT INTO dahua_pending_deletions (type, person_id, device_time) VALUES ('attendance', ?, ?)",
        [personId, formattedLocalTime || deviceTime]
      );
    } catch (e) {}
    
    res.json({ ok: true, message: "Attendance record deleted and queued for physical device removal." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dahua/pending-deletions", requireAdminOrServiceToken, async (req, res) => {
  try {
    // Automatically purge any completed or old stale rows so the table stays clean
    await pool.query(
      "DELETE FROM dahua_pending_deletions WHERE status = 'completed' OR created_at < NOW() - INTERVAL 2 DAY"
    ).catch(() => {});
    
    const [rows] = await pool.query("SELECT * FROM dahua_pending_deletions WHERE status = 'pending' ORDER BY id ASC LIMIT 50");
    return res.json({ deletions: rows });
  } catch (err) {
    return res.json({ deletions: [] });
  }
});

app.post("/api/dahua/complete-deletion", requireAdminOrServiceToken, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (id) {
      // Automatically delete the pending record once physical device removal is complete
      await pool.query("DELETE FROM dahua_pending_deletions WHERE id = ?", [id]);
    }
    // Also remove any other completed or old records
    await pool.query(
      "DELETE FROM dahua_pending_deletions WHERE status = 'completed' OR created_at < NOW() - INTERVAL 2 DAY"
    ).catch(() => {});

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Route to manually clear/truncate the dahua_pending_deletions queue if desired
app.delete("/api/dahua/pending-deletions/clear", requireAdminOrServiceToken, async (req, res) => {
  try {
    await pool.query("DELETE FROM dahua_pending_deletions");
    return res.json({ ok: true, message: "dahua_pending_deletions table cleared successfully." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ==========================================
// PAYROLL REGENERATION API ROUTE
// ==========================================
app.post("/api/payroll/regenerate", requireAdmin, async (req, res) => {
  try {
    const result = await generatePayrollPeriodsFromAttendance();
    res.json({ message: "Payroll regenerated successfully", ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Remove sensitive auth/session fields from persons responses before serializing JSON. */
function stripPasswordFromResponse(table, value) {
  if (table !== "persons" || !value) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripPasswordFromResponse(table, item));
  }
  if (typeof value === "object") {
    const copy = { ...value };
    delete copy.password;
    delete copy.token_version;
    return copy;
  }
  return value;
}

/** Ensure any password/token_version written to `persons` via /api/db/query is validated and bcrypt-hashed. */
async function sanitizePersonWritePayload(table, itemObj) {
  if (table !== "persons" || !itemObj) {
    return null;
  }
  delete itemObj.token_version;
  if (Object.prototype.hasOwnProperty.call(itemObj, "role") && itemObj.role !== undefined && itemObj.role !== null) {
    const cleanRole = String(itemObj.role).trim().toLowerCase();
    if (!["admin", "employee"].includes(cleanRole)) {
      return "Invalid person role. Allowed roles: admin, employee.";
    }
    itemObj.role = cleanRole;
  }
  if (!Object.prototype.hasOwnProperty.call(itemObj, "password")) {
    return null;
  }
  const raw = itemObj.password;
  if (raw === undefined || raw === "") {
    delete itemObj.password;
    return null;
  }
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    return "Password must be a string.";
  }
  if (!isBcryptHash(raw)) {
    const strengthError = validatePasswordStrength(raw);
    if (strengthError) return strengthError;
    itemObj.password = await hashPassword(raw);
  }
  return null;
}

// ==========================================
// GENERIC DATABASE QUERY API ROUTE (MySQL + RBAC)
// ==========================================
const TABLE_SCHEMA_COLUMNS = {
  persons: new Set([
    "id", "name", "department", "created_at", "descriptor", "daily_rate", "late_penalty",
    "phone_number", "address", "sex", "approved", "archived", "registration_photo",
    "sss", "pag_ibig", "philhealth", "cash_advance", "email", "password", "role",
    "night_shift_diff", "token_version",
  ]),
  attendance: new Set([
    "id", "person_id", "name", "department", "event", "point", "method", "device_time",
    "attendance_work_date", "attendance_slot", "created_at", "status", "ot_status",
    "archived", "photo", "notes",
  ]),
  department_rates: new Set([
    "department", "daily_rate", "late_penalty", "updated_at", "sss", "pag_ibig",
    "philhealth", "sss_employer", "pag_ibig_employer", "philhealth_employer",
    "cash_advance", "holiday_rate", "ot_rate", "regular_holiday_rate", "special_holiday_rate",
    "has_custom_workhours", "morning_start", "morning_end", "afternoon_start", "afternoon_end", "on_time_until",
  ]),
  settings: new Set([
    "id", "morning_start", "morning_end", "afternoon_start", "afternoon_end",
    "updated_at", "morning_grace_minutes", "afternoon_grace_minutes", "late_count_limit",
    "late_penalty", "payroll_period_days", "late_base_fee", "late_per_minute_fee",
    "late_tier_minor_fee", "late_tier_mid_fee", "late_tier_major_mode", "late_tier_major_fee",
  ]),
  holidays: new Set(["id", "department", "date", "type", "description", "month", "year", "created_at"]),
  cash_advances: new Set(["id", "person_id", "amount", "note", "created_at"]),
  payroll_periods: new Set([
    "id", "person_id", "period", "days_present", "daily_rate", "late_penalty", "late_count",
    "gross", "total_late_deduction", "total_deductions", "net", "waive_early_in",
    "waive_overtime", "released", "created_at", "updated_at",
  ]),
  payroll_activity_logs: new Set(["id", "person_name", "released_by", "action", "timestamp", "payroll_period_id", "person_id"]),
  payroll_released_history: new Set([
    "id", "payroll_period_id", "person_id", "person_name", "department", "period",
    "days_present", "daily_rate", "late_penalty", "late_count", "gross",
    "total_late_deduction", "total_deductions", "net", "waive_early_in", "waive_overtime",
    "detailed_attendance", "released", "action", "released_by", "released_at", "created_at", "updated_at",
  ]),
  expenses: new Set(["id", "person_id", "period", "item_name", "amount", "expense_date", "note", "created_at"]),
};

const NEVER_READ_PERSON_COLUMNS = new Set(["password", "token_version"]);
const FACE_SCAN_ATTENDANCE_READ_COLUMNS = ["id", "person_id", "event", "device_time", "attendance_work_date", "attendance_slot", "status", "method"];
const FACE_SCAN_ATTENDANCE_READ_SET = new Set(FACE_SCAN_ATTENDANCE_READ_COLUMNS);
const FACE_SCAN_ALLOWED_METHODS = new Set(["field-site", "face-scan"]);
const MAX_PARTNER_PUNCHES_PER_TOKEN = 20;
const LIVE_FACE_SCAN_MAX_CLOCK_DRIFT_MS = 15 * 60 * 1000;
const SAFE_FILTER_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"]);

const faceTokenUsesMemory = new Map();

function stripForgedVerificationTags(rawNotes) {
  if (!rawNotes || typeof rawNotes !== "string") return "";
  return rawNotes
    .split("|")
    .map((part) =>
      part
        .replace(/(?:^|\s)verified by:\s*[^|\r\n]*/gi, " ")
        .replace(/\[offline-unverified[^\]]*\]/gi, " ")
        .replace(/\[face-verified[^\]]*\]/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join(" | ");
}

function parseAttendanceTimestampMs(rawValue) {
  if (rawValue instanceof Date) return rawValue.getTime();
  const str = String(rawValue || "").trim();
  if (!str) return NaN;
  // Treat bare MySQL wall-clock datetime strings as Asia/Manila (+08:00)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(str)) {
    return Date.parse(`${str.replace(" ", "T")}+08:00`);
  }
  return Date.parse(str);
}

/** Claim single use per (jti, targetPersonId) up to MAX_PARTNER_PUNCHES_PER_TOKEN. */
async function claimFaceTokenUse(tokenPayload, targetPersonId) {
  const jti = String(tokenPayload?.jti || "").trim();
  const verifierPid = String(tokenPayload?.pid || "").trim();
  const targetPid = String(targetPersonId || "").trim();
  if (!jti || !verifierPid || !targetPid) {
    return { ok: false, status: 400, message: "Invalid verification token claims or target person_id." };
  }

  // Prune expired in-memory entries opportunistically
  const now = Date.now();
  for (const [k, entry] of faceTokenUsesMemory.entries()) {
    if (entry.exp && now > entry.exp + 60 * 1000) {
      faceTokenUsesMemory.delete(k);
    }
  }

  const memEntry = faceTokenUsesMemory.get(jti) || { targets: new Set(), exp: Number(tokenPayload.exp || now + 5 * 60 * 1000) };
  if (memEntry.targets.has(targetPid)) {
    return { ok: false, status: 409, message: "Verification token already used for this employee. Please scan face again." };
  }
  if (memEntry.targets.size >= MAX_PARTNER_PUNCHES_PER_TOKEN) {
    return { ok: false, status: 429, message: "Verification token reached maximum team punch limit. Please scan face again." };
  }

  try {
    const [countRows] = await pool.query("SELECT COUNT(*) as total FROM face_token_uses WHERE jti = ?", [jti]);
    if (Number(countRows?.[0]?.total || 0) >= MAX_PARTNER_PUNCHES_PER_TOKEN) {
      return { ok: false, status: 429, message: "Verification token reached maximum team punch limit. Please scan face again." };
    }
    await pool.query(
      "INSERT INTO face_token_uses (jti, verifier_pid, target_person_id) VALUES (?, ?, ?)",
      [jti, verifierPid, targetPid]
    );
  } catch (dbErr) {
    if (dbErr && (dbErr.code === "ER_DUP_ENTRY" || dbErr.errno === 1062)) {
      return { ok: false, status: 409, message: "Verification token already used for this employee. Please scan face again." };
    }
    // If table doesn't exist yet (e.g. unit test mock pool without DDL), continue relying on in-memory replay map
    if (dbErr && dbErr.code !== "ER_NO_SUCH_TABLE" && !String(dbErr.message || "").includes("face_token_uses")) {
      throw dbErr;
    }
  }

  memEntry.targets.add(targetPid);
  faceTokenUsesMemory.set(jti, memEntry);
  return { ok: true };
}

function validateColumnList(table, rawCols, { readableOnly = false, allowedSet = null } = {}) {
  const schemaSet = TABLE_SCHEMA_COLUMNS[table];
  const validSet = allowedSet || schemaSet;
  const cols = rawCols.map((c) => String(c || "").trim()).filter(Boolean);
  for (const col of cols) {
    if (!schemaSet.has(col)) {
      return { ok: false, status: 400, message: `Column '${col}' does not exist on table '${table}'.` };
    }
    if (table === "persons" && readableOnly && NEVER_READ_PERSON_COLUMNS.has(col)) {
      return { ok: false, status: 403, message: `Column '${col}' cannot be queried.` };
    }
    if (allowedSet && !validSet.has(col)) {
      return { ok: false, status: 403, message: `Access denied for column '${col}' on table '${table}'.` };
    }
  }
  return { ok: true, cols };
}

function buildValidatedWhereClause(table, filters, params, allowedFilterSet = null) {
  if (!Array.isArray(filters) || filters.length === 0) return "";
  const schemaSet = TABLE_SCHEMA_COLUMNS[table];
  const clauses = [];

  for (const f of filters) {
    if (!f || typeof f !== "object" || !f.column || !f.op) {
      const err = new Error("Malformed filter entry.");
      err.statusCode = 400;
      throw err;
    }
    const colName = String(f.column).trim();
    const op = String(f.op).trim();
    if (!schemaSet.has(colName)) {
      const err = new Error(`Invalid filter column '${colName}' on table '${table}'.`);
      err.statusCode = 400;
      throw err;
    }
    if (table === "persons" && NEVER_READ_PERSON_COLUMNS.has(colName)) {
      const err = new Error(`Filtering on column '${colName}' is not permitted.`);
      err.statusCode = 403;
      throw err;
    }
    if (allowedFilterSet && !allowedFilterSet.has(colName)) {
      const err = new Error(`Filtering on column '${colName}' is not permitted for your role.`);
      err.statusCode = 403;
      throw err;
    }
    if (!SAFE_FILTER_OPS.has(op)) {
      const err = new Error(`Unsupported filter operator '${op}'.`);
      err.statusCode = 400;
      throw err;
    }

    const quotedCol = `\`${colName}\``;
    if (op === "eq") {
      clauses.push(`${quotedCol} = ?`);
      params.push(f.value);
    } else if (op === "neq") {
      clauses.push(`${quotedCol} != ?`);
      params.push(f.value);
    } else if (op === "gt") {
      clauses.push(`${quotedCol} > ?`);
      params.push(f.value);
    } else if (op === "gte") {
      clauses.push(`${quotedCol} >= ?`);
      params.push(f.value);
    } else if (op === "lt") {
      clauses.push(`${quotedCol} < ?`);
      params.push(f.value);
    } else if (op === "lte") {
      clauses.push(`${quotedCol} <= ?`);
      params.push(f.value);
    } else if (op === "like" || op === "ilike") {
      clauses.push(`${quotedCol} LIKE ?`);
      params.push(f.value);
    } else if (op === "is") {
      if (f.value === null) clauses.push(`${quotedCol} IS NULL`);
      else if (f.value === true) clauses.push(`${quotedCol} IS TRUE`);
      else if (f.value === false) clauses.push(`${quotedCol} IS FALSE`);
      else {
        clauses.push(`${quotedCol} = ?`);
        params.push(f.value);
      }
    } else if (op === "in") {
      if (!Array.isArray(f.value)) {
        const err = new Error(`Filter operator 'in' requires an array for '${colName}'.`);
        err.statusCode = 400;
        throw err;
      }
      if (f.value.length > 0) {
        clauses.push(`${quotedCol} IN (${f.value.map(() => "?").join(", ")})`);
        params.push(...f.value);
      } else {
        clauses.push("1=0");
      }
    }
  }

  return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

app.post("/api/db/query", async (req, res) => {
  const { table, action, select, columns, filters = [], orders = [], limit, offset, data, payload, single, maybeSingle, count } = req.body || {};
  const selectArg = select !== undefined ? select : columns;
  const payloadData = payload !== undefined ? payload : data;

  const allowedTables = Object.keys(TABLE_SCHEMA_COLUMNS);
  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: { message: `Table '${table}' is not accessible.` } });
  }
  if (!["select", "insert", "update", "upsert", "delete"].includes(action)) {
    return res.status(400).json({ error: { message: `Unknown action: ${action}` } });
  }

  // Authenticate caller: Staff JWT takes precedence; otherwise allow strictly scoped /scan faceToken on attendance select/insert
  let principal = null;
  const bearerToken = extractBearerToken(req);
  if (bearerToken) {
    const resolved = await resolveStaffSession(req).catch((e) => ({ ok: false, status: 500, code: "AUTH_ERROR", error: e.message }));
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: { message: resolved.error, code: resolved.code } });
    }
    principal = { kind: "staff", user: resolved.user, role: resolved.user.role };
  } else {
    const faceHeaderToken = String(req.headers["x-face-token"] || req.body?.face_token || "").trim();
    const isScanAttendanceCandidate = table === "attendance" && (action === "select" || action === "insert");
    if (!isScanAttendanceCandidate) {
      return res.status(401).json({ error: { message: "Authentication required for this database operation.", code: "AUTH_REQUIRED" } });
    }
    if (action === "select") {
      if (!faceHeaderToken) {
        return res.status(401).json({ error: { message: "Face verification token or staff sign-in is required.", code: "AUTH_REQUIRED" } });
      }
      const verifiedFace = verifyFaceToken(faceHeaderToken);
      if (!verifiedFace.valid) {
        return res.status(401).json({ error: { message: `Invalid or expired face verification token: ${verifiedFace.error}`, code: "FACE_TOKEN_INVALID" } });
      }
      principal = { kind: "face", facePayload: verifiedFace.payload };
    } else {
      // action === "insert" on attendance without staff JWT: enforce per-item verification_token (or header fallback) inside INSERT block
      principal = { kind: "face", faceHeaderToken: faceHeaderToken || null };
    }
  }

  // Enforce role-based table & action authorization
  if (principal.kind === "staff" && principal.role !== "admin") {
    return res.status(403).json({ error: { message: "Administrator privileges required for database operations.", code: "FORBIDDEN" } });
  }

  try {
    if (table === "persons" && action !== "select") {
      clearEligiblePersonsCache();
      clearAuthUserCache();
    }

    // 1. SELECT
    if (action === "select") {
      let allowedSelectSet = null;
      let allowedFilterSet = null;
      let defaultSafeColumns = "*";

      if (principal.kind === "face") {
        allowedSelectSet = FACE_SCAN_ATTENDANCE_READ_SET;
        allowedFilterSet = FACE_SCAN_ATTENDANCE_READ_SET;
        defaultSafeColumns = FACE_SCAN_ATTENDANCE_READ_COLUMNS.map((c) => `\`${c}\``).join(", ");

        const hasPersonIdFilter = Array.isArray(filters) && filters.some((f) => {
          if (!f || f.column !== "person_id") return false;
          if (f.op === "eq" && f.value !== undefined && f.value !== null && String(f.value).trim() !== "") return true;
          if (f.op === "in" && Array.isArray(f.value) && f.value.length > 0 && f.value.length <= 25) return true;
          return false;
        });
        if (!hasPersonIdFilter) {
          return res.status(403).json({ error: { message: "Scanner reads require a scoped person_id filter.", code: "FORBIDDEN" } });
        }
      }

      let selectCols = defaultSafeColumns;
      if (selectArg && typeof selectArg === "string" && selectArg.trim() !== "*") {
        const rawCols = selectArg.split(",").map((c) => c.trim()).filter(Boolean);
        const colCheck = validateColumnList(table, rawCols, { readableOnly: true, allowedSet: allowedSelectSet });
        if (!colCheck.ok) {
          return res.status(colCheck.status).json({ error: { message: colCheck.message } });
        }
        selectCols = colCheck.cols.map((c) => `\`${c}\``).join(", ");
      }

      const params = [];
      const whereSql = buildValidatedWhereClause(table, filters, params, allowedFilterSet);
      let sql = `SELECT ${selectCols} FROM \`${table}\`${whereSql}`;

      if (Array.isArray(orders) && orders.length > 0) {
        const orderCols = orders.map((o) => String(o?.column || "").trim());
        const orderCheck = validateColumnList(table, orderCols, { readableOnly: true, allowedSet: allowedSelectSet });
        if (!orderCheck.ok) {
          return res.status(orderCheck.status).json({ error: { message: orderCheck.message } });
        }
        const orderClauses = orders.map((o) => `\`${String(o.column).trim()}\` ${o.ascending === false ? "DESC" : "ASC"}`);
        sql += ` ORDER BY ${orderClauses.join(", ")}`;
      }

      if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
        const safeLimit = Math.min(10000, Math.floor(limit));
        sql += ` LIMIT ${safeLimit}`;
        if (typeof offset === "number" && Number.isFinite(offset) && offset >= 0) {
          sql += ` OFFSET ${Math.floor(offset)}`;
        }
      }

      const [rows] = await pool.query(sql, params);

      const sanitizedRows = (rows || []).map((r) => {
        const copy = stripPasswordFromResponse(table, r);
        if (copy.descriptor && typeof copy.descriptor === "string") {
          try { copy.descriptor = JSON.parse(copy.descriptor); } catch (e) {}
        }
        if (copy.detailed_attendance && typeof copy.detailed_attendance === "string") {
          try { copy.detailed_attendance = JSON.parse(copy.detailed_attendance); } catch (e) {}
        }
        return copy;
      });

      let totalCount = null;
      if (count === "exact") {
        const [cRows] = await pool.query(`SELECT COUNT(*) as total FROM \`${table}\`${whereSql}`, params);
        totalCount = cRows[0]?.total || 0;
      }

      if (single || maybeSingle) {
        return res.json({ data: sanitizedRows[0] || null, error: null, count: totalCount });
      }

      return res.json({ data: sanitizedRows, error: null, count: totalCount });
    }

    // 2. INSERT
    if (action === "insert") {
      const items = Array.isArray(payloadData) ? payloadData : [payloadData];
      if (items.length === 0) return res.json({ data: [], error: null });

      const preparedItems = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const itemObj = { ...item };

        // Auto-generate UUID if missing for tables using string UUIDs (like persons)
        if (!itemObj.id && table === "persons") {
          itemObj.id = crypto.randomUUID();
        }

        const passwordError = await sanitizePersonWritePayload(table, itemObj);
        if (passwordError) {
          return res.status(400).json({ error: { message: passwordError } });
        }

        const candidateToken = itemObj.verification_token || principal.faceHeaderToken || null;
        if (principal.kind === "face") {
          // Strict enforcement for unauthenticated /scan attendance submissions
          if (!candidateToken) {
            return res.status(401).json({ error: { message: "Verification token is required to record field attendance." } });
          }
          const tokenRes = verifyFaceToken(candidateToken);
          if (!tokenRes.valid) {
            return res.status(401).json({ error: { message: "Invalid or expired verification token: " + tokenRes.error } });
          }
          if (!itemObj.person_id) {
            return res.status(400).json({ error: { message: "person_id is required." } });
          }
          const methodVal = String(itemObj.method || "field-site").trim().toLowerCase();
          if (!FACE_SCAN_ALLOWED_METHODS.has(methodVal)) {
            return res.status(403).json({ error: { message: `Attendance method '${itemObj.method}' is not permitted from scanner.` } });
          }
          itemObj.method = methodVal;
          itemObj.ot_status = "pending";
          itemObj.archived = 0;

          if (itemObj.device_time) {
            const tsMs = parseAttendanceTimestampMs(itemObj.device_time);
            if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > LIVE_FACE_SCAN_MAX_CLOCK_DRIFT_MS) {
              return res.status(400).json({ error: { message: "Attendance timestamp outside permitted clock drift window." } });
            }
          }

          delete itemObj.verification_token;
          const cleanUserNotes = stripForgedVerificationTags(itemObj.notes);
          const signerTag = String(itemObj.person_id) === String(tokenRes.payload.pid)
            ? `Verified by: ${tokenRes.payload.name} (ID ${tokenRes.payload.pid})`
            : `Verified by: ${tokenRes.payload.name} (ID ${tokenRes.payload.pid}) | Team punch`;
          itemObj.notes = cleanUserNotes ? `${signerTag} | ${cleanUserNotes}` : signerTag;
          itemObj.__faceTokenPayload = tokenRes.payload;
        } else if (table === "attendance" && candidateToken) {
          // Staff session with attached face verification token
          const tokenRes = verifyFaceToken(candidateToken);
          if (!tokenRes.valid) {
            return res.status(400).json({ error: { message: "Invalid or expired verification token: " + tokenRes.error } });
          }
          delete itemObj.verification_token;
          const verifiedTag = `Verified by: ${tokenRes.payload.name} (ID ${tokenRes.payload.pid})`;
          const cleanNotes = stripForgedVerificationTags(itemObj.notes);
          itemObj.notes = cleanNotes ? `${verifiedTag} | ${cleanNotes}` : verifiedTag;
        } else {
          delete itemObj.verification_token;
        }

        if (itemObj.descriptor && typeof itemObj.descriptor === "object") {
          itemObj.descriptor = JSON.stringify(itemObj.descriptor);
        }
        if (itemObj.detailed_attendance && typeof itemObj.detailed_attendance === "object") {
          itemObj.detailed_attendance = JSON.stringify(itemObj.detailed_attendance);
        }
        for (const k in itemObj) {
          if (k === "__faceTokenPayload") continue;
          if (itemObj[k] instanceof Date) {
            itemObj[k] = normalizeDahuaDeviceTime(itemObj[k]);
          }
        }
        if (table === "attendance" && itemObj.device_time) {
          itemObj.device_time = normalizeDahuaDeviceTime(itemObj.device_time);
        }

        const writeKeys = Object.keys(itemObj).filter((k) => k !== "__faceTokenPayload");
        const keyCheck = validateColumnList(table, writeKeys);
        if (!keyCheck.ok) {
          return res.status(keyCheck.status).json({ error: { message: keyCheck.message } });
        }

        preparedItems.push({ rawItem: item, itemObj });
      }

      const inserted = [];
      for (const { rawItem, itemObj } of preparedItems) {
        const faceTokenPayload = itemObj.__faceTokenPayload || null;
        delete itemObj.__faceTokenPayload;

        if (faceTokenPayload) {
          const claimRes = await claimFaceTokenUse(faceTokenPayload, itemObj.person_id);
          if (!claimRes.ok) {
            return res.status(claimRes.status).json({ error: { message: claimRes.message } });
          }
        }

        const keys = Object.keys(itemObj);
        const cols = keys.map((k) => `\`${k}\``).join(", ");
        const placeholders = keys.map(() => "?").join(", ");
        const values = keys.map((k) => itemObj[k]);

        let sql = `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders})`;
        if (table === "attendance" && principal.kind === "staff") {
          sql += ` ON DUPLICATE KEY UPDATE
            \`device_time\` = VALUES(\`device_time\`),
            \`event\` = VALUES(\`event\`),
            \`status\` = VALUES(\`status\`),
            \`ot_status\` = COALESCE(VALUES(\`ot_status\`), \`ot_status\`),
            \`method\` = COALESCE(VALUES(\`method\`), \`method\`),
            \`photo\` = COALESCE(VALUES(\`photo\`), \`photo\`),
            \`notes\` = COALESCE(VALUES(\`notes\`), \`notes\`),
            \`name\` = COALESCE(VALUES(\`name\`), \`name\`),
            \`department\` = COALESCE(VALUES(\`department\`), \`department\`)`;
        }

        const [result] = await pool.query(sql, values);
        inserted.push(stripPasswordFromResponse(table, { ...rawItem, id: result.insertId || itemObj.id }));
      }

      return res.json({ data: single ? inserted[0] : inserted, error: null });
    }

    // 3. UPDATE
    if (action === "update") {
      if (!Array.isArray(filters) || filters.length === 0) {
        return res.status(400).json({ error: { message: "Update requires at least one filter condition." } });
      }
      if (!payloadData || typeof payloadData !== "object") {
        return res.status(400).json({ error: { message: "Update payload object is required." } });
      }

      const itemObj = { ...payloadData };
      delete itemObj.id;

      const passwordError = await sanitizePersonWritePayload(table, itemObj);
      if (passwordError) {
        return res.status(400).json({ error: { message: passwordError } });
      }

      if (itemObj.descriptor && typeof itemObj.descriptor === "object") {
        itemObj.descriptor = JSON.stringify(itemObj.descriptor);
      }
      if (itemObj.detailed_attendance && typeof itemObj.detailed_attendance === "object") {
        itemObj.detailed_attendance = JSON.stringify(itemObj.detailed_attendance);
      }
      if (table === "attendance" && itemObj.device_time) {
        itemObj.device_time = normalizeDahuaDeviceTime(itemObj.device_time);
      }

      const keys = Object.keys(itemObj).filter((k) => itemObj[k] !== undefined);
      if (keys.length === 0) {
        return res.json({ data: stripPasswordFromResponse(table, payloadData), error: null });
      }

      const keyCheck = validateColumnList(table, keys);
      if (!keyCheck.ok) {
        return res.status(keyCheck.status).json({ error: { message: keyCheck.message } });
      }

      const setClauses = keys.map((k) => `\`${k}\` = ?`).join(", ");
      const params = keys.map((k) => itemObj[k]);
      const whereSql = buildValidatedWhereClause(table, filters, params);
      if (!whereSql) {
        return res.status(400).json({ error: { message: "Update requires at least one valid filter." } });
      }

      const sql = `UPDATE \`${table}\` SET ${setClauses}${whereSql}`;

      try {
        await pool.query(sql, params);
      } catch (err) {
        if (table === "attendance" && (err.code === "ER_BAD_FIELD_ERROR" || String(err.message || "").includes("ot_status"))) {
          await pool.query("ALTER TABLE `attendance` ADD COLUMN `ot_status` VARCHAR(20) NOT NULL DEFAULT 'pending' AFTER `status`").catch(() => {});
          await pool.query(sql, params);
          return res.json({ data: stripPasswordFromResponse(table, payloadData), error: null });
        }
        if (table === "attendance" && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
          const idFilter = filters.find((f) => f && f.column === "id" && f.op === "eq");
          const idVal = idFilter ? idFilter.value : null;
          if (idVal) {
            const [rows] = await pool.query("SELECT * FROM `attendance` WHERE `id` = ?", [idVal]);
            if (rows.length > 0) {
              const combined = { ...rows[0], ...itemObj };
              const tStr = combined.device_time;
              if (tStr) {
                const workDate = getWorkDateFromDeviceTime(tStr, combined.event);
                const d = new Date(tStr);
                const mins = !isNaN(d.getTime()) ? d.getHours() * 60 + d.getMinutes() : -1;
                let slot = null;
                if (mins >= 0) {
                  if (mins < 3 * 60) {
                    slot = "afternoon_time_out";
                  } else if (combined.event === "time-in") slot = "morning_time_in";
                  else if (combined.event === "time-out") slot = "afternoon_time_out";
                }
                if (combined.person_id && workDate && slot) {
                  await pool.query(
                    "DELETE FROM `attendance` WHERE `person_id` = ? AND `attendance_work_date` = ? AND `attendance_slot` = ? AND `id` != ?",
                    [combined.person_id, workDate, slot, idVal]
                  );
                  await pool.query(sql, params);
                  return res.json({ data: stripPasswordFromResponse(table, payloadData), error: null });
                }
              }
            }
          }
        }
        throw err;
      }
      return res.json({ data: stripPasswordFromResponse(table, payloadData), error: null });
    }

    // 4. UPSERT
    if (action === "upsert") {
      const items = Array.isArray(payloadData) ? payloadData : [payloadData];
      const preparedUpserts = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const itemObj = { ...item };

        const passwordError = await sanitizePersonWritePayload(table, itemObj);
        if (passwordError) {
          return res.status(400).json({ error: { message: passwordError } });
        }

        if (itemObj.descriptor && typeof itemObj.descriptor === "object") {
          itemObj.descriptor = JSON.stringify(itemObj.descriptor);
        }
        if (itemObj.detailed_attendance && typeof itemObj.detailed_attendance === "object") {
          itemObj.detailed_attendance = JSON.stringify(itemObj.detailed_attendance);
        }

        const upsertKeys = Object.keys(itemObj);
        const keyCheck = validateColumnList(table, upsertKeys);
        if (!keyCheck.ok) {
          return res.status(keyCheck.status).json({ error: { message: keyCheck.message } });
        }

        preparedUpserts.push(itemObj);
      }

      for (const itemObj of preparedUpserts) {
        const keys = Object.keys(itemObj);
        const cols = keys.map((k) => `\`${k}\``).join(", ");
        const placeholders = keys.map(() => "?").join(", ");
        const updateClauses = keys.map((colName) => {
          if (table === "persons" && (colName === "department" || colName === "daily_rate" || colName === "late_penalty")) {
            return `\`${colName}\` = COALESCE(NULLIF(VALUES(\`${colName}\`), ''), \`${colName}\`)`;
          }
          return `\`${colName}\` = VALUES(\`${colName}\`)`;
        }).join(", ");
        const values = keys.map((k) => itemObj[k]);

        await pool.query(
          `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClauses}`,
          values
        );
      }
      return res.json({ data: stripPasswordFromResponse(table, payloadData), error: null });
    }

    // 5. DELETE
    if (action === "delete") {
      if (!Array.isArray(filters) || filters.length === 0) {
        return res.status(400).json({ error: { message: "Delete requires at least one filter condition." } });
      }
      const params = [];
      const whereSql = buildValidatedWhereClause(table, filters, params);
      if (!whereSql) {
        return res.status(400).json({ error: { message: "Delete requires at least one valid filter." } });
      }

      const sql = `DELETE FROM \`${table}\`${whereSql}`;
      await pool.query(sql, params);
      return res.json({ data: null, error: null });
    }

    return res.status(400).json({ error: { message: `Unknown action: ${action}` } });
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: { message: err.message } });
    }
    console.error("DB Query error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Database query failed" } });
  }
});

// ==========================================
// STREAMING SETTINGS
// ==========================================
function clearHlsArtifacts() {
  try {
    for (const fileName of fs.readdirSync(hlsDir)) {
      if (fileName.endsWith(".m3u8") || fileName.endsWith(".ts")) fs.rmSync(path.join(hlsDir, fileName), { force: true });
    }
  } catch (e) {}
}

function startFfmpeg() {
  if (!ffmpeg || !RTSP_URL) return null;
  if (ffmpegCommand) return ffmpegCommand;
  try {
    clearHlsArtifacts();
    streamState.status = "starting";
    const command = ffmpeg(RTSP_URL)
      .inputOptions(["-rtsp_transport", "tcp", "-fflags", "nobuffer", "-analyzeduration", "0", "-probesize", "32", "-flags", "low_delay"])
      .addOptions(["-an", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0", "-f", "hls", "-hls_time", "0.5", "-hls_list_size", "2", "-hls_flags", "delete_segments+omit_endlist+independent_segments+program_date_time", "-muxdelay", "0", "-muxpreload", "0"])
      .output(path.join(hlsDir, "index.m3u8"))
      .on("start", () => {
        ffmpegCommand = command;
        streamState.status = "running";
      })
      .on("error", (err) => {
        ffmpegCommand = null;
        streamState.status = "error";
        streamState.lastError = err.message;
      })
      .on("end", () => {
        ffmpegCommand = null;
        streamState.status = "ended";
      })
      .run();
    ffmpegCommand = command;
    return command;
  } catch (e) {
    console.error("Cannot start ffmpeg:", e.message);
    streamState.status = "error";
    streamState.lastError = e.message;
  }
}

// Disabled 24/7 background RTSP camera video streaming by default to prevent cPanel bandwidth exhaustion (5GB+).
// Physical Dahua device operates standalone and syncs attendance data via lightweight API calls.
try {
  clearHlsArtifacts();
  if (RTSP_URL && process.env.ENABLE_LIVE_STREAM === "true") {
    startFfmpeg();
  }
} catch (e) {
  console.warn("Skipping ffmpeg on startup:", e.message);
}

// Background auto sync for attendance if configured
if (AUTO_SYNC_ATTENDANCE_MINUTES > 0) {
  setInterval(async () => {
    try {
      const query = `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=1000`;
      const records = parseDahuaRows(await requestDahuaWithDigest(query));

      const settingsRow = await pool.query("SELECT * FROM settings ORDER BY id LIMIT 1");
      const settings = settingsRow[0]?.[0] || null;
      const deduplicated = dedupeDahuaAttendanceByPersonDay(
        records.map((record) => ({
          person_id: firstValue(record, ["UserID", "userID", "CardNo"]),
          name: firstValue(record, ["CardName", "Name", "name"]) || null,
          event: mapDahuaAttendanceEvent(record),
          point: firstValue(record, ["AttendancePoint", "Point", "point"]),
          method: mapDahuaAttendanceMethod(firstValue(record, ["Method", "method"])),
          device_time: normalizeDahuaDeviceTime(firstValue(record, ["CreateTime", "Time", "time"])),
        })),
        settings
      );

      for (const record of deduplicated) {
        const pId = record.person_id;
        const dTime = record.device_time;
        if (!pId || !dTime) continue;
        const dateDay = dTime.slice(0, 10);
        const workDate = getWorkDateFromDeviceTime(dTime, record.event);
        await pool.query(
          "DELETE FROM attendance WHERE person_id = ? AND ((event = ? AND (attendance_work_date = ? OR (attendance_work_date IS NULL AND device_time LIKE ?)) AND device_time != ?) OR (device_time = ? AND event != ?)) AND (method IS NULL OR method != 'admin-entry')",
          [pId, record.event, workDate, `${dateDay}%`, dTime, dTime, record.event]
        ).catch(() => {});
        await pool.query(
          "INSERT IGNORE INTO attendance (person_id, name, event, point, method, device_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            pId,
            record.name,
            record.event,
            record.point,
            record.method,
            dTime,
            record.status || null,
          ]
        );
      }
    } catch (e) {}
  }, AUTO_SYNC_ATTENDANCE_MINUTES * 60 * 1000);
}

app.use("/hls", express.static(hlsDir, {
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  },
}));

app.get("/health/stream", (req, res) => res.json({ ...streamState }));
app.get("/health", (req, res) => res.json({ status: "ok" }));


// ==========================================
// FACE VERIFICATION & SECURITY TOKEN SERVICE
// ==========================================
const FACE_VERIFY_THRESHOLD = Number(process.env.FACE_VERIFY_THRESHOLD || 0.38);
const FACE_MARGIN_THRESHOLD = 0.012;

function signFaceToken(payload) {
  const secret = getFaceTokenSecret();
  if (!secret) {
    throw new Error("FACE_TOKEN_SECRET is required in production.");
  }
  const normalizedPayload = { typ: "face-scan", ...payload };
  const body = Buffer.from(JSON.stringify(normalizedPayload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyFaceToken(token) {
  const secret = getFaceTokenSecret();
  if (!secret) {
    return { valid: false, error: "Server face verification secret is not configured." };
  }
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: "Malformed token" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, error: "Invalid token format" };
  const [bodyB64, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", secret).update(bodyB64).digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: "Invalid signature" };
  }

  try {
    const payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf-8"));
    if (!payload || (payload.typ && payload.typ !== "face-scan") || !payload.pid || !payload.jti) {
      return { valid: false, error: "Invalid face token claims" };
    }
    const now = Date.now();
    if (!payload.exp || now > Number(payload.exp)) {
      return { valid: false, error: "Token expired" };
    }
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: "Corrupted payload" };
  }
}

// In-memory cache for eligible persons
let eligiblePersonsCache = null;
let eligiblePersonsCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000;

function clearEligiblePersonsCache() {
  eligiblePersonsCache = null;
  eligiblePersonsCacheTime = 0;
}

async function getEligiblePersons() {
  const now = Date.now();
  if (eligiblePersonsCache && (now - eligiblePersonsCacheTime < CACHE_TTL_MS)) {
    return eligiblePersonsCache;
  }
  const [rows] = await pool.query(
    "SELECT id, name, department, descriptor FROM persons WHERE (archived = 0 OR archived IS NULL) AND descriptor IS NOT NULL"
  );
  const persons = [];
  for (const r of rows) {
    try {
      let desc = r.descriptor;
      if (typeof desc === "string") desc = JSON.parse(desc);
      if (Array.isArray(desc) && desc.length === 128) {
        let sum = 0;
        for (let i = 0; i < 128; i++) sum += desc[i] * desc[i];
        const norm = Math.sqrt(sum) || 1.0;
        const normDesc = new Float32Array(128);
        for (let i = 0; i < 128; i++) normDesc[i] = desc[i] / norm;

        persons.push({
          id: String(r.id),
          name: r.name,
          department: r.department,
          descriptor: normDesc,
        });
      }
    } catch (e) {}
  }
  eligiblePersonsCache = persons;
  eligiblePersonsCacheTime = now;
  return persons;
}

const verifyRateLimits = new Map();
function checkVerifyRateLimit(ip) {
  const now = Date.now();
  const entry = verifyRateLimits.get(ip) || { count: 0, resetTime: now + 60000 };
  if (now > entry.resetTime) {
    entry.count = 1;
    entry.resetTime = now + 60000;
  } else {
    entry.count += 1;
  }
  verifyRateLimits.set(ip, entry);
  return entry.count <= 60;
}

function calcEuclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// GET /api/face/scan-context
// Minimal non-PII bootstrap for the passwordless /scan attendance page (no emails, phones, salaries, or passwords).
app.get("/api/face/scan-context", async (req, res) => {
  try {
    const [personRows] = await pool.query(
      "SELECT id, name, department FROM persons WHERE archived = 0 OR archived IS NULL ORDER BY name ASC"
    );
    const [settingsRows] = await pool.query(
      "SELECT id, morning_start, morning_end, afternoon_start, afternoon_end, morning_grace_minutes, afternoon_grace_minutes, late_count_limit, payroll_period_days FROM settings ORDER BY id ASC LIMIT 1"
    );
    return res.json({
      success: true,
      persons: personRows || [],
      settings: settingsRows?.[0] || null,
    });
  } catch (err) {
    console.error("[Scan Context Error]:", err.message);
    return res.status(500).json({ success: false, error: err.message || "Failed to load scanner context." });
  }
});

// GET /api/face/persons-offline
// Returns all active Dahua persons with pre-normalized 128-d face descriptors for offline PWA caching
app.get("/api/face/persons-offline", async (req, res) => {
  try {
    const persons = await getEligiblePersons();
    const data = persons.map((p) => ({
      id: String(p.id),
      name: p.name,
      department: p.department,
      descriptor: Array.from(p.descriptor),
    }));
    return res.json({ success: true, count: data.length, persons: data });
  } catch (err) {
    console.error("[Persons Offline Cache Error]:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/face/verify
app.post("/api/face/verify", async (req, res) => {
  try {
    const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
    if (!checkVerifyRateLimit(clientIp)) {
      return res.status(429).json({ matched: false, error: "Too many verification attempts. Please wait a minute." });
    }

    if (!getFaceTokenSecret()) {
      return res.status(503).json({ matched: false, error: "Server face verification secret is not configured." });
    }

    const { descriptor } = req.body || {};
    if (!Array.isArray(descriptor) || descriptor.length !== 128 || !descriptor.every(n => typeof n === "number" && isFinite(n))) {
      return res.status(400).json({ matched: false, error: "Invalid face descriptor: must be array of 128 numbers" });
    }

    let sum = 0;
    for (let i = 0; i < 128; i++) sum += descriptor[i] * descriptor[i];
    const norm = Math.sqrt(sum) || 1.0;
    const inputDesc = new Float32Array(128);
    for (let i = 0; i < 128; i++) inputDesc[i] = descriptor[i] / norm;

    const persons = await getEligiblePersons();
    if (persons.length === 0) {
      return res.json({ matched: false, error: "No registered persons with face data found. Contact admin." });
    }

    let bestDist = Infinity;
    let secondBestDist = Infinity;
    let bestPerson = null;

    for (const p of persons) {
      const dist = calcEuclideanDistance(inputDesc, p.descriptor);
      if (dist < bestDist) {
        secondBestDist = bestDist;
        bestDist = dist;
        bestPerson = p;
      } else if (dist < secondBestDist) {
        secondBestDist = dist;
      }
    }

    console.log(`[Face Verify] IP: ${clientIp}, Candidate: ${bestPerson?.name} (${bestPerson?.id}), Dist: ${bestDist.toFixed(4)}, 2nd: ${secondBestDist.toFixed(4)}, Threshold: ${FACE_VERIFY_THRESHOLD}`);

    // Direct high-confidence match if bestDist <= 0.32 (natural selfie variance from Dahua photo).
    // If bestDist is between 0.32 and FACE_VERIFY_THRESHOLD (0.38), require a distinct gap (>= FACE_MARGIN_THRESHOLD) from the second best candidate.
    const isMatched = bestPerson && (
      (bestDist <= 0.32) ||
      (bestDist <= FACE_VERIFY_THRESHOLD && (secondBestDist - bestDist >= FACE_MARGIN_THRESHOLD))
    );

    if (isMatched) {
      const iat = Date.now();
      const exp = iat + 5 * 60 * 1000;
      const tokenPayload = {
        typ: "face-scan",
        pid: bestPerson.id,
        name: bestPerson.name,
        department: bestPerson.department,
        iat,
        exp,
        jti: crypto.randomUUID(),
      };
      const token = signFaceToken(tokenPayload);

      return res.json({
        matched: true,
        person: {
          id: bestPerson.id,
          name: bestPerson.name,
          department: bestPerson.department,
        },
        token,
        distance: Number(bestDist.toFixed(4)),
      });
    }

    return res.json({
      matched: false,
      error: "Face not recognized. Please retry.",
      distance: Number(bestDist.toFixed(4)),
    });
  } catch (err) {
    console.error("[Face Verify Error]:", err);
    return res.status(500).json({ matched: false, error: "Internal server error: " + err.message });
  }
});

// POST /api/face/offline-sync
// Quarantine-tagged ingestion path for IndexedDB offline queue punches when the field user has no active staff JWT or unexpired faceToken.
app.post("/api/face/offline-sync", async (req, res) => {
  try {
    const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
    if (!checkVerifyRateLimit(clientIp)) {
      return res.status(429).json({ error: { message: "Too many offline sync requests. Please wait a minute." } });
    }

    let staffUser = null;
    if (extractBearerToken(req)) {
      const resolved = await resolveStaffSession(req);
      if (!resolved.ok) {
        return res.status(resolved.status).json({ error: { message: resolved.error, code: resolved.code } });
      }
      staffUser = resolved.user;
    }

    const rawItems = Array.isArray(req.body?.items)
      ? req.body.items
      : (req.body && typeof req.body === "object" && req.body.person_id ? [req.body] : []);
    if (rawItems.length === 0) {
      return res.json({ synced: 0, results: [] });
    }
    if (rawItems.length > 50) {
      return res.status(400).json({ error: { message: "Offline sync batch exceeds maximum of 50 items per request." } });
    }

    const OFFLINE_UNVERIFIED_TAG = "[OFFLINE-UNVERIFIED - Pending Review]";
    const results = [];
    let syncedCount = 0;

    for (const item of rawItems) {
      const personId = String(item?.person_id || "").trim();
      const event = String(item?.event || "").trim();
      const photo = typeof item?.photo === "string" ? item.photo.trim() : "";

      if (!personId || !["time-in", "time-out"].includes(event)) {
        results.push({ id: item?.id || null, status: "rejected", reason: "invalid_person_or_event" });
        continue;
      }
      if (!staffUser && (!photo || !photo.startsWith("data:image/"))) {
        results.push({ id: item?.id || null, status: "rejected", reason: "photo_proof_required" });
        continue;
      }

      const rawTs = parseAttendanceTimestampMs(item?.device_time);
      const nowMs = Date.now();
      const MAX_OFFLINE_AGE_MS = 60 * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(rawTs) || rawTs > nowMs + 15 * 60 * 1000 || rawTs < nowMs - MAX_OFFLINE_AGE_MS) {
        results.push({ id: item?.id || null, status: "rejected", reason: "invalid_device_time" });
        continue;
      }

      const [personRows] = await pool.query(
        "SELECT id, name, department, archived FROM persons WHERE id = ? LIMIT 1",
        [personId]
      );
      const personRow = personRows?.[0];
      if (!personRow || personRow.archived === 1 || personRow.archived === true) {
        results.push({ id: item?.id || null, status: "rejected", reason: "person_not_active" });
        continue;
      }

      const formattedTime = normalizeDahuaDeviceTime(item.device_time);
      const workDate = getWorkDateFromDeviceTime(formattedTime, event);
      const [existingRows] = await pool.query(
        "SELECT id, event, device_time FROM attendance WHERE person_id = ? AND (attendance_work_date = ? OR device_time LIKE ?)",
        [personId, workDate, `${workDate}%`]
      );
      const isDup = (existingRows || []).some((r) => {
        if (r.event !== event) return false;
        const rTs = parseAttendanceTimestampMs(r.device_time);
        return Number.isFinite(rTs) && Math.abs(rTs - rawTs) < 30 * 1000;
      }) || (existingRows || []).some((r) => r.event === event);

      if (isDup) {
        results.push({ id: item?.id || null, status: "dropped_duplicate", reason: "server_existing_event" });
        continue;
      }

      const cleanUserNotes = stripForgedVerificationTags(item?.notes);
      const tag = staffUser
        ? `Offline Synced by Staff: ${staffUser.name} (${staffUser.role})`
        : OFFLINE_UNVERIFIED_TAG;
      const finalNotes = cleanUserNotes ? `${tag} | ${cleanUserNotes}` : tag;

      try {
        await pool.query(
          "INSERT INTO attendance (person_id, name, department, event, point, method, device_time, status, ot_status, archived, photo, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
          [
            personRow.id,
            personRow.name,
            personRow.department,
            event,
            item?.point || null,
            "field-site",
            formattedTime,
            item?.status || null,
            photo || null,
            finalNotes,
          ]
        );
        syncedCount += 1;
        results.push({ id: item?.id || null, status: "synced", unverified: !staffUser });
      } catch (insErr) {
        if (insErr && (insErr.code === "ER_DUP_ENTRY" || insErr.errno === 1062)) {
          results.push({ id: item?.id || null, status: "dropped_duplicate", reason: "server_slot_conflict" });
        } else {
          results.push({ id: item?.id || null, status: "error", reason: insErr.message });
        }
      }
    }

    return res.json({ success: true, synced: syncedCount, results });
  } catch (err) {
    console.error("[Offline Sync Error]:", err.message);
    return res.status(500).json({ error: { message: err.message || "Offline sync failed." } });
  }
});

// ==========================================
// AUTOMATED STORAGE MAINTENANCE & PHOTO PRUNING
// ==========================================
const PHOTO_RETENTION_DAYS = Number(process.env.PHOTO_RETENTION_DAYS || 60);

async function pruneOldAttendancePhotos(days = PHOTO_RETENTION_DAYS) {
  try {
    const daysNum = Math.max(1, Number(days) || 60);
    const sql = `
      UPDATE attendance 
      SET photo = NULL 
      WHERE photo IS NOT NULL 
        AND device_time < DATE_SUB(NOW(), INTERVAL ? DAY)
    `;
    const [result] = await pool.query(sql, [daysNum]);
    if (result && result.affectedRows > 0) {
      console.log(`[Storage Optimization] Pruned photos from ${result.affectedRows} attendance records older than ${daysNum} days.`);
    }
    return { success: true, prunedCount: result.affectedRows, days: daysNum };
  } catch (err) {
    console.error("[Storage Optimization] Failed to prune old attendance photos:", err.message);
    return { success: false, error: err.message };
  }
}

// Storage stats endpoint for dashboard monitoring (Admin only)
app.get("/api/maintenance/storage-stats", requireAdmin, async (req, res) => {
  try {
    const [[totalRecords]] = await pool.query("SELECT COUNT(*) AS total FROM attendance");
    const [[recordsWithPhoto]] = await pool.query("SELECT COUNT(*) AS with_photo FROM attendance WHERE photo IS NOT NULL");
    const [[oldPhotosCount]] = await pool.query(
      "SELECT COUNT(*) AS old_photos FROM attendance WHERE photo IS NOT NULL AND device_time < DATE_SUB(NOW(), INTERVAL ? DAY)",
      [PHOTO_RETENTION_DAYS]
    );

    return res.json({
      totalAttendanceRecords: totalRecords?.total || 0,
      recordsWithPhotos: recordsWithPhoto?.with_photo || 0,
      photosOlderThanRetention: oldPhotosCount?.old_photos || 0,
      retentionDaysConfigured: PHOTO_RETENTION_DAYS,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Maintenance endpoint: Prune attendance photos older than N days (Admin only)
app.post("/api/maintenance/prune-photos", requireAdmin, async (req, res) => {
  try {
    const days = req.body?.days || req.query?.days || PHOTO_RETENTION_DAYS;
    const result = await pruneOldAttendancePhotos(days);
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    return res.json({
      message: `Pruned photos from ${result.prunedCount} attendance records older than ${result.days} days.`,
      prunedCount: result.prunedCount,
      days: result.days,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Maintenance endpoint: Optimize MySQL tables to reclaim freed disk space (Admin only)
app.post("/api/maintenance/optimize-tables", requireAdmin, async (req, res) => {
  try {
    const [attResult] = await pool.query("OPTIMIZE TABLE attendance");
    const [perResult] = await pool.query("OPTIMIZE TABLE persons");
    return res.json({
      message: "Tables optimized successfully.",
      attendance: attResult,
      persons: perResult,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// Serve Frontend with static caching to reduce unnecessary bandwidth downloads
const staticDir = fs.existsSync(path.join(__dirname, "build"))
  ? path.join(__dirname, "build")
  : path.join(__dirname, "public");

app.use(express.static(staticDir, {
  maxAge: "30d",
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("index.html") || filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    } else if (filePath.includes("static")) {
      res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    }
  },
}));

app.use((req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

if (process.env.SKIP_SERVER_LISTEN !== "1") {
  app.listen(PORT, () => {
    console.log(`Server running at port ${PORT}`);
    setTimeout(() => {
      regeneratePayrollPeriodsIfNeeded();
      // Storage optimization: prune photos older than retention policy on startup
      pruneOldAttendancePhotos(PHOTO_RETENTION_DAYS);
      clearHlsArtifacts();
    }, 4000);

    // Periodic daily retention cleaner (every 24 hours)
    setInterval(() => {
      pruneOldAttendancePhotos(PHOTO_RETENTION_DAYS);
    }, 24 * 60 * 60 * 1000);

    // Periodic HLS artifact cleaner (every 30 minutes)
    setInterval(() => {
      clearHlsArtifacts();
    }, 30 * 60 * 1000);
  });
} else {
  module.exports = {
    app,
    isBcryptHash,
    validatePasswordStrength,
    hashPassword,
    verifyUserPassword,
    sanitizePersonWritePayload,
    stripPasswordFromResponse,
    signStaffJwt,
    verifyStaffJwtToken,
    signFaceToken,
    verifyFaceToken,
    clearAuthUserCache,
    clearEligiblePersonsCache,
    faceTokenUsesMemory,
  };
}