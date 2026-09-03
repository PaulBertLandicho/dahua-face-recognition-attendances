-- =============================================================================
-- MySQL Database Schema: Dahua Face Recognition & Attendance System
-- File: migrations/mysql-schema.sql
-- Description: Complete, unified MySQL schema containing all tables, constraints,
--              indexes, triggers, and seed data consolidated into a single file
--              ready for direct import.
-- Compatible with: MySQL 5.7+, MySQL 8.0+, MariaDB 10.3+
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. INITIAL CONFIGURATION & SAFETY CHECKS
-- -----------------------------------------------------------------------------
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";

-- -----------------------------------------------------------------------------
-- 2. CLEANUP / RESET EXISTING OBJECTS (IN REVERSE DEPENDENCY ORDER)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `trg_department_rates_after_insert`;
DROP TRIGGER IF EXISTS `trg_department_rates_after_update`;
DROP TRIGGER IF EXISTS `trg_settings_before_insert`;
DROP TRIGGER IF EXISTS `trg_payroll_periods_before_insert`;
DROP TRIGGER IF EXISTS `trg_sync_payroll_released_history_after_update`;

DROP TABLE IF EXISTS `payroll_activity_logs`;
DROP TABLE IF EXISTS `payroll_released_history`;
DROP TABLE IF EXISTS `payroll_periods`;
DROP TABLE IF EXISTS `attendance`;
DROP TABLE IF EXISTS `cash_advances`;
DROP TABLE IF EXISTS `holidays`;
DROP TABLE IF EXISTS `department_rates`;
DROP TABLE IF EXISTS `settings`;
DROP TABLE IF EXISTS `persons`;

-- -----------------------------------------------------------------------------
-- 3. TABLE: persons
-- -----------------------------------------------------------------------------
CREATE TABLE `persons` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(255) NULL,
  `department` VARCHAR(255) NULL,
  `created_at` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `descriptor` JSON NULL COMMENT '128-dimensional float face descriptor vector',
  `daily_rate` DECIMAL(10, 2) NULL DEFAULT 500.00,
  `late_penalty` DECIMAL(10, 2) NULL DEFAULT 50.00,
  `phone_number` VARCHAR(50) NULL,
  `address` TEXT NULL,
  `sex` VARCHAR(20) NULL,
  `approved` TINYINT(1) NOT NULL DEFAULT 0,
  `archived` TINYINT(1) NOT NULL DEFAULT 0,
  `registration_photo` LONGTEXT NULL COMMENT 'Base64 image or photo URL',
  `sss` VARCHAR(50) NULL,
  `pag_ibig` VARCHAR(50) NULL,
  `philhealth` VARCHAR(50) NULL,
  `cash_advance` DECIMAL(10, 2) NULL DEFAULT 0.00,
  `email` VARCHAR(191) NULL,
  `password` VARCHAR(255) NULL COMMENT 'Plain or hashed password for authentication',
  `role` VARCHAR(50) NOT NULL DEFAULT 'employee',
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_email` (`email`),
  KEY `idx_persons_department` (`department`),
  KEY `idx_persons_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 4. TABLE: department_rates
