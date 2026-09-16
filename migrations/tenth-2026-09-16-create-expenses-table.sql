-- Migration: Create expenses table for employee payroll expense deductions
CREATE TABLE IF NOT EXISTS `expenses` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `person_id` VARCHAR(191) NOT NULL,
  `period` VARCHAR(100) NULL,
  `item_name` VARCHAR(255) NOT NULL,
  `amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `expense_date` DATE NULL,
  `note` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_expenses_person` (`person_id`),
  INDEX `idx_expenses_period` (`period`),
  CONSTRAINT `fk_expenses_person_id` FOREIGN KEY (`person_id`) REFERENCES `persons` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
