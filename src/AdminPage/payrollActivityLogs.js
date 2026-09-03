import { supabase } from "../mysqlClient";
import Swal from "sweetalert2";

// Insert a release activity log. personName is stored for readability;
// personId is no longer required so this works even if that column
// does not exist in the payroll_activity_logs table.
export async function logPayrollRelease({
  payrollPeriodId,
  personName,
  releasedBy,
}) {
  const { error } = await supabase.from("payroll_activity_logs").insert([
    {
      payroll_period_id: payrollPeriodId,
      person_name: personName || null,
      released_by: releasedBy,
      action: "Released",
      timestamp: new Date().toISOString(),
    },
  ]);
  if (error) {
    console.error("Failed to insert payroll activity log:", error);
    Swal.fire(
      "Failed to insert payroll activity log",
      error.message || error,
      "error"
    );
    throw error;
  }
}
// Usage: logPayrollRelease({ payrollPeriodId, personName, releasedBy })
