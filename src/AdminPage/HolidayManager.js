// HolidayManager.js
// Component for managing multiple holidays per month per department

import React, { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { FiCalendar, FiTrash2, FiX } from "react-icons/fi";
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
        .select("date, type, id")
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
    const confirm = await Swal.fire({
      title: "Delete Holiday?",
      html: `<p style="color:#6b7280;font-size:0.92rem;margin:0">Are you sure you want to delete the holiday on <strong style="color:#111827">${holiday.date}</strong> (${holiday.type})?</p>`,
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

    const { error } = await supabase
      .from("holidays")
      .delete()
      .is("department", null)
      .eq("date", holiday.date)
      .eq("type", holiday.type);
    if (error) {
      showToast(error.message || "Delete failed", "error");
    } else {
      showToast("Holiday deleted successfully!", "success");
    }
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
      showToast("Please select a month before saving holidays.", "warning");
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
    <div className="holiday-manager-root max-w-[860px] mx-auto bg-[#f8fafc] rounded-3xl p-8 sm:p-10 border border-gray-200 font-sans shadow-none">
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
                className="bg-gray-100/80 rounded-lg py-2.5 px-4 flex items-center justify-between"
              >
                <span className="font-semibold text-gray-800 text-sm">{h.date}</span>
                <div className="flex items-center gap-3">
                  <span
                    className={`text-sm font-semibold ${
                      h.type === "regular" ? "text-[#237227]" : "text-[#f59e42]"
                    }`}
                  >
                    {h.type === "regular" ? "Regular Holiday" : "Special Holiday"}
                  </span>
                  <button
                    onClick={() => handleDeleteSavedHoliday(h)}
                    className="p-1.5 rounded-lg bg-[#e11d48] text-white hover:bg-[#e11d48] cursor-pointer border-none flex items-center justify-center"
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
            {regularHolidays.map((date, idx) => (
              <div key={idx} className="flex items-center gap-2 mb-3">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => updateHoliday("regular", idx, e.target.value)}
                  className="flex-1 py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:outline-none focus:ring-0 focus:border-[#237227] cursor-pointer"
                />
                <button
                  onClick={() => removeHoliday("regular", idx)}
                  className="p-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-lg hover:bg-rose-50 cursor-pointer flex items-center justify-center"
                  title="Remove date"
                >
                  <FiX size={16} />
                </button>
              </div>
            ))}
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
            {specialHolidays.map((date, idx) => (
              <div key={idx} className="flex items-center gap-2 mb-3">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => updateHoliday("special", idx, e.target.value)}
                  className="flex-1 py-2 px-3 text-sm rounded-lg border border-gray-300 bg-white text-gray-800 outline-none focus:outline-none focus:ring-0 focus:border-[#237227] cursor-pointer"
                />
                <button
                  onClick={() => removeHoliday("special", idx)}
                  className="p-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-lg hover:bg-rose-50 cursor-pointer flex items-center justify-center"
                  title="Remove date"
                >
                  <FiX size={16} />
                </button>
              </div>
            ))}
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
