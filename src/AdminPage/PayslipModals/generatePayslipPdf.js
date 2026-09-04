export function drawPayslipOnDoc(
  doc,
  {
    payroll,
    person,
    period,
    holidayPayDetails = [],
    totalHolidayPay = 0,
    absentCount = 0,
    totalDeductions = 0,
    otHours,
    daysWorked = payroll?.daysPresent || 0,
    standardPayAmount = null,
    otPay = null,
    gross = null,
    cashAdvanceEntries = [],
    cashAdvanceTotalInPeriod = 0,
  },
  yOffset = 10,
  scale = 1,
) {
  if (!doc || !payroll || !person) return;

  const left = 10 * (scale || 1);
  const pageWidth = doc.internal.pageSize.getWidth();
  const right = pageWidth - 10 * (scale || 1);
  const lineHeight = 7 * (scale || 1);
  let y = yOffset;

  // Header
  doc.setFontSize(10 * (scale || 1));
  doc.text(
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    right - 50 * (scale || 1),
    y,
  );
  y += lineHeight * 1.5;

  doc.setFontSize(12 * (scale || 1));
  doc.text("Full Name:", left, y);
  doc.text(person.name || "", left + 25 * (scale || 1), y);

  // Person image (if available and valid data URL)
  let imageDrawn = false;
  if (
    person.registration_photo &&
    typeof person.registration_photo === "string" &&
    person.registration_photo.startsWith("data:image/")
  ) {
    try {
      doc.addImage(
        person.registration_photo,
        "JPEG",
        right - 50 * (scale || 1),
        y - 8 * (scale || 1),
        30 * (scale || 1),
        20 * (scale || 1),
      );
      imageDrawn = true;
    } catch (e) {
      try {
        doc.addImage(
          person.registration_photo,
          "PNG",
          right - 50 * (scale || 1),
          y - 8 * (scale || 1),
          30 * (scale || 1),
          20 * (scale || 1),
        );
        imageDrawn = true;
      } catch (e2) {
        // fallback below
      }
    }
  }
  if (!imageDrawn) {
    doc.rect(
      right - 50 * (scale || 1),
      y - 8 * (scale || 1),
      30 * (scale || 1),
      20 * (scale || 1),
      "S",
    );
    doc.text("image", right - 35 * (scale || 1), y - 5 * (scale || 1), {
      align: "center",
    });
  }

  y += lineHeight;
  doc.setFontSize(10 * (scale || 1));
  doc.text("Period:", left, y);
  // Format period for readability (e.g. 2026-04-07_to_2026-04-21 -> April 07, 2026 to April 21, 2026)
  function formatPeriod(p) {
    if (!p) return "";
    try {
      const s = String(p).replace(/_/g, " ");
      const matches = Array.from(s.matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g)).map(
        (m) => m[1],
      );
      if (matches.length >= 2) {
        const d1 = new Date(matches[0].replace(/\//g, "-"));
        const d2 = new Date(matches[1].replace(/\//g, "-"));
        if (!Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime())) {
          const f1 = d1.toLocaleDateString("en-US", {
            month: "long",
            day: "2-digit",
            year: "numeric",
          });
          const f2 = d2.toLocaleDateString("en-US", {
            month: "long",
            day: "2-digit",
            year: "numeric",
          });
          return `${f1} to ${f2}`;
        }
      }
      const single = s.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
      if (single) {
        const d = new Date(single[1].replace(/\//g, "-"));
        if (!Number.isNaN(d.getTime()))
          return d.toLocaleDateString("en-US", {
            month: "long",
            day: "2-digit",
            year: "numeric",
          });
      }
      const pdate = new Date(s);
      if (!Number.isNaN(pdate.getTime()))
        return pdate.toLocaleDateString("en-US", {
          month: "long",
          day: "2-digit",
          year: "numeric",
        });
    } catch (e) {}
    return String(p);
  }

  doc.text(formatPeriod(period) || "", left + 20, y);
  y += lineHeight;
  doc.text("Total Days:", left, y);
  doc.text(String(daysWorked || payroll.daysPresent || ""), left + 35, y);

  y += lineHeight * 1.5;
  // Currency helper and symbol
  const peso = "PHP";
  const formatCurrency = (amt) => {
    const n = Number(amt || 0);
    try {
      return `${peso} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } catch (e) {
      return `${peso} ${n.toFixed(2)}`;
    }
  };

  // Helper to draw left label with a line on the right and right-aligned value
  const labelX = left + 40 * (scale || 1);
  const lineStartX = right - 70 * (scale || 1);
  const lineEndX = right - 10 * (scale || 1);
  const drawLinedField = (label, value, bold = false) => {
    if (bold) doc.setFont(undefined, "bold");
    doc.setFontSize(10 * (scale || 1));
    doc.text(label, labelX, y);
    if (bold) doc.setFont(undefined, "normal");
    doc.line(lineStartX, y, lineEndX, y);
    const text =
      value != null && String(value).trim() !== "" ? String(value) : "";
    if (text) {
      const valueX = (lineStartX + lineEndX) / 2;
      doc.text(text, valueX, y - 1.5 * (scale || 1), { align: "center" });
    }
    y += lineHeight;
  };

  // Earnings block fields
  drawLinedField("Basic Salary Rate:", formatCurrency(payroll.dailyRate ?? 0));
  drawLinedField(
    "Total of days worked (present):",
    String(daysWorked || payroll.daysPresent || 0),
  );
  // Determine overtime hours to display: prefer explicit param, fallback to payroll value
  const otHoursToShow =
    typeof otHours !== "undefined" ? otHours : Number(payroll.otHours || 0);
  const formatHoursDecimalToLabel = (hrs) => {
    if (!hrs || Number(hrs) <= 0) return "0.00";
    const h = Math.floor(hrs);
    const m = Math.round((hrs - h) * 60);
    const parts = [];
    if (h > 0) parts.push(`${h}hr`);
    if (m > 0) parts.push(`${m}min`);
    return `${Number(hrs).toFixed(2)} (${parts.join(" and ") || "0min"})`;
  };
  drawLinedField("Overtime hrs:", formatHoursDecimalToLabel(otHoursToShow));
  // Compute holiday percent sums by type (use ratePercent when available,
  // fallback: Regular=100%, Special=0%)
  let regularCount = 0;
  let specialCount = 0;
  let regularPercentSum = 0;
  let specialPercentSum = 0;
  if (Array.isArray(holidayPayDetails)) {
    holidayPayDetails.forEach((h) => {
      const type = (h && h.type) || "regular";
      const rate = Number(h && h.ratePercent) || (type === "regular" ? 100 : 0);
      if (type === "regular") {
        regularCount += 1;
        regularPercentSum += rate;
      } else {
        specialCount += 1;
        specialPercentSum += rate;
      }
    });
  }
  let holidayLabel = "0";
  if (regularCount || specialCount) {
    const parts = [];
    if (regularCount) parts.push(`Regular: ${regularPercentSum}% (${regularCount} day${regularCount>1?"s":""})`);
    if (specialCount) parts.push(`Special: ${specialPercentSum}% (${specialCount} day${specialCount>1?"s":""})`);
    holidayLabel = parts.join("; ");
  }
  drawLinedField("Holiday Day(s):", holidayLabel);
  // Allowance line with no preset value
  // Use explicit gross if provided, otherwise fallback to payroll.gross
  const grossToShow =
    gross != null
      ? gross
      : typeof payroll.gross !== "undefined"
        ? payroll.gross
        : (standardPayAmount || 0) + (otPay || 0) + totalHolidayPay;
  drawLinedField("Total:", formatCurrency(Number(grossToShow)), true);

  y += lineHeight;
  doc.setFont(undefined, "bold");
  doc.setFontSize(10 * (scale || 1));
  doc.text("Late / Absent", pageWidth / 2, y, { align: "center" });
  doc.setFont(undefined, "normal");
  y += lineHeight;
  drawLinedField("Total numbers of Late:", String(payroll.lateCount || 0));
  drawLinedField("Total numbers of Absent:", String(absentCount || 0));

  // Monthly Share = SSS + Pag-ibig + PhilHealth
  const monthlyShare =
    (person.sss ? Number(payroll.sss) : 0) +
    (person.pag_ibig ? Number(payroll.pag_ibig) : 0) +
    (person.philhealth ? Number(payroll.philhealth) : 0);
  drawLinedField("Monthly Share:", formatCurrency(monthlyShare));
  drawLinedField(
    "Cash Advance:",
    formatCurrency(
      Number(cashAdvanceTotalInPeriod || payroll.cashAdvance || 0),
    ),
  );
  // If there are individual cash advance entries, render a brief breakdown above the total
  if (Array.isArray(cashAdvanceEntries) && cashAdvanceEntries.length > 0) {
    y += lineHeight * 0.2;
    doc.setFontSize(9 * (scale || 1));
    doc.text("Cash Advance Details:", left + 12 * (scale || 1), y);
    y += lineHeight;
    cashAdvanceEntries.forEach((e) => {
      const label = e.created_at ? new Date(e.created_at).toLocaleString() : "";
      const value = formatCurrency(Number(e.amount || 0));
      drawLinedField(label, value, false);
    });
    y += lineHeight * 0.2;
    doc.setFontSize(10 * (scale || 1));
  }
  drawLinedField("Total:", formatCurrency(totalDeductions), true);

  y += lineHeight;
  // Net Pay = Gross - Total Deductions
  try {
    const grossAmount =
      typeof gross !== "undefined" && gross !== null
        ? Number(gross)
        : Number(grossToShow || 0);
    const deductionsAmount = Number(totalDeductions || 0);
    const netPay = Math.max(0, Math.round((grossAmount - deductionsAmount) * 100) / 100);
    drawLinedField("Net Pay:", formatCurrency(netPay), true);
  } catch (e) {
    // ignore net pay rendering errors
  }
  // Single-line approval/received footer left-aligned (match sample)
  doc.setFontSize(10 * (scale || 1));
  doc.text("Approved by:  Received from MULTIFACTORS SALES", left, y);
}

// Generate a single-person payslip PDF (used by PayslipModal)
export async function generatePayslipPdf(params) {
  if (!params || !params.payroll || !params.person) return;
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  // Draw two identical payslips on one page (top and bottom) so there is a duplicate copy
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginY = 10;
  const pageW = doc.internal.pageSize.getWidth();
  // compute a scale so two copies fit comfortably in half-pages
  // increase baseCopyHeight to slightly shrink copies for safe fit
  const baseCopyHeight = 160; // approximate original design height in mm
  const availableHalf = pageHeight / 2 - marginY * 2;
  const scale = Math.min(1, availableHalf / baseCopyHeight);
  // Top copy
  drawPayslipOnDoc(doc, params, marginY, scale);
  // Divider line between copies
  doc.setDrawColor(200);
  doc.setLineWidth(0.3);
  doc.line(5, pageHeight / 2, pageW - 5, pageHeight / 2);
  // Bottom copy
  drawPayslipOnDoc(doc, params, pageHeight / 2 + marginY, scale);

  doc.save(`${params.person.name}_payslip.pdf`);
}

// Generate a single PDF containing payslips for many records (used by PayrollPage)
export async function generateAllPayslipsPdf(list = []) {
  if (!Array.isArray(list) || list.length === 0) return;
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // Layout: two payslips per page, one on top, one on bottom
  const marginY = 10;
  const pageHeight = doc.internal.pageSize.getHeight();
  // Removed unused payslipHeight

  for (let i = 0; i < list.length; i++) {
    const params = list[i];
    const isTop = i % 2 === 0;
    const yOffset = isTop ? marginY : pageHeight / 2 + marginY;
    // Draw payslip at yOffset
    // compute scale per page similar to single-person
    const baseCopyHeight = 160;
    const availableHalf = pageHeight / 2 - marginY * 2;
    const scale = Math.min(1, availableHalf / baseCopyHeight);
    drawPayslipOnDoc(doc, params, yOffset, scale);
    // If next payslip is top (i.e., every 2 payslips), add a new page
    if (!isTop && i < list.length - 1) {
      doc.addPage();
    }
    // Draw a line between the two payslips on the same page
    if (isTop) {
      const pageW = doc.internal.pageSize.getWidth();
      doc.setDrawColor(200);
      doc.setLineWidth(0.3);
      doc.line(5, pageHeight / 2, pageW - 5, pageHeight / 2);
    }
  }

  doc.save("payroll_summary_payslips.pdf");
}
