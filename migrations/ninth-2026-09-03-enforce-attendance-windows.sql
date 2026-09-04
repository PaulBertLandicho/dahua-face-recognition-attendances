-- Keep only one morning-in and one afternoon-out per person per work date.
-- Determine morning-in vs afternoon-out purely by time of day (not by event field).
-- Run this after migrations/mysql-schema.sql on an existing MySQL database.

-- Step 1: Add columns if they don't already exist
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS attendance_work_date DATE NULL,
  ADD COLUMN IF NOT EXISTS attendance_slot VARCHAR(32) NULL;

-- Step 2: Backfill existing rows -- assign event and slot by time of day
UPDATE attendance a
JOIN settings s ON 1 = 1
SET
  a.attendance_work_date = DATE(a.device_time),
  a.event = CASE
    WHEN TIME(a.device_time) BETWEEN COALESCE(s.morning_start, '08:00:00') AND COALESCE(s.morning_end, '11:59:00')
      THEN 'time-in'
    WHEN TIME(a.device_time) >= COALESCE(s.afternoon_start, '13:00:00')
      AND TIME(a.device_time) <= '23:59:59'
      THEN 'time-out'
    ELSE a.event
  END,
  a.attendance_slot = CASE
    WHEN TIME(a.device_time) BETWEEN COALESCE(s.morning_start, '08:00:00') AND COALESCE(s.morning_end, '11:59:00')
      THEN 'morning_time_in'
    WHEN TIME(a.device_time) >= COALESCE(s.afternoon_start, '13:00:00')
      AND TIME(a.device_time) <= '23:59:59'
      THEN 'afternoon_time_out'
    ELSE NULL
  END
WHERE a.device_time IS NOT NULL;

-- Step 3: Remove duplicate rows -- keep only the EARLIEST scan per person per day per slot
DELETE older
FROM attendance older
JOIN attendance newer
  ON newer.person_id = older.person_id
 AND newer.attendance_work_date = older.attendance_work_date
 AND newer.attendance_slot = older.attendance_slot
   AND (
     newer.device_time < older.device_time
     OR (newer.device_time = older.device_time AND newer.id < older.id)
   )
WHERE older.attendance_slot IS NOT NULL;

-- Step 4: Add unique constraint to enforce one record per slot per person per day
ALTER TABLE attendance
  ADD UNIQUE KEY idx_attendance_person_day_slot
    (person_id, attendance_work_date, attendance_slot);

-- Step 5: Drop old triggers if they exist and recreate
DROP TRIGGER IF EXISTS attendance_before_insert_slot;
DROP TRIGGER IF EXISTS attendance_before_update_slot;

DELIMITER $$

CREATE TRIGGER attendance_before_insert_slot
BEFORE INSERT ON attendance
FOR EACH ROW
BEGIN
  DECLARE configured_morning_start TIME DEFAULT '08:00:00';
  DECLARE configured_morning_end TIME DEFAULT '11:59:00';
  DECLARE configured_afternoon_start TIME DEFAULT '13:00:00';

  SELECT COALESCE(morning_start, '08:00:00'),
         COALESCE(morning_end, '11:59:00'),
         COALESCE(afternoon_start, '13:00:00')
    INTO configured_morning_start, configured_morning_end, configured_afternoon_start
    FROM settings ORDER BY id LIMIT 1;

  SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time));

  -- Assign event AND slot purely by time of day
  IF TIME(NEW.device_time) BETWEEN configured_morning_start AND configured_morning_end THEN
    SET NEW.event = 'time-in';
    SET NEW.attendance_slot = 'morning_time_in';
  ELSEIF TIME(NEW.device_time) >= configured_afternoon_start THEN
    SET NEW.event = 'time-out';
    SET NEW.attendance_slot = 'afternoon_time_out';
  ELSE
    SET NEW.attendance_slot = NULL;
  END IF;
END$$

CREATE TRIGGER attendance_before_update_slot
BEFORE UPDATE ON attendance
FOR EACH ROW
BEGIN
  DECLARE configured_morning_start TIME DEFAULT '08:00:00';
  DECLARE configured_morning_end TIME DEFAULT '11:59:00';
  DECLARE configured_afternoon_start TIME DEFAULT '13:00:00';

  SELECT COALESCE(morning_start, '08:00:00'),
         COALESCE(morning_end, '11:59:00'),
         COALESCE(afternoon_start, '13:00:00')
    INTO configured_morning_start, configured_morning_end, configured_afternoon_start
    FROM settings ORDER BY id LIMIT 1;

  SET NEW.attendance_work_date = IF(NEW.device_time IS NULL, NULL, DATE(NEW.device_time));

  -- Assign event AND slot purely by time of day
  IF TIME(NEW.device_time) BETWEEN configured_morning_start AND configured_morning_end THEN
    SET NEW.event = 'time-in';
    SET NEW.attendance_slot = 'morning_time_in';
  ELSEIF TIME(NEW.device_time) >= configured_afternoon_start THEN
    SET NEW.event = 'time-out';
    SET NEW.attendance_slot = 'afternoon_time_out';
  ELSE
    SET NEW.attendance_slot = NULL;
  END IF;
END$$

DELIMITER ;