-- -----------------------------------------------------------------------------
CREATE TABLE `department_rates` (
  `department` VARCHAR(191) NOT NULL,
  `daily_rate` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `late_penalty` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `updated_at` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `sss` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `pag_ibig` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `philhealth` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `cash_advance` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `holiday_rate` DECIMAL(10, 2) NULL DEFAULT 0.00,
  `ot_rate` DECIMAL(10, 2) NULL DEFAULT 0.00,
  `regular_holiday_rate` DECIMAL(10, 2) NULL DEFAULT 0.00,
  `special_holiday_rate` DECIMAL(10, 2) NULL DEFAULT 0.00,
  PRIMARY KEY (`department`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 5. TABLE: settings
-- -----------------------------------------------------------------------------
CREATE TABLE `settings` (
  `id` INT NOT NULL DEFAULT 1,
  `morning_start` TIME NOT NULL DEFAULT '08:00:00',
  `morning_end` TIME NOT NULL DEFAULT '11:59:00',
  `afternoon_start` TIME NOT NULL DEFAULT '13:00:00',
  `afternoon_end` TIME NOT NULL DEFAULT '17:00:00',
  `updated_at` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `morning_grace_minutes` INT NULL DEFAULT 15,
  `afternoon_grace_minutes` INT NULL DEFAULT 15,
  `late_count_limit` INT NULL DEFAULT 5,
  `late_penalty` INT NULL DEFAULT 50,
  `payroll_period_days` INT NOT NULL DEFAULT 15,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 6. TABLE: attendance
-- -----------------------------------------------------------------------------
CREATE TABLE `attendance` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `person_id` VARCHAR(191) NULL,
  `name` VARCHAR(255) NULL,
  `department` VARCHAR(255) NULL,
  `event` VARCHAR(50) NULL,
  `point` VARCHAR(50) NULL,
  `method` VARCHAR(50) NULL,
  `device_time` DATETIME NULL,
  `attendance_work_date` DATE NULL,
  `attendance_slot` VARCHAR(32) NULL,
  `created_at` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `status` VARCHAR(50) NULL,
  `archived` TINYINT(1) NULL DEFAULT 0,
  `photo` LONGTEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_attendance_person` (`person_id`),
  KEY `idx_attendance_device_time` (`device_time`),
  KEY `idx_attendance_work_slot` (`person_id`, `attendance_work_date`, `attendance_slot`),
  KEY `idx_attendance_created_at` (`created_at`),
  UNIQUE KEY `idx_attendance_scan_identity` (`person_id`, `event`, `point`, `method`, `device_time`),
  CONSTRAINT `fk_attendance_person_id` FOREIGN KEY (`person_id`) REFERENCES `persons` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER attendance_before_insert_slot
BEFORE INSERT ON attendance
FOR EACH ROW
BEGIN
  DECLARE configured_morning_start TIME DEFAULT '08:00:00';
  DECLARE configured_morning_end TIME DEFAULT '11:59:00';
  DECLARE configured_afternoon_start TIME DEFAULT '13:00:00';

  SELECT COALESCE(morning_start, '08:00:00'), COALESCE(morning_end, '11:59:00'),
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

  SELECT COALESCE(morning_start, '08:00:00'), COALESCE(morning_end, '11:59:00'),
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

-- -----------------------------------------------------------------------------
-- 7. TABLE: cash_advances
-- -----------------------------------------------------------------------------
CREATE TABLE `cash_advances` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `person_id` VARCHAR(191) NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `note` TEXT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cash_advances_person` (`person_id`),
  CONSTRAINT `fk_cash_advances_person_id` FOREIGN KEY (`person_id`) REFERENCES `persons` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 8. TABLE: holidays
-- -----------------------------------------------------------------------------
CREATE TABLE `holidays` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `department` VARCHAR(255) NULL,
  `date` DATE NOT NULL,
  `type` VARCHAR(50) NOT NULL,
  `month` INT NOT NULL,
  `year` INT NOT NULL,
  `created_at` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_holidays_dept_month_year` (`department`(191), `month`, `year`),
  KEY `idx_holidays_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 9. TABLE: payroll_periods
-- -----------------------------------------------------------------------------
CREATE TABLE `payroll_periods` (
  `id` VARCHAR(36) NOT NULL,
  `person_id` VARCHAR(191) NULL,
  `period` VARCHAR(100) NOT NULL,
  `days_present` DECIMAL(10, 3) NOT NULL DEFAULT 0.000,
  `daily_rate` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `late_penalty` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `late_count` INT NOT NULL DEFAULT 0,
  `gross` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `total_late_deduction` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `total_deductions` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `net` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `released` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_person_period` (`person_id`, `period`),
  KEY `idx_payroll_periods_person_id` (`person_id`),
  KEY `idx_payroll_periods_period` (`period`),
  CONSTRAINT `fk_payroll_periods_person_id` FOREIGN KEY (`person_id`) REFERENCES `persons` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 10. TABLE: payroll_activity_logs
-- -----------------------------------------------------------------------------
CREATE TABLE `payroll_activity_logs` (
  `id` VARCHAR(36) NOT NULL,
  `person_name` VARCHAR(255) NULL,
  `released_by` VARCHAR(255) NOT NULL,
  `action` VARCHAR(100) NOT NULL,
  `timestamp` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `payroll_period_id` VARCHAR(36) NOT NULL,
  `person_id` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_payroll_activity_logs_period` (`payroll_period_id`),
  KEY `idx_payroll_activity_logs_person` (`person_id`),
  CONSTRAINT `fk_payroll_activity_logs_period` FOREIGN KEY (`payroll_period_id`) REFERENCES `payroll_periods` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 11. TABLE: payroll_released_history
-- -----------------------------------------------------------------------------
CREATE TABLE `payroll_released_history` (
  `id` VARCHAR(36) NOT NULL,
  `payroll_period_id` VARCHAR(36) NOT NULL,
  `person_id` VARCHAR(191) NOT NULL,
  `person_name` VARCHAR(255) NULL,
  `department` VARCHAR(255) NULL,
  `period` VARCHAR(100) NOT NULL,
  `days_present` DECIMAL(10, 3) NOT NULL DEFAULT 0.000,
  `daily_rate` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `late_penalty` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `late_count` INT NOT NULL DEFAULT 0,
  `gross` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `total_late_deduction` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `total_deductions` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `net` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `detailed_attendance` JSON NOT NULL,
  `released` TINYINT(1) NOT NULL DEFAULT 1,
  `action` VARCHAR(100) NOT NULL DEFAULT 'Released',
  `released_by` VARCHAR(255) NULL,
  `released_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `payroll_released_history_payroll_period_id_key` (`payroll_period_id`),
  KEY `payroll_released_history_person_id_idx` (`person_id`),
  KEY `payroll_released_history_period_idx` (`period`),
  KEY `payroll_released_history_released_at_idx` (`released_at`),
  CONSTRAINT `fk_payroll_released_history_person` FOREIGN KEY (`person_id`) REFERENCES `persons` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 12. TRIGGERS
-- -----------------------------------------------------------------------------
DELIMITER $$

-- Sync rate and penalty changes in department_rates to persons of matching department
CREATE TRIGGER `trg_department_rates_after_insert`
AFTER INSERT ON `department_rates`
FOR EACH ROW
BEGIN
  UPDATE `persons`
  SET
    `daily_rate` = NEW.`daily_rate`,
    `late_penalty` = NEW.`late_penalty`,
    `cash_advance` = NEW.`cash_advance`
  WHERE `department` = NEW.`department`;
END$$

CREATE TRIGGER `trg_department_rates_after_update`
AFTER UPDATE ON `department_rates`
FOR EACH ROW
BEGIN
  UPDATE `persons`
  SET
    `daily_rate` = NEW.`daily_rate`,
    `late_penalty` = NEW.`late_penalty`,
    `cash_advance` = NEW.`cash_advance`
  WHERE `department` = NEW.`department`;
END$$

-- Ensure only single settings configuration row exists (id = 1)
CREATE TRIGGER `trg_settings_before_insert`
BEFORE INSERT ON `settings`
FOR EACH ROW
BEGIN
  IF (SELECT COUNT(*) FROM `settings`) >= 1 THEN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Only one settings row is allowed.';
  END IF;
END$$

-- Auto-generate UUID for payroll_periods if not explicitly provided
CREATE TRIGGER `trg_payroll_periods_before_insert`
BEFORE INSERT ON `payroll_periods`
FOR EACH ROW
BEGIN
  IF NEW.`id` IS NULL OR NEW.`id` = '' THEN
    SET NEW.`id` = UUID();
  END IF;
END$$

-- Automatically snapshot payroll periods to payroll_released_history on release
CREATE TRIGGER `trg_sync_payroll_released_history_after_update`
AFTER UPDATE ON `payroll_periods`
FOR EACH ROW
BEGIN
  IF NEW.`released` = 1 AND (OLD.`released` IS NULL OR OLD.`released` = 0) THEN
    INSERT INTO `payroll_released_history` (
      `id`,
      `payroll_period_id`,
      `person_id`,
      `person_name`,
      `department`,
      `period`,
      `days_present`,
      `daily_rate`,
      `late_penalty`,
      `late_count`,
      `gross`,
      `total_late_deduction`,
      `total_deductions`,
      `net`,
      `detailed_attendance`,
      `released`,
      `action`,
      `released_by`,
      `released_at`,
      `created_at`,
      `updated_at`
    )
    SELECT
      UUID(),
      NEW.`id`,
      NEW.`person_id`,
      p.`name`,
      p.`department`,
      NEW.`period`,
      NEW.`days_present`,
      NEW.`daily_rate`,
      NEW.`late_penalty`,
      NEW.`late_count`,
      NEW.`gross`,
      NEW.`total_late_deduction`,
      NEW.`total_deductions`,
      NEW.`net`,
      JSON_ARRAY(),
      1,
      'Released',
      NULL,
      NOW(),
      NOW(),
      NOW()
    FROM `persons` p
    WHERE p.`id` = NEW.`person_id`
    ON DUPLICATE KEY UPDATE
      `person_id` = VALUES(`person_id`),
      `person_name` = VALUES(`person_name`),
      `department` = VALUES(`department`),
      `period` = VALUES(`period`),
      `days_present` = VALUES(`days_present`),
      `daily_rate` = VALUES(`daily_rate`),
      `late_penalty` = VALUES(`late_penalty`),
      `late_count` = VALUES(`late_count`),
      `gross` = VALUES(`gross`),
      `total_late_deduction` = VALUES(`total_late_deduction`),
      `total_deductions` = VALUES(`total_deductions`),
      `net` = VALUES(`net`),
      `detailed_attendance` = VALUES(`detailed_attendance`),
      `released` = VALUES(`released`),
      `action` = VALUES(`action`),
      `released_at` = VALUES(`released_at`),
      `updated_at` = NOW();
  END IF;
END$$

DELIMITER ;

-- -----------------------------------------------------------------------------
-- 13. SEED / INITIAL DEFAULT DATA
-- -----------------------------------------------------------------------------

-- Default system settings
INSERT INTO `settings` (
  `id`,
  `morning_start`,
  `morning_end`,
  `afternoon_start`,
  `afternoon_end`,
  `morning_grace_minutes`,
  `afternoon_grace_minutes`,
  `late_count_limit`,
  `late_penalty`,
  `payroll_period_days`,
  `updated_at`
)
VALUES (
  1,
  '08:10:00',
  '11:59:00',
  '13:10:00',
  '17:00:00',
  15,
  59,
  1,
  50,
  15,
  NOW()
)
ON DUPLICATE KEY UPDATE
  `morning_start` = VALUES(`morning_start`),
  `morning_end` = VALUES(`morning_end`),
  `afternoon_start` = VALUES(`afternoon_start`),
  `afternoon_end` = VALUES(`afternoon_end`),
  `morning_grace_minutes` = VALUES(`morning_grace_minutes`),
  `afternoon_grace_minutes` = VALUES(`afternoon_grace_minutes`),
  `late_count_limit` = VALUES(`late_count_limit`),
  `late_penalty` = VALUES(`late_penalty`),
  `payroll_period_days` = VALUES(`payroll_period_days`),
  `updated_at` = NOW();

-- Default department rates
INSERT INTO `department_rates` (
  `department`,
  `daily_rate`,
  `late_penalty`,
  `sss`,
  `pag_ibig`,
  `philhealth`,
  `cash_advance`,
  `holiday_rate`,
  `ot_rate`,
  `regular_holiday_rate`,
  `special_holiday_rate`,
  `updated_at`
) VALUES
('Admin', 550.00, 5.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 100.00, 30.00, NOW()),
('HR', 400.00, 3.00, 5.00, 10.00, 15.00, 0.00, 0.00, 0.00, 100.00, 30.00, NOW()),
('IT', 450.00, 5.00, 10.00, 15.00, 15.00, 150.00, 5.00, 0.00, 100.00, 30.00, NOW()),
('Technical', 438.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 100.00, 30.00, NOW())
ON DUPLICATE KEY UPDATE
  `daily_rate` = VALUES(`daily_rate`),
  `late_penalty` = VALUES(`late_penalty`),
  `sss` = VALUES(`sss`),
  `pag_ibig` = VALUES(`pag_ibig`),
  `philhealth` = VALUES(`philhealth`),
  `cash_advance` = VALUES(`cash_advance`),
  `holiday_rate` = VALUES(`holiday_rate`),
  `ot_rate` = VALUES(`ot_rate`),
  `regular_holiday_rate` = VALUES(`regular_holiday_rate`),
  `special_holiday_rate` = VALUES(`special_holiday_rate`),
  `updated_at` = NOW();

-- Default Admin & Secretary User Accounts
INSERT INTO `persons` (
  `id`,
  `name`,
  `department`,
  `email`,
  `password`,
  `role`,
  `approved`,
  `daily_rate`,
  `late_penalty`,
  `created_at`
) VALUES
(
  'ADMIN-001',
  'Multifactors Admin',
  'Admin',
  'multifactors-sales@gmail.com',
  'admin123',
  'admin',
  1,
  550.00,
  5.00,
  NOW()
),
(
  'STAFF-001',
  'Attendance Secretary',
  'Admin',
  'attendance@gmail.com',
  'secretary123',
  'secretary',
  1,
  550.00,
  5.00,
  NOW()
)
ON DUPLICATE KEY UPDATE
  `role` = VALUES(`role`),
  `approved` = VALUES(`approved`),
  `password` = VALUES(`password`);

-- -----------------------------------------------------------------------------
-- 14. RESTORE CONFIGURATION
-- -----------------------------------------------------------------------------
SET FOREIGN_KEY_CHECKS = 1;
