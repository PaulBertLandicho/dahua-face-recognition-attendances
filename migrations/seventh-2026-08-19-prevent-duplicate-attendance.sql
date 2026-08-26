-- Remove duplicate attendance scans before enforcing the scan identity.
WITH duplicate_rows AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        coalesce(person_id, ''),
        coalesce(event, ''),
        coalesce(point, ''),
        coalesce(method, ''),
        device_time
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS row_number
  FROM public.attendance
)
DELETE FROM public.attendance a
USING duplicate_rows d
WHERE a.id = d.id
  AND d.row_number > 1;

-- Treat null values as equal so repeated unassigned Dahua scans are blocked too.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_scan_identity
ON public.attendance (
  coalesce(person_id, ''),
  coalesce(event, ''),
  coalesce(point, ''),
  coalesce(method, ''),
  device_time
);