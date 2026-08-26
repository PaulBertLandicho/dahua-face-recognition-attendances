-- Payroll days can be fractional when attendance covers only part of a workday.
ALTER TABLE public.payroll_periods
  ALTER COLUMN days_present TYPE numeric(10,3)
  USING days_present::numeric;

ALTER TABLE public.payroll_released_history
  ALTER COLUMN days_present TYPE numeric(10,3)
  USING days_present::numeric;