// Updated DepartmentRates.js with fixed navigation tabs

import React, { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { supabase } from "../mysqlClient";
import { FiPlusCircle, FiHome, FiTrendingDown } from "react-icons/fi";
import Icon from "../components/Icon";

export default function DepartmentRates() {
  const [rates, setRates] = useState([]);
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
        setOriginalNames(data.map((row) => row.department));
      }
    } catch (e) {
      console.error("Error fetching department rates:", e);
    }
  };

  const showToast = (title, icon = "success") => {
    Swal.fire({
      toast: true,
      position: "top-end",
      icon,
      title,
      showConfirmButton: false,
      timer: 2500,
      timerProgressBar: true,
      iconColor: icon === "success" ? "#237227" : undefined,
      customClass: {
        popup: "!rounded-2xl !shadow-[0_12px_30px_rgba(0,0,0,0.12)] !border !border-gray-200 !px-4 !py-3 !bg-white font-sans",
        title: "!text-sm !font-semibold !text-gray-800 !m-0 !leading-tight",
        timerProgressBar: "!bg-[#237227]",
      },
    });
  };

  const handleAddDepartment = async () => {
    const { value: deptName } = await Swal.fire({
      title: "Add Department",
      html: `
        <div style="text-align: left; margin-top: 1.25rem;">
          <div style="margin-bottom: 0.5rem;">
            <label style="display: block; font-size: 0.85rem; font-weight: 600; color: #374151; margin-bottom: 0.35rem;">
              Department Name
            </label>
            <input 
              id="swal-dept-name" 
              type="text"
              placeholder="Enter department name" 
              style="display: block; width: 100%; padding: 0.65rem 0.85rem; font-size: 0.95rem; border: 1px solid #d1d5db; border-radius: 0.75rem; outline: none !important; box-shadow: none !important; box-sizing: border-box; background: #ffffff; color: #1f2937;"
              onfocus="this.style.outline='none'; this.style.boxShadow='none'; this.style.borderColor='#237227';"
              onblur="this.style.borderColor='#d1d5db';"
            />
          </div>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: "Add Department",
      confirmButtonColor: "#237227",
      cancelButtonColor: "#E5E7EB",
      buttonsStyling: false,
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !px-8 !py-8 !max-w-[420px] font-sans",
        title: "!text-gray-800 !text-[1.4rem] !font-bold !mt-1 !mb-0",
        actions: "!flex !items-center !justify-center !gap-3 !mt-6 !w-full",
        confirmButton: "!bg-[#237227] !text-white !font-semibold !rounded-lg !px-5 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[130px] border-none !shadow-none hover:!shadow-none !transform-none hover:!transform-none outline-none focus:outline-none focus:ring-0",
        cancelButton: "!bg-white !border !border-gray-300 !text-gray-700 !font-semibold !rounded-lg !px-5 !py-2.5 !text-sm cursor-pointer !m-0 !min-w-[90px] !shadow-none hover:!shadow-none !transform-none hover:!transform-none outline-none focus:outline-none focus:ring-0",
      },
      didOpen: () => {
        const input = document.getElementById("swal-dept-name");
        if (input) input.focus();
      },
      preConfirm: () => {
        const input = document.getElementById("swal-dept-name");
        const trimmed = (input ? input.value : "").trim();
        if (!trimmed) {
          Swal.showValidationMessage("Department name is required!");
          return false;
        }
        const exists = rates.find(
          (r) => r.department.toLowerCase() === trimmed.toLowerCase()
        );
        if (exists) {
          Swal.showValidationMessage("Department name already exists!");
          return false;
        }
        return trimmed;
      },
    });

    if (!deptName || !deptName.trim()) return;

    const trimmedDept = deptName.trim();

    const { error } = await supabase.from("department_rates").insert({
      department: trimmedDept,
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
      showToast(error.message, "error");
    } else {
      showToast(`Department "${trimmedDept}" added!`, "success");
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

  const handleSave = async (index) => {
    setSaving(true);
    const item = rates[index];
    const originalName = originalNames[index];
    let error = null;

    if (item.department !== originalName) {
      if (
        rates.some(
          (r, i) =>
            i !== index &&
            r.department.toLowerCase() === item.department.toLowerCase(),
        )
      ) {
        showToast("Department name already exists", "error");
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
      showToast(error.message, "error");
    } else {
      showToast("Department rates updated successfully!", "success");
      setEditModes((prev) => ({ ...prev, [index]: false }));
    }
    setSaving(false);
    fetchRates();
  };

  return (
    <div className="department-rates-container mx-auto py-6 px-5 max-w-full bg-white min-h-screen text-gray-800 font-sans">
      <style>{`
        .department-rates-container button,
        .department-rates-container button:hover,
        .department-rates-container button:focus,
        .department-rates-container button:active,
        .department-rates-container * {
          transform: none !important;
        }
        .department-rates-container button:hover {
          box-shadow: none !important;
        }
        .department-rates-container input:focus {
          outline: none !important;
          box-shadow: none !important;
          border-color: #237227 !important;
        }
        .swal2-container .swal2-actions button,
        .swal2-container .swal2-actions button:hover,
        .swal2-container .swal2-actions button:focus,
        .swal2-container .swal2-actions button:active {
          transform: none !important;
          box-shadow: none !important;
          outline: none !important;
        }
        .swal2-container input:focus,
        .swal2-container input:focus-visible,
        #swal-dept-name:focus,
        #swal-dept-name:focus-visible {
          outline: none !important;
          box-shadow: none !important;
          border-color: #237227 !important;
        }
      `}</style>
      {/* Header */}
      <div className="mb-5 flex flex-col items-start gap-1">
        <h1 className="text-[2rem] font-extrabold m-0 tracking-[-0.02em] inline-block">
          <span className="text-[#2c382d]">Employee </span>
          <span className="text-[#237227]">Rates</span>
        </h1>
      </div>

      {/* Add Department Button (modal) */}
      <div className="mb-6">
        <button
          onClick={handleAddDepartment}
          className="inline-flex items-center justify-center gap-1.5 py-2 px-4 text-[0.85rem] font-semibold rounded-lg border-none cursor-pointer transition-colors bg-[#237227] text-white shadow-none min-w-[180px] focus:outline-none"
        >
          {Icons.circlePlus} Add Department
        </button>
      </div>

      {/* 3 cards per row grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-2">
        {rates.map((row, idx) => (
          <div key={row.department} className="bg-gray-50 rounded-2xl p-5 border border-gray-200 shadow-none transition-colors flex flex-col">
            <div className="flex items-center gap-2.5 mb-4">
              <span className="flex items-center justify-center w-11 h-11 rounded-xl bg-[#237227] text-white shrink-0">
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
                className={`text-[1.2rem] font-semibold m-0 rounded-lg py-1 px-2.5 flex-1 min-w-0 outline-none focus:outline-none focus:ring-0 focus:border-[#237227] disabled:bg-transparent disabled:border-transparent disabled:text-gray-600 disabled:pl-0 disabled:font-medium transition-colors ${
                  editModes[idx] ? "border border-gray-300 bg-white text-gray-800" : "border border-transparent bg-transparent text-gray-800"
                }`}
              />
              <div className="flex gap-2 shrink-0">
                {!editModes[idx] && (
                  <button
                    onClick={() => toggleEdit(idx)}
                    className="bg-[#237227] text-white border-none rounded-lg py-1.5 px-4 cursor-pointer font-semibold text-[0.85rem] focus:outline-none shadow-none hover:shadow-none transition-colors"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>

            {/* Rates Section */}
            <div className="mb-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={`daily-rate-${row.department || idx}`}
                    className="text-[0.75rem] font-semibold text-gray-600 uppercase tracking-[0.5px]"
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
                    className="py-1.5 px-2.5 text-[0.85rem] rounded-lg border border-gray-300 bg-white text-gray-800 outline-none transition-colors w-full box-border disabled:bg-gray-100 disabled:border-gray-300 disabled:text-gray-700 focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={`late-penalty-${row.department || idx}`}
                    className="text-[0.75rem] font-semibold text-gray-600 uppercase tracking-[0.5px]"
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
                    className="py-1.5 px-2.5 text-[0.85rem] rounded-lg border border-gray-300 bg-white text-gray-800 outline-none transition-colors w-full box-border disabled:bg-gray-100 disabled:border-gray-300 disabled:text-gray-700 focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={`regular-holiday-rate-${row.department || idx}`}
                    className="text-[0.75rem] font-semibold text-gray-600 uppercase tracking-[0.5px]"
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
                    className="py-1.5 px-2.5 text-[0.85rem] rounded-lg border border-gray-300 bg-white text-gray-800 outline-none transition-colors w-full box-border disabled:bg-gray-100 disabled:border-gray-300 disabled:text-gray-700 focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={`special-holiday-rate-${row.department || idx}`}
                    className="text-[0.75rem] font-semibold text-gray-600 uppercase tracking-[0.5px]"
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
                    className="py-1.5 px-2.5 text-[0.85rem] rounded-lg border border-gray-300 bg-white text-gray-800 outline-none transition-colors w-full box-border disabled:bg-gray-100 disabled:border-gray-300 disabled:text-gray-700 focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                </div>
              </div>
            </div>

            {/* Deductions Section */}
            <div className="mb-4">
              <h3 className="text-[1.05rem] font-semibold text-gray-600 mb-3 border-b border-gray-200 pb-1.5 flex items-center">
                <Icon
                  as={FiTrendingDown}
                  style={{ marginRight: 8 }}
                  ariaLabel="Deductions"
                />
                Deductions
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={`sss-${row.department || idx}`}
                    className="text-[0.75rem] font-semibold text-gray-600 uppercase tracking-[0.5px]"
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
                    className="py-1.5 px-2.5 text-[0.85rem] rounded-lg border border-gray-300 bg-white text-gray-800 outline-none transition-colors w-full box-border disabled:bg-gray-100 disabled:border-gray-300 disabled:text-gray-700 focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={`pag-ibig-${row.department || idx}`}
                    className="text-[0.75rem] font-semibold text-gray-600 uppercase tracking-[0.5px]"
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
                    className="py-1.5 px-2.5 text-[0.85rem] rounded-lg border border-gray-300 bg-white text-gray-800 outline-none transition-colors w-full box-border disabled:bg-gray-100 disabled:border-gray-300 disabled:text-gray-700 focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={`philhealth-${row.department || idx}`}
                    className="text-[0.75rem] font-semibold text-gray-600 uppercase tracking-[0.5px]"
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
                    className="py-1.5 px-2.5 text-[0.85rem] rounded-lg border border-gray-300 bg-white text-gray-800 outline-none transition-colors w-full box-border disabled:bg-gray-100 disabled:border-gray-300 disabled:text-gray-700 focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                </div>
              </div>
            </div>

            {/* Action Buttons (Bottom Right) */}
            {editModes[idx] && (
              <div className="mt-5 flex justify-end gap-2.5">
                <button
                  onClick={() => {
                    toggleEdit(idx);
                    fetchRates();
                  }}
                  className="bg-white text-gray-700 border border-gray-300 rounded-lg py-2 px-4 cursor-pointer font-semibold text-[0.85rem] focus:outline-none shadow-none hover:shadow-none transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    const confirm = await Swal.fire({
                      title: `Delete ${row.department}?`,
                      text: "This will remove the department and all its rates.",
                      icon: "warning",
                      iconColor: "#ef4444",
                      width: "380px",
                      padding: "1.75rem",
                      backdrop: false,
                      showCancelButton: true,
                      confirmButtonText: "Yes, delete it",
                      cancelButtonText: "Cancel",
                      buttonsStyling: false,
                      customClass: {
                        container: "!bg-transparent !backdrop-blur-none",
                        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.15)] !border !border-gray-100 font-sans",
                        title: "!text-xl !font-bold !text-gray-800 !mt-2",
                        htmlContainer: "!text-sm !text-gray-600",
                        icon: "!scale-90 !my-2",
                        actions: "!flex !items-center !justify-center !gap-3 !mt-5 !w-full",
                        confirmButton: "!bg-[#ef4444] !text-white !font-semibold !rounded-xl !px-6 !py-2.5 !text-sm !border-none cursor-pointer !m-0 !shadow-sm",
                        cancelButton: "!bg-white !text-gray-700 !font-semibold !rounded-xl !px-6 !py-2.5 !text-sm !border !border-gray-300 cursor-pointer !m-0",
                      },
                    });
                    if (confirm.isConfirmed) {
                      setSaving(true);
                      const { error } = await supabase
                        .from("department_rates")
                        .delete()
                        .eq("department", row.department);
                      if (error) {
                        showToast(error.message, "error");
                      } else {
                        showToast(`${row.department} has been removed.`, "success");
                        fetchRates();
                      }
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
                  title="Delete Department"
                  className="bg-red-600 text-white border-none rounded-lg py-2 px-4 cursor-pointer font-semibold text-[0.85rem] focus:outline-none shadow-none hover:shadow-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Delete
                </button>
                <button
                  onClick={() => handleSave(idx)}
                  disabled={saving}
                  title="Save Changes"
                  className="bg-[#237227] text-white border-none rounded-lg py-2 px-4 cursor-pointer font-semibold text-[0.85rem] focus:outline-none shadow-none hover:shadow-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}