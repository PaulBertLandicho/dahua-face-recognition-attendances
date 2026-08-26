// Updated DepartmentRates.js with fixed navigation tabs

import React, { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { supabase } from "../supabaseClient";
import { FiPlusCircle, FiHome, FiTrendingDown } from "react-icons/fi";
import Icon from "../components/Icon";

export default function DepartmentRates() {
  const [rates, setRates] = useState([]);
  const [originalRates, setOriginalRates] = useState([]);
  // Track original department names for rename
  const [originalNames, setOriginalNames] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editModes, setEditModes] = useState({});

  const toggleEdit = (idx) => {
    setEditModes((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };
  const Icons = {
    circlePlus: <Icon as={FiPlusCircle} ariaLabel="Add" color="#ffffff" />,
  };
  useEffect(() => {
    fetchRates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchRates = async () => {
    try {
      const { data, error } = await supabase
        .from("department_rates")
        .select("*")
        .order("department");
      if (!error && data) {
        setRates(data);
        setOriginalRates(JSON.parse(JSON.stringify(data)));
        setOriginalNames(data.map((row) => row.department));
      }
    } catch (e) {
      console.error("Error fetching department rates:", e);
    }
  };

  // Add Department (modal version)
  const handleAddDepartment = async () => {
    const { value: deptName } = await Swal.fire({
      title: "Add Department",
      input: "text",
      inputLabel: "Department Name",
      inputPlaceholder: "Enter department name",
      showCancelButton: true,
    });

    if (!deptName) return;

    // Check duplicate
    const exists = rates.find(
      (r) => r.department.toLowerCase() === deptName.toLowerCase(),
    );

    if (exists) {
      return Swal.fire("Error", "Department already exists", "error");
    }

    const { error } = await supabase.from("department_rates").insert({
      department: deptName,
      daily_rate: 0,
      late_penalty: 0,
      sss: 0,
      pag_ibig: 0,
      philhealth: 0,
      ot_rate: 0,
      regular_holiday_rate: 100,
      special_holiday_rate: 30,
    });

    if (error) {
      Swal.fire("Error", error.message, "error");
    } else {
      Swal.fire("Success", "Department added", "success");
      fetchRates();
    }
  };

  const handleChange = (index, field, value) => {
    const updated = [...rates];
    if (field === "department") {
      updated[index][field] = value;
    } else {
      updated[index][field] = parseFloat(value) || 0;
    }
    setRates(updated);
  };

  // Handle holiday type checkbox
  // Removed unused handleHolidayTypeChange

  // Handle holiday date change
  // Removed unused handleHolidayDateChange

  const handleSave = async (index) => {
    setSaving(true);
    const item = rates[index];
    const originalName = originalNames[index];
    let error = null;
    // If department name changed, update by filtering on original name
    if (item.department !== originalName) {
      // Check for duplicate
      if (
        rates.some(
          (r, i) =>
            i !== index &&
            r.department.toLowerCase() === item.department.toLowerCase(),
        )
      ) {
        Swal.fire("Error", "Department name already exists", "error");
        setSaving(false);
        return;
      }
      const { error: updateError } = await supabase
        .from("department_rates")
        .update({
          department: item.department,
          daily_rate: item.daily_rate,
          late_penalty: item.late_penalty,
          sss: item.sss,
          pag_ibig: item.pag_ibig,
          philhealth: item.philhealth,
          ot_rate: item.ot_rate,
          regular_holiday_rate: item.regular_holiday_rate || 100,
          special_holiday_rate: item.special_holiday_rate || 30,
          updated_at: new Date(),
        })
        .eq("department", originalName);
      error = updateError;
    } else {
      const { error: updateError } = await supabase
        .from("department_rates")
        .update({
          daily_rate: item.daily_rate,
          late_penalty: item.late_penalty,
          sss: item.sss,
          pag_ibig: item.pag_ibig,
          philhealth: item.philhealth,
          ot_rate: item.ot_rate,
          regular_holiday_rate: item.regular_holiday_rate || 100,
          special_holiday_rate: item.special_holiday_rate || 30,
          updated_at: new Date(),
        })
        .eq("department", item.department);
      error = updateError;
    }
    if (error) {
      Swal.fire("Error", error.message, "error");
    } else {
      Swal.fire("Saved", "", "success");
      setEditModes((prev) => ({ ...prev, [index]: false }));
    }
    setSaving(false);
    fetchRates();
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>
          <span style={styles.titleBlack}>Employee </span>
          <span style={styles.titlePrimary}>Rates</span>
        </h1>
      </div>

      {/* Add Department Button (modal) */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={handleAddDepartment}
          style={{ ...styles.saveButton, minWidth: 180 }}
        >
          {Icons.circlePlus} Add Department
        </button>
      </div>

      {/* Vertically scrollable grid */}
      <div className="cardsContainer" style={styles.cardsContainer}>
        {rates.map((row, idx) => (
          <div key={row.department} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={styles.cardIcon}>
                <Icon as={FiHome} size={24} color="#ffffff" ariaLabel="Department" />
              </span>
              <input
                type="text"
                id={`department-name-${row.department || idx}`}
                name={`department-name-${row.department || idx}`}
                value={row.department}
                onChange={(e) =>
                  handleChange(idx, "department", e.target.value)
                }
                disabled={!editModes[idx]}
                style={{
                  ...styles.departmentName,
                  border: editModes[idx] ? "1px solid #d1d5db" : "1px solid transparent",
                  backgroundColor: editModes[idx] ? "#ffffff" : "transparent",
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: "1.2rem",
                  flex: 1,
                  minWidth: 0,
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                {!editModes[idx] && (
                  <button
                    onClick={() => toggleEdit(idx)}
                    style={{
                      background: "#f3f4f6",
                      color: "#4b5563",
                      border: "1px solid #d1d5db",
                      borderRadius: 6,
                      padding: "6px 12px",
                      cursor: "pointer",
                      fontWeight: 600,
                      fontSize: "0.85rem",
                    }}
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>

            {/* Rates Section */}
            <div style={styles.section}>
              <div style={styles.inputGrid}>
                <div style={styles.inputGroup}>
                  <label
                    htmlFor={`daily-rate-${row.department || idx}`}
                    style={styles.label}
                  >
                    Daily Rate (₱)
                  </label>
                  <input
                    id={`daily-rate-${row.department || idx}`}
                    name={`daily-rate-${row.department || idx}`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.daily_rate}
                    onChange={(e) =>
                      handleChange(idx, "daily_rate", e.target.value)
                    }
                    disabled={!editModes[idx]}
                    style={styles.input}
                  />
                </div>
                <div style={styles.inputGroup}>
                  <label
                    htmlFor={`late-penalty-${row.department || idx}`}
                    style={styles.label}
                  >
                    Late Penalty (₱)
                  </label>
                  <input
                    id={`late-penalty-${row.department || idx}`}
                    name={`late-penalty-${row.department || idx}`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.late_penalty}
                    onChange={(e) =>
                      handleChange(idx, "late_penalty", e.target.value)
                    }
                    disabled={!editModes[idx]}
                    style={styles.input}
                  />
                </div>
                <div style={styles.inputGroup}>
                  <label
                    htmlFor={`regular-holiday-rate-${row.department || idx}`}
                    style={styles.label}
                  >
                    Regular Holiday Rate (%)
                  </label>
                  <input
                    id={`regular-holiday-rate-${row.department || idx}`}
                    name={`regular-holiday-rate-${row.department || idx}`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.regular_holiday_rate || 100}
                    onChange={(e) =>
                      handleChange(idx, "regular_holiday_rate", e.target.value)
                    }
                    disabled={!editModes[idx]}
                    style={styles.input}
                  />
                </div>
                <div style={styles.inputGroup}>
                  <label
                    htmlFor={`special-holiday-rate-${row.department || idx}`}
                    style={styles.label}
                  >
                    Special Holiday Rate (%)
                  </label>
                  <input
                    id={`special-holiday-rate-${row.department || idx}`}
                    name={`special-holiday-rate-${row.department || idx}`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.special_holiday_rate || 30}
                    onChange={(e) =>
                      handleChange(idx, "special_holiday_rate", e.target.value)
                    }
                    disabled={!editModes[idx]}
                    style={styles.input}
                  />
                </div>
              </div>
            </div>

            {/* Deductions Section */}
            <div style={styles.section}>
              <h3 style={styles.sectionTitle}>
                <Icon
                  as={FiTrendingDown}
                  style={{ marginRight: 8 }}
                  ariaLabel="Deductions"
                />
                Deductions
              </h3>
              <div style={styles.inputGridDeductions}>
                <div style={styles.inputGroup}>
                  <label
                    htmlFor={`sss-${row.department || idx}`}
                    style={styles.label}
                  >
                    SSS (₱)
                  </label>
                  <input
                    id={`sss-${row.department || idx}`}
                    name={`sss-${row.department || idx}`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.sss || 0}
                    onChange={(e) => handleChange(idx, "sss", e.target.value)}
                    disabled={!editModes[idx]}
                    style={styles.input}
                  />
                </div>
                <div style={styles.inputGroup}>
                  <label
                    htmlFor={`pag-ibig-${row.department || idx}`}
                    style={styles.label}
                  >
                    Pag-ibig (₱)
                  </label>
                  <input
                    id={`pag-ibig-${row.department || idx}`}
                    name={`pag-ibig-${row.department || idx}`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.pag_ibig || 0}
                    onChange={(e) =>
                      handleChange(idx, "pag_ibig", e.target.value)
                    }
                    disabled={!editModes[idx]}
                    style={styles.input}
                  />
                </div>
                <div style={styles.inputGroup}>
                  <label
                    htmlFor={`philhealth-${row.department || idx}`}
                    style={styles.label}
                  >
                    PhilHealth (₱)
                  </label>
                  <input
                    id={`philhealth-${row.department || idx}`}
                    name={`philhealth-${row.department || idx}`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.philhealth || 0}
                    onChange={(e) =>
                      handleChange(idx, "philhealth", e.target.value)
                    }
                    disabled={!editModes[idx]}
                    style={styles.input}
                  />
                </div>
              </div>
            </div>

            {/* Action Buttons (Bottom Right) */}
            {editModes[idx] && (
              <div style={{ ...styles.action, gap: "10px" }}>
                <button
                  onClick={() => {
                    toggleEdit(idx);
                    fetchRates();
                  }}
                  style={{
                    background: "#6b7280",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 16px",
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: "0.85rem",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    const confirm = await Swal.fire({
                      title: `Delete ${row.department}?`,
                      text: "This will remove the department and all its rates.",
                      icon: "warning",
                      showCancelButton: true,
                      confirmButtonText: "Delete",
                      cancelButtonText: "Cancel",
                    });
                    if (confirm.isConfirmed) {
                      setSaving(true);
                      const { error } = await supabase
                        .from("department_rates")
                        .delete()
                        .eq("department", row.department);
                      if (error) Swal.fire("Error", error.message, "error");
                      else {
                        Swal.fire("Deleted", "", "success");
                        fetchRates();
                      }
                      setSaving(false);
                    }
                  }}
                  style={{
                    background: "#ef4444",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 16px",
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: "0.85rem",
                  }}
                  disabled={saving}
                  title="Delete Department"
                >
                  Delete
                </button>
                {JSON.stringify(rates[idx]) !== JSON.stringify(originalRates[idx]) && (
                  <button
                    onClick={() => handleSave(idx)}
                    disabled={saving}
                    style={{
                      background: "#237227",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "8px 16px",
                      cursor: saving ? "not-allowed" : "pointer",
                      fontWeight: 600,
                      fontSize: "0.85rem",
                    }}
                    title="Save Changes"
                  >
                    Save Changes
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Light theme styles with green accent
const styles = {
  container: {
    margin: "0 auto",
    padding: "24px 20px",
    maxWidth: "100%",
    background: "#ffffff",
    minHeight: "100vh",
    color: "#1f2937",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  header: {
    marginBottom: "20px",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "4px",
  },
  title: {
    fontSize: "2rem",
    fontWeight: 800,
    margin: 0,
    letterSpacing: "-0.02em",
    display: "inline-block",
  },
  titleBlack: {
    color: "#2c382d",
  },
  titlePrimary: {
    color: "#237227",
  },
  tabContainer: {
    display: "flex",
    justifyContent: "center",
    gap: "8px",
    marginBottom: "24px",
    borderBottom: "2px solid #e5e7eb",
    paddingBottom: "8px",
  },
  tab: {
    padding: "8px 20px",
    fontSize: "0.95rem",
    fontWeight: 600,
    borderRadius: "20px 20px 0 0",
    border: "none",
    cursor: "pointer",
    transition: "all 0.2s",
    backgroundColor: "transparent",
    color: "#6b7280",
    borderBottom: "3px solid transparent",
  },
  activeTab: {
    color: "#237227",
    borderBottom: "3px solid #237227",
    backgroundColor: "transparent",
  },
  inactiveTab: {
    color: "#6b7280",
    "&:hover": {
      color: "#1f2937",
      borderBottom: "3px solid #d1d5db",
    },
  },
  cardsContainer: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(350px, 1fr))",
    gap: "24px",
    padding: "8px",
    paddingRight: "16px",
    maxHeight: "75vh",
    overflowY: "auto",
  },
  card: {
    background: "#f9fafb",
    borderRadius: "16px",
    padding: "20px",
    border: "1px solid #e5e7eb",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.04)",
    transition: "transform 0.2s, box-shadow 0.2s",
    display: "flex",
    flexDirection: "column",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "16px",
  },
  cardIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "44px",
    height: "44px",
    borderRadius: "12px",
    background: "#237227",
    color: "#ffffff",
    flexShrink: 0,
  },
  departmentName: {
    fontSize: "1.4rem",
    fontWeight: 600,
    margin: 0,
    color: "#1f2937",
  },
  smallIconWrapperPrimary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    borderRadius: "8px",
    background: "#f0fdf4",
    color: "#237227",
    marginRight: "8px",
    fontSize: "1rem",
    fontWeight: 700,
  },
  smallIconWrapperSecondary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    borderRadius: "8px",
    background: "#f3f4f6",
    color: "#4b5563",
    marginRight: "8px",
  },
  section: {
    marginBottom: "16px",
  },
  sectionTitle: {
    fontSize: "1.05rem",
    fontWeight: 600,
    color: "#4b5563",
    marginBottom: "12px",
    borderBottom: "1px solid #e5e7eb",
    paddingBottom: "6px",
  },
  inputGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: "12px",
  },
  inputGridDeductions: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "12px",
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  label: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#4b5563",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  input: {
    padding: "4px 8px",
    fontSize: "0.85rem",
    borderRadius: "4px",
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#1f2937",
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
    width: "100%",
    boxSizing: "border-box",
  },
  action: {
    marginTop: "20px",
    display: "flex",
    justifyContent: "flex-end",
  },
  saveButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    padding: "8px 16px",
    fontSize: "0.85rem",
    fontWeight: 600,
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    transition: "all 0.2s",
    background: "#237227",
    color: "#ffffff",
    boxShadow: "0 1px 4px rgba(35, 114, 39, 0.2)",
    width: "100%",
    maxWidth: "200px",
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

// Add global keyframes and focus styles
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  input:focus {
    border-color: #d1d5db !important;
    outline: none !important;
    box-shadow: none !important;
  }
  button:focus {
    outline: none !important;
    box-shadow: none !important;
  }
  button:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }
  .inactiveTab:hover {
    color: #1f2937 !important;
    border-bottom: 3px solid #d1d5db !important;
  }
  .cardsContainer input:disabled {
    background-color: transparent !important;
    border-color: transparent !important;
    color: #4b5563 !important;
    padding-left: 0 !important;
    font-weight: 500;
  }
  /* Custom scrollbar for light theme */
  .cardsContainer::-webkit-scrollbar {
    height: 8px;
    width: 8px;
  }
  .cardsContainer::-webkit-scrollbar-track {
    background: #f1f5f9;
    border-radius: 10px;
  }
  .cardsContainer::-webkit-scrollbar-thumb {
    background: #cbd5e0;
    border-radius: 10px;
  }
  .cardsContainer::-webkit-scrollbar-thumb:hover {
    background: #94a3b8;
  }
`;
document.head.appendChild(styleSheet);
