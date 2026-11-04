// fetchHolidays.js
// Fetch holidays for a department and month from MySQL
import { supabase } from "../mysqlClient";

/**
 * Fetch holidays for a department and month/year
 * @param {string} department
 * @param {number} month (1-12)
 * @param {number} year
 * @returns {Promise<Array<{date: string, type: string, description: string}>>}
 */
export async function fetchHolidays(department, month, year) {
  let query = supabase.from("holidays").select("date, type, description, department");
  if (month) query = query.eq("month", month);
  if (year) query = query.eq("year", year);
  const { data, error } = await query;
  if (error) throw error;
  const targetDept = String(department || "").toLowerCase().trim();
  return (data || []).filter((h) => {
    const hDept = String(h.department || "").toLowerCase().trim();
    return !hDept || hDept === targetDept;
  });
}
