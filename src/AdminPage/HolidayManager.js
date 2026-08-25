// HolidayManager.js
// Component for managing multiple holidays per month per department

import React, { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { FiCalendar, FiTrash2, FiClock, FiX } from "react-icons/fi";
import Icon from "../components/Icon";
import { supabase } from "../supabaseClient";

// Global HolidayManager for all departments
export default function HolidayManagerGlobal({
  regularRate = 100,
  specialRate = 30,
}) {
  const [regularHolidays, setRegularHolidays] = useState([]);
  const [specialHolidays, setSpecialHolidays] = useState([]);
  // Set default month to current month (YYYY-MM)
  const getDefaultMonth = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  };
  const [month, setMonth] = useState(getDefaultMonth());

  // Clear pending holidays when month changes
  useEffect(() => {
    setRegularHolidays([]);
    setSpecialHolidays([]);
  }, [month]);
  const [saving, setSaving] = useState(false);
  const [allHolidays, setAllHolidays] = useState([]);
  useEffect(() => {
    async function fetchAllHolidays() {
      if (!month) return;
      const [year, monthNum] = month.split("-");
      // Fetch only global holidays (department is null) for this month
      const { data, error } = await supabase
        .from("holidays")
        .select("date, type, id")
        .is("department", null)
        .eq("month", parseInt(monthNum))
        .eq("year", parseInt(year));
      if (!error && data) setAllHolidays(data);
      else setAllHolidays([]);
    }
    fetchAllHolidays();
  }, [month, saving]);

  // Delete a saved holiday from DB
  const handleDeleteSavedHoliday = async (holiday) => {
    if (
      !window.confirm(
        `Delete holiday on ${holiday.date} (${holiday.type}) for all departments?`,
      )
    )
      return;
    const { error } = await supabase
      .from("holidays")
      .delete()
      .is("department", null)
      .eq("date", holiday.date)
      .eq("type", holiday.type);
    if (error) Swal.fire("Error", error.message, "error");
    setSaving((s) => !s); // trigger refresh
  };

  const addHoliday = (type) => {
    if (type === "regular") setRegularHolidays([...regularHolidays, ""]);
    else setSpecialHolidays([...specialHolidays, ""]);
  };

  const updateHoliday = (type, idx, value) => {
    if (type === "regular") {
      const updated = [...regularHolidays];
      updated[idx] = value;
      setRegularHolidays(updated);
    } else {
      const updated = [...specialHolidays];
      updated[idx] = value;
      setSpecialHolidays(updated);
    }
  };

  const removeHoliday = (type, idx) => {
    if (type === "regular") {
      setRegularHolidays(regularHolidays.filter((_, i) => i !== idx));
    } else {
      setSpecialHolidays(specialHolidays.filter((_, i) => i !== idx));
    }
  };

  const handleSave = async () => {
    if (!month) {
      Swal.fire("Please select a month.", "", "warning");
      return;
    }
    setSaving(true);
    const [year, monthNum] = month.split("-");
    const inserts = [];
    for (const date of regularHolidays.filter(Boolean)) {
      inserts.push({
        department: null,
        date,
        type: "regular",
        month: parseInt(monthNum),
        year: parseInt(year),
      });
    }
    for (const date of specialHolidays.filter(Boolean)) {
      inserts.push({
        department: null,
        date,
        type: "special",
        month: parseInt(monthNum),
        year: parseInt(year),
      });
    }
    if (inserts.length) {
      const { error } = await supabase.from("holidays").insert(inserts);
      if (error) Swal.fire("Error saving holidays", error.message, "error");
      else Swal.fire("Global holidays saved!", "", "success");
    } else {
      Swal.fire("No holidays to save.", "", "info");
    }
    setSaving(false);
  };

  return (
    <div style={{}}>

      {/* Month Selector */}
      <div style={holidayStyles.monthRow}>
        <label style={holidayStyles.monthLabel}>
          <span style={{ marginRight: 10, fontWeight: 500 }}>Month:</span>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={holidayStyles.monthInput}
          />
        </label>
      </div>

      {/* Saved Holidays Card */}
      {month && allHolidays.length > 0 && (
        <div style={holidayStyles.card}>
          <div style={holidayStyles.cardHeader}>
            <span style={holidayStyles.cardIcon}>
              <Icon as={FiCalendar} size={22} ariaLabel="Holidays" />
            </span>
            <span style={holidayStyles.cardTitle}>
              All Global Holidays for {month} (Saved)
            </span>
          </div>
          <ul style={holidayStyles.holidayList}>
            {allHolidays.map((h, idx) => (
              <li
                key={h.id || idx}
                style={{
                  ...holidayStyles.holidayListItem,
                  color: h.type === "regular" ? "#237227" : "#f59e42",
                }}
              >
                <span style={holidayStyles.holidayDate}>{h.date}</span>
                <span style={holidayStyles.holidayType}>
                  {h.type === "regular" ? "Regular Holiday" : "Special Holiday"}
                </span>
                <button
                  onClick={() => handleDeleteSavedHoliday(h)}
                  style={holidayStyles.deleteButton}
                  title="Delete holiday"
                >
                  <Icon
                    as={FiTrash2}
                    ariaLabel="Delete holiday"
                    color="#ffffff"
                    style={{ marginRight: 8 }}
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Pending Holidays Card */}
      {(regularHolidays.length > 0 || specialHolidays.length > 0) && (
        <div style={holidayStyles.cardPending}>
          <div style={holidayStyles.cardHeaderPending}>
            <span style={holidayStyles.cardIconPending}>
              <Icon as={FiClock} size={20} ariaLabel="Pending" />
            </span>
            <span style={holidayStyles.cardTitlePending}>
              Pending Holidays for {month} (To Save)
            </span>
          </div>
          <ul style={holidayStyles.holidayListPending}>
            {regularHolidays.filter(Boolean).map((date, idx) => (
              <li key={"reg-" + idx} style={{ color: "#237227" }}>
                {date} (Regular Holiday)
              </li>
            ))}
            {specialHolidays.filter(Boolean).map((date, idx) => (
              <li key={"spec-" + idx} style={{ color: "#f59e42" }}>
                {date} (Special Holiday)
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Add Holidays Cards */}
      <div style={holidayStyles.cardsRow}>
        {/* Regular Holidays Card */}
        <div style={holidayStyles.addCard}>
          <div style={holidayStyles.addCardHeader}>
            <span style={holidayStyles.addCardTitle}>
              Regular Holidays{" "}
              <span style={{ color: "#237227", fontWeight: 600 }}>
                ({regularRate}%)
              </span>
            </span>
          </div>
          {regularHolidays.map((date, idx) => (
            <div key={idx} style={holidayStyles.addHolidayRow}>
              <input
                type="date"
                value={date}
                onChange={(e) => updateHoliday("regular", idx, e.target.value)}
                style={holidayStyles.addHolidayInput}
              />
              <button
                onClick={() => removeHoliday("regular", idx)}
                style={holidayStyles.removeButton}
                title="Remove date"
              >
                <Icon as={FiX} ariaLabel="Remove date" />
              </button>
            </div>
          ))}
          <button
            onClick={() => addHoliday("regular")}
            style={holidayStyles.addButton}
          >
            + Add Regular Holiday
          </button>
        </div>

        {/* Special Holidays Card */}
        <div style={holidayStyles.addCard}>
          <div style={holidayStyles.addCardHeader}>
            <span style={holidayStyles.addCardTitle}>
              Special Holidays{" "}
              <span style={{ color: "#f59e42", fontWeight: 600 }}>
                ({specialRate}%)
              </span>
            </span>
          </div>
          {specialHolidays.map((date, idx) => (
            <div key={idx} style={holidayStyles.addHolidayRow}>
              <input
                type="date"
                value={date}
                onChange={(e) => updateHoliday("special", idx, e.target.value)}
                style={holidayStyles.addHolidayInput}
              />
              <button
                onClick={() => removeHoliday("special", idx)}
                style={holidayStyles.removeButton}
                title="Remove date"
              >
                <Icon as={FiX} ariaLabel="Remove date" />
              </button>
            </div>
          ))}
          <button
            onClick={() => addHoliday("special")}
            style={holidayStyles.addButton}
          >
            + Add Special Holiday
          </button>
        </div>
      </div>

      {/* Save Button */}
      <div style={holidayStyles.saveRow}>
        <button
          onClick={handleSave}
          style={holidayStyles.saveButton}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Holidays"}
        </button>
      </div>
    </div>
  );
}

// --- Styles for enhanced UI ---
const holidayStyles = {
  container: {
    background: "#f8fafc",
    borderRadius: "24px",
    padding: "32px 24px",
    margin: "0 auto",
    maxWidth: "900px",
    boxShadow: "0 6px 24px rgba(16,185,129,0.08)",
    border: "1px solid #e5e7eb",
  },
  sectionHeader: {
    textAlign: "center",
    marginBottom: "24px",
  },
  sectionTitle: {
    fontSize: "2rem",
    fontWeight: 700,
    color: "#1f2937",
    margin: 0,
  },
  monthRow: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 24,
  },
  monthLabel: {
    fontSize: "1.1rem",
    color: "#374151",
    fontWeight: 500,
    display: "flex",
    alignItems: "center",
  },
  monthInput: {
    marginLeft: 8,
    padding: "8px 14px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    fontSize: "1rem",
    background: "#fff",
    color: "#1f2937",
    outline: "none",
    transition: "border-color 0.2s",
  },
  card: {
    background: "#fff",
    borderRadius: "18px",
    boxShadow: "0 2px 8px rgba(16,185,129,0.07)",
    padding: "20px 24px",
    marginBottom: 24,
    border: "1px solid #e5e7eb",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: 12,
  },
  cardIcon: {
    fontSize: "1.5rem",
  },
  cardTitle: {
    fontWeight: 600,
    fontSize: "1.15rem",
    color: "#1f2937",
  },
  holidayList: {
    listStyle: "none",
    padding: 0,
    margin: 0,
  },
  holidayListItem: {
    display: "flex",
    alignItems: "center",
    background: "#f3f4f6",
    borderRadius: "8px",
    padding: "8px 14px",
    marginBottom: 8,
    fontWeight: 500,
    fontSize: "1rem",
    boxShadow: "0 1px 2px rgba(16,185,129,0.04)",
  },
  holidayDate: {
    flex: 1,
    fontWeight: 600,
    letterSpacing: "0.5px",
  },
  holidayType: {
    marginLeft: 12,
    fontSize: "0.98rem",
    fontWeight: 500,
    opacity: 0.85,
  },
  deleteButton: {
    marginLeft: 16,
    background: "#e11d48",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: "1.1rem",
    transition: "background 0.2s",
  },
  cardPending: {
    background: "#fef9c3",
    borderRadius: "14px",
    boxShadow: "0 1px 4px rgba(251,191,36,0.08)",
    padding: "16px 20px",
    marginBottom: 24,
    border: "1px solid #fde68a",
  },
  cardHeaderPending: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: 10,
  },
  cardIconPending: {
    fontSize: "1.3rem",
  },
  cardTitlePending: {
    fontWeight: 600,
    fontSize: "1.05rem",
    color: "#b45309",
  },
  holidayListPending: {
    listStyle: "none",
    padding: 0,
    margin: 0,
  },
   titleUnderline: {
    height: "4px",
    width: "100px",
    background: "#237227", // solid green
    margin: "8px auto 0",
    borderRadius: "2px",
  },
  cardsRow: {
    display: "flex",
    gap: "24px",
    marginBottom: 32,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  addCard: {
    background: "#ffffff",
    borderRadius: "16px",
    padding: "32px 24px",
    border: "1px solid #f3f4f6",
    boxShadow: "0 4px 20px rgba(0, 0, 0, 0.04)",
    flex: "1 1 270px",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
  },
  addCardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: 20,
  },
  addCardTitle: {
    fontWeight: 700,
    fontSize: "1.3rem",
    color: "#1f2937",
    letterSpacing: "-0.01em",
  },
  addHolidayRow: {
    display: "flex",
    alignItems: "center",
    marginBottom: 12,
  },
  addHolidayInput: {
    flex: 1,
    padding: "14px 16px",
    fontSize: "0.95rem",
    borderRadius: "14px",
    border: "1px solid #e5e7eb",
    background: "#ffffff",
    color: "#1f2937",
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  removeButton: {
    marginLeft: 8,
    background: "#fef2f2",
    color: "#e11d48",
    border: "1px solid #fecdd3",
    borderRadius: "8px",
    padding: "12px 14px",
    cursor: "pointer",
    fontSize: "1.1rem",
    transition: "all 0.2s",
  },
  addButton: {
    marginTop: 12,
    background: "#f3f4f6",
    color: "#374151",
    border: "none",
    borderRadius: "8px",
    padding: "12px 0",
    fontWeight: 600,
    fontSize: "0.95rem",
    cursor: "pointer",
    transition: "background 0.2s",
  },
  saveRow: {
    display: "flex",
    justifyContent: "center",
    marginTop: 20,
  },
  saveButton: {
    background: "#237227",
    color: "#ffffff",
    border: "none",
    borderRadius: "8px",
    padding: "14px 36px",
    fontWeight: 600,
    fontSize: "1rem",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(35, 114, 39, 0.15)",
    transition: "background 0.2s",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
};
