import React, { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { FiSun, FiMoon, FiAlertTriangle, FiCalendar } from "react-icons/fi";
import Icon from "../components/Icon";
import { supabase } from "../supabaseClient";
import HolidayManagerGlobal from "./HolidayManager";

const DEFAULT_SETTINGS = {
  morning_start: "08:00",
  morning_end: "11:59",
  afternoon_start: "13:00",
  afternoon_end: "17:00",
  morning_grace_minutes: 15,
  afternoon_grace_minutes: 15,
  late_count_limit: 5,
  payroll_period_days: 15,
};

export default function AdminSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("work_hours");

  useEffect(() => {
    async function fetchSettings() {
      try {
        const { data, error } = await supabase
          .from("settings")
          .select("*")
          .eq("id", 1)
          .maybeSingle();

        if (!error && data) {
          setSettings({
            morning_start: data.morning_start
              ? data.morning_start.slice(0, 5)
              : DEFAULT_SETTINGS.morning_start,
            morning_end: data.morning_end
              ? data.morning_end.slice(0, 5)
              : DEFAULT_SETTINGS.morning_end,
            afternoon_start: data.afternoon_start
              ? data.afternoon_start.slice(0, 5)
              : DEFAULT_SETTINGS.afternoon_start,
            afternoon_end: data.afternoon_end
              ? data.afternoon_end.slice(0, 5)
              : DEFAULT_SETTINGS.afternoon_end,
            morning_grace_minutes: Number.isFinite(data.morning_grace_minutes)
              ? data.morning_grace_minutes
              : DEFAULT_SETTINGS.morning_grace_minutes,
            afternoon_grace_minutes: Number.isFinite(
              data.afternoon_grace_minutes,
            )
              ? data.afternoon_grace_minutes
              : DEFAULT_SETTINGS.afternoon_grace_minutes,
            late_count_limit: Number.isFinite(data.late_count_limit)
              ? data.late_count_limit
              : DEFAULT_SETTINGS.late_count_limit,
            payroll_period_days: Number.isFinite(data.payroll_period_days)
              ? data.payroll_period_days
              : DEFAULT_SETTINGS.payroll_period_days,
          });
        } else if (!error) {
          setSettings(DEFAULT_SETTINGS);
        }
      } catch (e) {
        console.error("Error fetching settings:", e);
      }
    }
    fetchSettings();
  }, []);

  const handleChange = (e) => {
    const { name, value, type } = e.target;
    setSettings({
      ...settings,
      [name]: type === "number" ? parseInt(value) || 0 : value,
    });
  };

  const handleSave = async () => {
    setSaving(true);

    const payload = {
      id: 1,
      morning_start: settings.morning_start,
      morning_end: settings.morning_end,
      afternoon_start: settings.afternoon_start,
      afternoon_end: settings.afternoon_end,
      morning_grace_minutes: Number(settings.morning_grace_minutes) || 0,
      afternoon_grace_minutes: Number(settings.afternoon_grace_minutes) || 0,
      late_count_limit: Number(settings.late_count_limit) || 0,
      payroll_period_days: Number(settings.payroll_period_days) || 15,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("settings")
      .upsert(payload, { onConflict: "id" });

    if (error) {
      Swal.fire("Error saving", error.message, "error");
    } else {
      Swal.fire("Settings updated!", "", "success");
    }

    setSaving(false);
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Settings</h1>
        <div style={styles.titleUnderline} />
      </div>

      {/* Tab Switcher */}
      <div style={styles.tabContainer}>
        <div style={styles.tabWrapper}>
          <button
            style={activeTab === "work_hours" ? { ...styles.tabBtn, ...styles.tabBtnActive } : styles.tabBtn}
            onClick={() => setActiveTab("work_hours")}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              Work Hours Settings
            </span>
          </button>
          <button
            style={activeTab === "holidays" ? { ...styles.tabBtn, ...styles.tabBtnActive } : styles.tabBtn}
            onClick={() => setActiveTab("holidays")}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
              Manage Holidays
            </span>
          </button>
        </div>
      </div>

      {activeTab === "work_hours" && (
        <>
          {/* Three cards in a row */}
          <div style={styles.cardsRow}>
        {/* Morning Shift Card */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIcon}>
              <Icon as={FiSun} size={28} ariaLabel="Morning shift" />
            </span>
            <h2 style={styles.cardTitle}>Morning Shift</h2>
          </div>
          <div style={styles.inputGroup}>
            <label htmlFor="morning_start" style={styles.label}>
              Start Time
            </label>
            <input
              type="time"
              id="morning_start"
              name="morning_start"
              value={settings.morning_start}
              onChange={handleChange}
              style={styles.input}
            />
          </div>
          <div style={styles.inputGroup}>
            <label htmlFor="morning_end" style={styles.label}>
              End Time
            </label>
            <input
              type="time"
              id="morning_end"
              name="morning_end"
              value={settings.morning_end}
              onChange={handleChange}
              style={styles.input}
              disabled
            />
          </div>
          <div style={styles.inputGroup}>
            <label htmlFor="morning_grace_minutes" style={styles.label}>
              Grace Period
            </label>
            <div style={styles.numberInputWrapper}>
              <input
                type="number"
                id="morning_grace_minutes"
                name="morning_grace_minutes"
                value={settings.morning_grace_minutes}
                onChange={handleChange}
                min="0"
                step="1"
                style={styles.numberInput}
              />
              <span style={styles.inputSuffix}>min</span>
            </div>
            <span style={styles.hint}>
              Minutes after start considered on-time
            </span>
          </div>
        </div>

        {/* Afternoon Shift Card */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIcon}>
              <Icon as={FiMoon} size={28} ariaLabel="Afternoon shift" />
            </span>
            <h2 style={styles.cardTitle}>Afternoon Shift</h2>
          </div>
          <div style={styles.inputGroup}>
            <label htmlFor="afternoon_start" style={styles.label}>
              Start Time
            </label>
            <input
              type="time"
              id="afternoon_start"
              name="afternoon_start"
              value={settings.afternoon_start}
              onChange={handleChange}
              style={styles.input}
              disabled
            />
          </div>
          <div style={styles.inputGroup}>
            <label htmlFor="afternoon_end" style={styles.label}>
              End Time
            </label>
            <input
              type="time"
              id="afternoon_end"
              name="afternoon_end"
              value={settings.afternoon_end}
              onChange={handleChange}
              style={styles.input}
            />
          </div>
          <div style={styles.inputGroup}>
            <label htmlFor="afternoon_grace_minutes" style={styles.label}>
              Grace Period
            </label>
            <div style={styles.numberInputWrapper}>
              <input
                type="number"
                id="afternoon_grace_minutes"
                name="afternoon_grace_minutes"
                value={settings.afternoon_grace_minutes}
                onChange={handleChange}
                min="0"
                step="1"
                style={styles.numberInput}
              />
              <span style={styles.inputSuffix}>min</span>
            </div>
            <span style={styles.hint}>
              Minutes after start considered on-time
            </span>
          </div>
        </div>

        {/* Late Count Limit Card */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIcon}>
              <Icon as={FiAlertTriangle} size={24} ariaLabel="Warning" />
            </span>
            <h2 style={styles.cardTitle}>Late Count Limit</h2>
          </div>
          <div style={styles.inputGroup}>
            <label htmlFor="late_count_limit" style={styles.label}>
              Limit
            </label>
            <div style={styles.numberInputWrapper}>
              <input
                type="number"
                id="late_count_limit"
                name="late_count_limit"
                value={settings.late_count_limit}
                onChange={handleChange}
                min="1"
                step="1"
                style={styles.numberInput}
              />
              <span style={styles.inputSuffix}>occurrences</span>
            </div>
            <span style={styles.hint}>Late occurrences before deduction</span>
          </div>
          <div style={{ height: "1px", background: "#f3f4f6", margin: "24px 0" }} />
          <div style={{ ...styles.cardHeader, marginBottom: "20px" }}>
            <span style={styles.cardIcon}>
              <Icon as={FiCalendar} size={24} ariaLabel="Payroll calendar" />
            </span>
            <h2 style={styles.cardTitle}>Payroll Period Length</h2>
          </div>
          <div style={styles.inputGroup}>
            <label htmlFor="payroll_period_days" style={styles.label}>
              Days per Payroll Period
            </label>
            <div style={styles.numberInputWrapper}>
              <input
                type="number"
                id="payroll_period_days"
                name="payroll_period_days"
                value={settings.payroll_period_days}
                onChange={handleChange}
                min="1"
                max="31"
                step="1"
                style={styles.numberInput}
              />
              <span style={styles.inputSuffix}>days</span>
            </div>
            <span style={styles.hint}>
              Number of days in each payroll period (default: 15)
            </span>
          </div>
        </div>

        {/* Payroll Period Days Card */}
        {/* <div style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIcon}><Icon as={FiCalendar} size={20} ariaLabel="Payroll calendar small" /></span>
            <h2 style={styles.cardTitle}>Payroll Period Length</h2>
          </div>
          <div style={styles.inputGroup}>
            <label style={styles.label}>Days per Payroll Period</label>
            <div style={styles.numberInputWrapper}>
              <input
                type="number"
                name="payroll_period_days"
                value={settings.payroll_period_days}
                onChange={handleChange}
                min="1"
                max="31"
                step="1"
                style={styles.numberInput}
              />
              <span style={styles.inputSuffix}>days</span>
            </div>
            <span style={styles.hint}>Number of days in each payroll period (default: 15)</span>
          </div>
        </div> */}
      </div>
        {/* Action Buttons */}
        <div style={styles.actions}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              ...styles.button,
              ...styles.buttonPrimary,
              opacity: saving ? 0.7 : 1,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
        </>
      )}

      {activeTab === "holidays" && (
        <div style={{ marginTop: "24px" }}>
          {/* Global Holiday Manager (applies to all departments) */}
          <HolidayManagerGlobal />
        </div>
      )}
    </div>
  );
}

// Light theme styles with green accent
const styles = {
  container: {
    margin: "0 auto",
    padding: "36px 28px",
    maxWidth: "1100px",
    background: "#ffffff",
    minHeight: "100vh",
    color: "#1f2937",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  header: {
    textAlign: "center",
    marginBottom: "24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
  },
  title: {
    fontSize: "2.5rem",
    fontWeight: 800,
    margin: 0,
    letterSpacing: "-0.02em",
    color: "#1a252f",
  },
  titleUnderline: {
    height: "4px",
    width: "40px",
    background: "#237227", // solid green
    margin: "8px auto 0",
    borderRadius: "2px",
  },
  tabContainer: {
    display: "flex",
    justifyContent: "center",
    marginBottom: "36px",
  },
  tabWrapper: {
    display: "inline-flex",
    backgroundColor: "#f3f4f6",
    borderRadius: "8px",
    padding: "4px",
    border: "1px solid #e5e7eb",
  },
  tabBtn: {
    padding: "10px 20px",
    borderRadius: "6px",
    border: "none",
    background: "transparent",
    color: "#6b7280",
    fontSize: "0.95rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.2s ease-in-out",
  },
  tabBtnActive: {
    background: "#237227",
    color: "#ffffff",
    boxShadow: "0 2px 4px rgba(35, 114, 39, 0.2)",
  },
  cardsRow: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "24px",
    marginBottom: "36px",
  },
  card: {
    background: "#ffffff",
    borderRadius: "16px",
    padding: "32px 24px",
    border: "1px solid #f3f4f6",
    boxShadow: "0 4px 20px rgba(0, 0, 0, 0.04)",
    display: "flex",
    flexDirection: "column",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "28px",
  },
  cardIcon: {
    fontSize: "1.6rem",
    color: "#374151",
  },
  cardTitle: {
    fontSize: "1.3rem",
    fontWeight: 700,
    margin: 0,
    color: "#1f2937",
    letterSpacing: "-0.01em",
  },
  inputGroup: {
    marginBottom: "20px",
  },
  label: {
    display: "block",
    fontSize: "0.75rem",
    fontWeight: 700,
    color: "#6b7280",
    marginBottom: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  input: {
    width: "100%",
    padding: "14px 16px",
    fontSize: "0.95rem",
    borderRadius: "14px",
    border: "1px solid #e5e7eb",
    background: "#ffffff",
    color: "#1f2937",
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
    boxSizing: "border-box",
  },
  numberInputWrapper: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  numberInput: {
    width: "80px",
    padding: "14px 16px",
    fontSize: "0.95rem",
    borderRadius: "14px",
    border: "1px solid #e5e7eb",
    background: "#ffffff",
    color: "#1f2937",
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  inputSuffix: {
    color: "#6b7280",
    fontSize: "0.85rem",
    fontWeight: 500,
  },
  hint: {
    display: "block",
    fontSize: "0.75rem",
    color: "#9ca3af",
    marginTop: "8px",
  },
  actions: {
    display: "flex",
    justifyContent: "center",
    marginTop: "20px",
  },
  button: {
    padding: "14px 36px",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    transition: "all 0.2s",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPrimary: {
    background: "#237227",
    color: "#ffffff",
    boxShadow: "0 4px 12px rgba(35, 114, 39, 0.15)",
  },
  buttonSecondary: {
    background: "#f3f4f6",
    color: "#374151",
  },
  spinnerContainer: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "300px",
    background: "#ffffff",
  },
  spinner: {
    width: "50px",
    height: "50px",
    border: "4px solid #e5e7eb",
    borderTop: "4px solid #237227",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
};

// Add keyframes for spinner and focus styles
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  input:focus {
    border-color: #237227 !important;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2) !important;
  }
  input:disabled {
    background: #f3f4f6 !important;
    color: #555555 !important;
    cursor: not-allowed !important;
    opacity: 1 !important;
  }
  button:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
  }
  .buttonPrimary:hover {
    background: #0f9e6e !important;
  }
  .buttonSecondary:hover {
    background: #d1d5db !important;
  }
`;
document.head.appendChild(styleSheet);
