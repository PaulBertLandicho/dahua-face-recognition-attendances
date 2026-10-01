// HolidayManager.js
// Component for managing multiple holidays per month per department

import React, { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { FiCalendar, FiTrash2, FiX, FiEdit2 } from "react-icons/fi";
import { supabase } from "../mysqlClient";

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
        .select("date, type, id, description")
        .is("department", null)
        .eq("month", parseInt(monthNum))
        .eq("year", parseInt(year));
      if (!error && data) setAllHolidays(data);
      else setAllHolidays([]);
    }
    fetchAllHolidays();
  }, [month, saving]);

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

  // Delete a saved holiday from DB
  const handleDeleteSavedHoliday = async (holiday) => {
    const holidayName = holiday.description ? ` (${holiday.description})` : "";
    const confirm = await Swal.fire({
      title: "Delete Holiday?",
      html: `<p style="color:#6b7280;font-size:0.92rem;margin:0">Are you sure you want to delete the holiday on <strong style="color:#111827">${holiday.date}</strong>${holidayName} [${holiday.type === "regular" ? "Regular Holiday" : "Special Holiday"}]?</p>`,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Delete",
      cancelButtonText: "Cancel",
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.12)] !px-8 !py-8 !max-w-[380px]",
        title: "!text-gray-800 !text-[1.4rem] !font-bold !mt-3 !mb-1",
        htmlContainer: "!mt-1 !mb-4",
        actions: "!flex !items-center !justify-center !gap-3 !mt-4 !w-full",
        confirmButton:
          "!bg-[#dc2626] !text-white !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm !shadow-none !border-none cursor-pointer !m-0 !min-w-[100px]",
        cancelButton:
          "!bg-white !border !border-gray-300 !text-gray-700 !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm !shadow-none cursor-pointer !m-0 !min-w-[100px]",
      },
      buttonsStyling: false,
    });
    if (!confirm.isConfirmed) return;

    let query = supabase.from("holidays").delete();
    if (holiday.id) {
      query = query.eq("id", holiday.id);
    } else {
      query = query
        .is("department", null)
        .eq("date", holiday.date)
        .eq("type", holiday.type);
    }
    const { error } = await query;
    if (error) {
      showToast(error.message || "Delete failed", "error");
    } else {
      showToast("Holiday deleted successfully!", "success");
    }
    setSaving((s) => !s); // trigger refresh
  };

  // Edit Note / Remarks of a saved holiday
  const handleEditSavedHoliday = async (holiday) => {
    const { value: newDesc, isConfirmed } = await Swal.fire({
      title: "Edit Note / Remarks",
      input: "text",
      inputLabel: `Holiday: ${holiday.date} (${holiday.type === "regular" ? "Regular Holiday" : "Special Holiday"})`,
      inputValue: holiday.description || "",
      inputPlaceholder: "e.g. Christmas Day, Bonifacio Day, etc.",
      showCancelButton: true,
      confirmButtonText: "Save",
      cancelButtonText: "Cancel",
      customClass: {
        popup: "!rounded-3xl !shadow-[0_24px_60px_rgba(0,0,0,0.12)] !px-8 !py-8 !max-w-[420px]",
        title: "!text-gray-800 !text-[1.3rem] !font-bold !mt-2 !mb-1",
        input: "!rounded-lg !border !border-gray-300 !text-sm !py-2 !px-3",
        actions: "!flex !items-center !justify-center !gap-3 !mt-4 !w-full",
        confirmButton:
          "!bg-[#237227] !text-white !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm !shadow-none !border-none cursor-pointer !m-0 !min-w-[100px]",
        cancelButton:
          "!bg-white !border !border-gray-300 !text-gray-700 !font-semibold !rounded-lg !px-6 !py-2.5 !text-sm !shadow-none cursor-pointer !m-0 !min-w-[100px]",
      },
      buttonsStyling: false,
    });
    if (!isConfirmed) return;

    let query = supabase
      .from("holidays")
      .update({ description: (newDesc || "").trim() || null });

    if (holiday.id) {
      query = query.eq("id", holiday.id);
    } else {
      query = query
        .is("department", null)
        .eq("date", holiday.date)
        .eq("type", holiday.type);
    }

    const { error } = await query;
    if (error) {
      showToast(error.message || "Failed to update holiday note", "error");
    } else {
      showToast("Holiday note updated successfully!", "success");
      setSaving((s) => !s);
    }
  };

  const addHoliday = (type) => {
    if (type === "regular") {
      setRegularHolidays([...regularHolidays, { date: "", description: "" }]);
    } else {
      setSpecialHolidays([...specialHolidays, { date: "", description: "" }]);
    }
  };

  const updateHoliday = (type, idx, field, value) => {
    if (type === "regular") {
      const updated = [...regularHolidays];
      const cur = typeof updated[idx] === "object" ? { ...updated[idx] } : { date: updated[idx] || "", description: "" };
      cur[field] = value;
      updated[idx] = cur;
      setRegularHolidays(updated);
    } else {
      const updated = [...specialHolidays];
      const cur = typeof updated[idx] === "object" ? { ...updated[idx] } : { date: updated[idx] || "", description: "" };
      cur[field] = value;
      updated[idx] = cur;
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
      showToast("Please select a month before saving holidays.", "warning");
      return;
    }
    setSaving(true);
    const [year, monthNum] = month.split("-");
    const inserts = [];
    for (const item of regularHolidays) {
      const dateVal = typeof item === "string" ? item : item?.date;
      const descVal = typeof item === "string" ? "" : item?.description;
      if (dateVal && dateVal.trim()) {
        inserts.push({
          department: null,
          date: dateVal.trim(),
          description: (descVal || "").trim() || null,
          type: "regular",
          month: parseInt(monthNum),
          year: parseInt(year),
        });
      }
    }
    for (const item of specialHolidays) {
      const dateVal = typeof item === "string" ? item : item?.date;
      const descVal = typeof item === "string" ? "" : item?.description;
      if (dateVal && dateVal.trim()) {
        inserts.push({
          department: null,
          date: dateVal.trim(),
          description: (descVal || "").trim() || null,
          type: "special",
          month: parseInt(monthNum),
          year: parseInt(year),
        });
      }
    }
    if (inserts.length) {
      const { error } = await supabase.from("holidays").insert(inserts);
      if (error) {
        showToast(error.message || "Failed to save holidays", "error");
      } else {
        showToast("Global holidays saved successfully!", "success");
        setRegularHolidays([]);
        setSpecialHolidays([]);
      }
    } else {
      showToast("Please add at least one holiday date.", "info");
    }
    setSaving(false);
  };

  return (
    <div className="holiday-manager-root max-w-[860px] mx-auto bg-[#f8fafc] rounded-3xl p-4 sm:p-6 border border-gray-200 font-sans shadow-none">
      <style>{`
        .holiday-manager-root button,
        .holiday-manager-root button:hover,
        .holiday-manager-root button:hover:not(:disabled),
        .holiday-manager-root button:focus,
        .holiday-manager-root button:active,
        .holiday-manager-root input,
        .holiday-manager-root input:hover,
        .holiday-manager-root input:focus,
        .holiday-manager-root input:active {
          transform: none !important;
          outline: none !important;
          box-shadow: none !important;
        }
        .holiday-manager-root input:focus {
          border-color: #237227 !important;
          outline: none !important;
          box-shadow: 0 0 0 1px #237227 !important;
        }
      `}</style>

      {/* Title with green underline */}
      <div className="text-center mb-6">
        <h2 className="text-[2.2rem] font-bold text-gray-800 m-0">Manage Holidays</h2>
        <div className="h-1 w-16 bg-[#237227] mx-auto mt-2 mb-6 rounded-sm" />
      </div>

      {/* Month Selector */}
      <div className="flex justify-center items-center gap-3 mb-7">
        <label className="flex items-center gap-2.5 text-sm font-semibold text-gray-700">
          <span>Month:</span>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="py-2 px-3.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:outline-none focus:ring-0 focus:border-[#237227] cursor-pointer"
          />
        </label>
      </div>

      {/* Saved Holidays Card */}
      {month && allHolidays.length > 0 && (
        <div className="bg-white rounded-2xl p-6 mb-6 border border-gray-200 shadow-none">
          <div className="flex items-center gap-2 mb-4 text-sm font-bold text-gray-800">
            <FiCalendar className="text-lg text-gray-700" />
            <span>All Global Holidays for {month} (Saved)</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {allHolidays.map((h, idx) => (
              <div
                key={h.id || idx}
                className="bg-gray-100/80 rounded-xl py-3 px-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                  <span className="font-semibold text-gray-800 text-sm shrink-0">{h.date}</span>
                  {h.description ? (
                    <span className="text-xs px-2.5 py-1 rounded-md bg-emerald-50 text-[#237227] border border-emerald-200 font-medium truncate max-w-[280px]">
                      {h.description}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400 italic">No remarks</span>
                  )}
                </div>
                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                  <span
                    className={`text-xs sm:text-sm font-semibold px-2.5 py-1 rounded-md ${
                      h.type === "regular"
                        ? "text-[#237227] bg-[#237227]/10"
                        : "text-[#f59e42] bg-[#f59e42]/10"
                    }`}
                  >
                    {h.type === "regular" ? "Regular Holiday" : "Special Holiday"}
                  </span>
                  <button
                    onClick={() => handleEditSavedHoliday(h)}
                    className="p-1.5 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-700 cursor-pointer border-none flex items-center justify-center transition-colors"
                    title="Edit note / remarks"
                  >
                    <FiEdit2 size={15} />
                  </button>
                  <button
                    onClick={() => handleDeleteSavedHoliday(h)}
                    className="p-1.5 rounded-lg bg-[#e11d48] text-white hover:bg-[#be123c] cursor-pointer border-none flex items-center justify-center transition-colors"
                    title="Delete holiday"
                  >
                    <FiTrash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Holidays Cards Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Regular Holidays Card */}
        <div className="bg-white rounded-2xl p-6 border border-gray-200 flex flex-col justify-between shadow-none">
          <div>
            <div className="mb-4">
              <h3 className="text-base font-bold text-gray-800 m-0">
                Regular Holidays <span className="text-[#237227] font-bold">({regularRate}%)</span>
              </h3>
            </div>
            {regularHolidays.length === 0 && (
              <p className="text-xs text-gray-400 italic mb-3">No regular holidays added yet. Click below to add.</p>
            )}
            {regularHolidays.map((item, idx) => {
              const dateVal = typeof item === "string" ? item : (item?.date || "");
              const descVal = typeof item === "string" ? "" : (item?.description || "");
              return (
                <div key={idx} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mb-3 bg-gray-50/80 p-2.5 sm:p-0 rounded-lg sm:bg-transparent">
                  <input
                    type="date"
                    value={dateVal}
                    onChange={(e) => updateHoliday("regular", idx, "date", e.target.value)}
                    className="w-full sm:w-[145px] py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:outline-none focus:ring-0 focus:border-[#237227] cursor-pointer shrink-0"
                  />
                  <input
                    type="text"
                    placeholder="Note / Remarks (e.g. Christmas Day)"
                    value={descVal}
                    onChange={(e) => updateHoliday("regular", idx, "description", e.target.value)}
                    className="flex-1 min-w-0 py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                  <button
                    onClick={() => removeHoliday("regular", idx)}
                    className="p-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-lg hover:bg-rose-100 cursor-pointer flex items-center justify-center shrink-0 self-end sm:self-auto"
                    title="Remove holiday"
                  >
                    <FiX size={16} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => addHoliday("regular")}
            className="w-full py-2.5 mt-2 rounded-lg bg-[#237227] text-white font-semibold text-sm cursor-pointer border-none outline-none hover:bg-[#237227]"
          >
            + Add Regular Holiday
          </button>
        </div>

        {/* Special Holidays Card */}
        <div className="bg-white rounded-2xl p-6 border border-gray-200 flex flex-col justify-between shadow-none">
          <div>
            <div className="mb-4">
              <h3 className="text-base font-bold text-gray-800 m-0">
                Special Holidays <span className="text-[#f59e42] font-bold">({specialRate}%)</span>
              </h3>
            </div>
            {specialHolidays.length === 0 && (
              <p className="text-xs text-gray-400 italic mb-3">No special holidays added yet. Click below to add.</p>
            )}
            {specialHolidays.map((item, idx) => {
              const dateVal = typeof item === "string" ? item : (item?.date || "");
              const descVal = typeof item === "string" ? "" : (item?.description || "");
              return (
                <div key={idx} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mb-3 bg-gray-50/80 p-2.5 sm:p-0 rounded-lg sm:bg-transparent">
                  <input
                    type="date"
                    value={dateVal}
                    onChange={(e) => updateHoliday("special", idx, "date", e.target.value)}
                    className="w-full sm:w-[145px] py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:outline-none focus:ring-0 focus:border-[#237227] cursor-pointer shrink-0"
                  />
                  <input
                    type="text"
                    placeholder="Note / Remarks (e.g. Ninoy Aquino Day)"
                    value={descVal}
                    onChange={(e) => updateHoliday("special", idx, "description", e.target.value)}
                    className="flex-1 min-w-0 py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:outline-none focus:ring-0 focus:border-[#237227]"
                  />
                  <button
                    onClick={() => removeHoliday("special", idx)}
                    className="p-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-lg hover:bg-rose-100 cursor-pointer flex items-center justify-center shrink-0 self-end sm:self-auto"
                    title="Remove holiday"
                  >
                    <FiX size={16} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => addHoliday("special")}
            className="w-full py-2.5 mt-2 rounded-lg bg-[#237227] text-white font-semibold text-sm cursor-pointer border-none outline-none hover:bg-[#237227]"
          >
            + Add Special Holiday
          </button>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-center">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-10 py-3 text-sm font-semibold rounded-lg border-none cursor-pointer bg-[#237227] text-white inline-flex items-center justify-center min-w-[180px] disabled:opacity-70 disabled:cursor-not-allowed outline-none focus:outline-none hover:bg-[#237227]"
        >
          {saving ? "Saving..." : "Save Holidays"}
        </button>
      </div>
    </div>
  );
}
