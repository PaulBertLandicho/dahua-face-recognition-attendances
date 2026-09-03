-- Keep only one morning-in and one afternoon-out per person per work date.
-- Run this after migrations/mysql-schema.sql on an existing MySQL database.

ALTER TABLE attendance
  ADD COLUMN attendance_work_date DATE NULL,
  ADD COLUMN attendance_slot VARCHAR(32) NULL;

UPDATE attendance a
JOIN settings s ON 1 = 1
SET
  a.attendance_work_date = DATE(a.device_time),
  a.attendance_slot = CASE
    WHEN LOWER(COALESCE(a.event, '')) = 'time-in'
      AND TIME(a.device_time) BETWEEN COALESCE(s.morning_start, '08:00:00') AND COALESCE(s.morning_end, '11:59:00')
      THEN 'morning_time_in'
    WHEN LOWER(COALESCE(a.event, '')) = 'time-out'
      AND TIME(a.device_time) >= COALESCE(s.afternoon_start, '13:00:00')
      AND TIME(a.device_time) <= '23:59:59'
      THEN 'afternoon_time_out'
    ELSE NULL
  END
WHERE a.device_time IS NOT NULL;

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

ALTER TABLE attendance
  ADD UNIQUE KEY idx_attendance_person_day_slot
    (person_id, attendance_work_date, attendance_slot);

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
  SET NEW.attendance_slot = CASE
    WHEN LOWER(COALESCE(NEW.event, '')) = 'time-in'
      AND TIME(NEW.device_time) BETWEEN configured_morning_start AND configured_morning_end
      THEN 'morning_time_in'
    WHEN LOWER(COALESCE(NEW.event, '')) = 'time-out'
      AND TIME(NEW.device_time) >= configured_afternoon_start
      THEN 'afternoon_time_out'
    ELSE NULL
  END;
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
  SET NEW.attendance_slot = CASE
    WHEN LOWER(COALESCE(NEW.event, '')) = 'time-in'
      AND TIME(NEW.device_time) BETWEEN configured_morning_start AND configured_morning_end
      THEN 'morning_time_in'
    WHEN LOWER(COALESCE(NEW.event, '')) = 'time-out'
      AND TIME(NEW.device_time) >= configured_afternoon_start
      THEN 'afternoon_time_out'
    ELSE NULL
  END;
END$$

DELIMITER ;