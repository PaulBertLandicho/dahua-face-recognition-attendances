// Payslip PDF layout (two copies per A4 page, separated by a cut line).
// Design: company header with logo, employee block, side-by-side
// EARNINGS / DEDUCTIONS columns, NET PAY, attendance summary and
// "Received by" signature line.

const COMPANY_NAME = "MULTIFACTORS SALES";
const COMPANY_ADDRESS = "0005 JUAN C. LEGASPI ST., UBALDO LAYA, ILIGAN CITY";
const LOGO_URL = "/image/logosidebar.jpg";
const LOGO_ASPECT = 244 / 1024; // height / width of the wordmark logo

const MM_PER_PT = 0.3528;
const COLOR_TEXT = [33, 33, 33];
const COLOR_MUTED = [95, 95, 95];
const COLOR_LINE = [70, 70, 70];
const COLOR_LIGHT_LINE = [205, 205, 205];

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseYMD(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatShortDate(d) {
  if (!d) return "";
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// "2026-10-16_to_2026-10-31" -> "Oct 16-31, 2026"
function formatPeriodShort(period) {
  if (!period) return "";
  const matches = Array.from(
    String(period).matchAll(/(\d{4}[-/]\d{2}[-/]\d{2})/g),
  ).map((m) => m[1]);
  if (matches.length >= 2) {
    const d1 = parseYMD(matches[0]);
    const d2 = parseYMD(matches[1]);
    if (d1 && d2) {
      if (d1.getFullYear() === d2.getFullYear()) {
        if (d1.getMonth() === d2.getMonth()) {
          return `${MONTHS_SHORT[d1.getMonth()]} ${d1.getDate()}-${d2.getDate()}, ${d1.getFullYear()}`;
        }
        return `${MONTHS_SHORT[d1.getMonth()]} ${d1.getDate()} - ${MONTHS_SHORT[d2.getMonth()]} ${d2.getDate()}, ${d1.getFullYear()}`;
      }
      return `${formatShortDate(d1)} - ${formatShortDate(d2)}`;
    }
  }
  const single = parseYMD(period);
  return single ? formatShortDate(single) : String(period);
}

function formatNumber(n) {
  const v = Math.abs(Number(n || 0));
  try {
    return v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch (e) {
    return v.toFixed(2);
  }
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function formatEmployeeCode(id) {
  if (id === null || id === undefined || id === "") return "";
  const s = String(id).trim();
  return /^\d+$/.test(s) ? `E-${s.padStart(3, "0")}` : s;
}

function formatHours(h) {
  const v = Number(h || 0);
  if (!v) return "0";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// Load the company logo as a PNG data URL (normalised through a canvas so
// the file extension / served content-type does not matter).
let cachedLogoPromise = null;
export function loadPayslipLogo() {
  if (cachedLogoPromise) return cachedLogoPromise;
  cachedLogoPromise = new Promise((resolve) => {
    try {
      if (typeof window === "undefined" || typeof Image === "undefined") {
        resolve(null);
        return;
      }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth || 1024;
          canvas.height = img.naturalHeight || 244;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          resolve({
            dataUrl: canvas.toDataURL("image/png"),
            aspect: canvas.height / canvas.width,
          });
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = LOGO_URL;
    } catch (e) {
      resolve(null);
    }
  }).then((res) => {
    if (!res) cachedLogoPromise = null; // allow retry next time
    return res;
  });
  return cachedLogoPromise;
}

export function drawPayslipOnDoc(
  doc,
  {
    payroll,
    person,
    period,
    totalHolidayPay = 0,
    absentCount = 0,
    lateDeduction = null,
    lateMinutes = null,
    otHours,
    daysWorked,
    standardPayAmount = null,
    otPay = null,
    gross = null,
    cashAdvanceTotalInPeriod = 0,
    expensesTotalInPeriod = 0,
    logo = null,
    payday = null,
  },
  yOffset = 10,
  scale = 1,
) {
  if (!doc || !payroll || !person) return;

  const s = scale || 1;
  const S = (v) => v * s;
  const pageWidth = doc.internal.pageSize.getWidth();
  const L = S(14);
  const R = pageWidth - S(14);
  const mid = pageWidth / 2;
  const leftAmountX = mid - S(8);
  const rightLabelX = mid + S(4);
  const rightAmountX = R;
  const y0 = yOffset;

  let currentColor = COLOR_TEXT;
  const setFont = (family, style, sizePt, color = COLOR_TEXT) => {
    doc.setFont(family, style);
    doc.setFontSize(sizePt * s);
    doc.setTextColor(color[0], color[1], color[2]);
    currentColor = color;
  };
  const capHeight = (sizePt, ratio = 0.718) => sizePt * s * MM_PER_PT * ratio;

  // Draw a peso sign (P with two horizontal strokes) whose left edge is at x.
  const drawPeso = (x, y, sizePt, { bold = false, capRatio = 0.718 } = {}) => {
    doc.text("P", x, y);
    const w = doc.getTextWidth("P");
    const cap = capHeight(sizePt, capRatio);
    doc.setDrawColor(currentColor[0], currentColor[1], currentColor[2]);
    doc.setLineWidth(sizePt * s * MM_PER_PT * (bold ? 0.085 : 0.065));
    [0.62, 0.8].forEach((r) => {
      const ly = y - cap * r;
      doc.line(x - w * 0.18, ly, x + w * 0.98, ly);
    });
    return w;
  };

  // Right-aligned amount with peso sign. Zero / empty -> short dash.
  const drawAmount = (
    value,
    rightX,
    y,
    { sizePt = 9, bold = false, family = "helvetica", capRatio = 0.718, showZero = false } = {},
  ) => {
    const n = round2(value);
    setFont(family, bold ? "bold" : "normal", sizePt);
    if (!n && !showZero) {
      const cap = capHeight(sizePt, capRatio);
      doc.setDrawColor(COLOR_TEXT[0], COLOR_TEXT[1], COLOR_TEXT[2]);
      doc.setLineWidth(S(0.25));
      doc.line(rightX - S(2.2), y - cap * 0.38, rightX, y - cap * 0.38);
      return;
    }
    const str = formatNumber(n);
    doc.text(str, rightX, y, { align: "right" });
    const w = doc.getTextWidth(str);
    const pw = doc.getTextWidth("P");
    const px = rightX - w - pw - S(0.2);
    drawPeso(px, y, sizePt, { bold, capRatio });
    if (n < 0) doc.text("-", px - S(0.4), y, { align: "right" });
  };

  const hLine = (y, color = COLOR_LINE, width = 0.3) => {
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(S(width));
    doc.line(L, y, R, y);
  };

  // ---------- Computations ----------
  const dailyRate = Number(payroll.dailyRate ?? person.daily_rate ?? 0);
  const days = Number(daysWorked ?? payroll.daysPresent ?? payroll.days_present ?? 0) || 0;
  const otHrs =
    typeof otHours !== "undefined" && otHours !== null
      ? Number(otHours) || 0
      : Number(payroll.otHours || 0);
  const hourlyRate = round2(dailyRate / 8);

  const basicPay =
    standardPayAmount != null ? round2(standardPayAmount) : round2(days * dailyRate);
  const overtimePay = otPay != null ? round2(otPay) : round2(hourlyRate * otHrs);
  const holidayPay = round2(totalHolidayPay);
  const totalEarnings =
    gross != null ? round2(gross) : round2(basicPay + overtimePay + holidayPay);

  const lateCountLimit = payroll.lateCountLimit || payroll.late_count_limit || 5;
  const lateDed = round2(
    lateDeduction != null
      ? lateDeduction
      : payroll.totalLateDeduction ??
          payroll.total_late_deduction ??
          (Number(payroll.lateCount || 0) >= lateCountLimit
            ? Number(payroll.lateCount || 0) * Number(person?.late_penalty || 0)
            : 0),
  );
  const grossPay = round2(totalEarnings - lateDed);

  const sss = person.sss ? round2(payroll.sss) : 0;
  const philhealth = person.philhealth ? round2(payroll.philhealth) : 0;
  const pagibig = person.pag_ibig ? round2(payroll.pag_ibig) : 0;
  const cashAdvance = round2(cashAdvanceTotalInPeriod || payroll.cashAdvance || 0);
  const otherDeductions = round2(
    expensesTotalInPeriod || payroll.expenses || payroll.totalExpenses || 0,
  );
  const totalDeductions = round2(sss + philhealth + pagibig + cashAdvance + otherDeductions);
  const netPay = Math.max(0, round2(grossPay - totalDeductions));

  // ---------- Header ----------
  setFont("times", "bold", 15);
  doc.text(COMPANY_NAME, L, y0 + S(6));

  const logoW = S(38);
  const logoH = logoW * ((logo && logo.aspect) || LOGO_ASPECT);
  if (logo && logo.dataUrl) {
    try {
      doc.addImage(logo.dataUrl, "PNG", rightLabelX, y0 + S(0.5), logoW, logoH);
    } catch (e) {
      // logo optional
    }
  }

  setFont("helvetica", "bold", 8.5, COLOR_MUTED);
  doc.text("PAYSLIP", R, y0 + S(5), { align: "right" });

  setFont("helvetica", "normal", 8, COLOR_MUTED);
  doc.text(COMPANY_ADDRESS, L, y0 + S(12));
  setFont("helvetica", "normal", 8.5, COLOR_TEXT);
  doc.text(formatPeriodShort(period), R, y0 + S(12), { align: "right" });

  // Employee block
  const empCode = formatEmployeeCode(person.id);
  const nameLine = `${String(person.name || "").toUpperCase()}${empCode ? `  \u00b7  ${empCode}` : ""}`;
  setFont("helvetica", "bold", 10.5);
  doc.text(nameLine, L, y0 + S(18));

  const paydayDate = parseYMD(payday || payroll.payday || payroll.released_at) || new Date();
  setFont("helvetica", "bold", 8.5);
  doc.text("Payday", rightLabelX, y0 + S(18));
  setFont("helvetica", "normal", 8.5);
  doc.text(formatShortDate(paydayDate), R, y0 + S(18), { align: "right" });

  const deptParts = [person.department, person.position]
    .filter((v) => v && String(v).trim())
    .map((v) => String(v).toUpperCase());
  setFont("helvetica", "normal", 8, COLOR_MUTED);
  doc.text(deptParts.join("  \u00b7  "), L, y0 + S(23));

  setFont("helvetica", "bold", 8.5);
  doc.text("Rate", rightLabelX, y0 + S(23));
  setFont("helvetica", "normal", 8.5);
  const rateSuffix = " / day";
  doc.text(rateSuffix, R, y0 + S(23), { align: "right" });
  drawAmount(dailyRate, R - doc.getTextWidth(rateSuffix), y0 + S(23), {
    sizePt: 8.5,
    showZero: true,
  });

  // ---------- Earnings / Deductions table ----------
  const headTop = y0 + S(25.5);
  hLine(headTop, COLOR_LINE, 0.35);
  const headY = headTop + S(3.6);
  setFont("helvetica", "bold", 7.5);
  doc.text("EARNINGS", L, headY);
  doc.text("DEDUCTIONS", rightLabelX, headY);
  drawPeso(leftAmountX - S(32), headY, 7.5, { bold: true });
  setFont("helvetica", "bold", 7.5);
  drawPeso(rightLabelX + S(36), headY, 7.5, { bold: true });
  hLine(headTop + S(5.2), COLOR_LINE, 0.35);

  const earnings = [
    ["Basic pay", basicPay],
    ["Paid leave", 0],
    ["Holiday & rest-day pay", holidayPay],
    ["Overtime", overtimePay],
    ["Night differential", 0],
    ["Holiday pay (not worked)", 0],
    ["Allowances", 0],
    ["Commission & other pay", 0],
    ["Bonus / 13th month", 0],
    ["Less: absences & late", lateDed ? -lateDed : 0],
  ];
  const deductions = [
    ["SSS", sss],
    ["PhilHealth", philhealth],
    ["Pag-IBIG", pagibig],
    ["Withholding tax", 0],
    ["Loans", 0],
    ["Cash advance", cashAdvance],
    ["Other deductions", otherDeductions],
  ];

  const rowStart = headTop + S(9.6);
  const rowStep = S(4.85);
  earnings.forEach(([label, value], i) => {
    const ry = rowStart + rowStep * i;
    setFont("helvetica", "normal", 8.8);
    doc.text(label, L, ry);
    drawAmount(value, leftAmountX, ry, { sizePt: 8.8 });
  });
  deductions.forEach(([label, value], i) => {
    const ry = rowStart + rowStep * i;
    setFont("helvetica", "normal", 8.8);
    doc.text(label, rightLabelX, ry);
    drawAmount(value, rightAmountX, ry, { sizePt: 8.8 });
  });

  const totalsLineY = rowStart + rowStep * (earnings.length - 1) + S(2.6);
  hLine(totalsLineY, COLOR_LIGHT_LINE, 0.25);
  const totalsY = totalsLineY + S(4.4);
  setFont("helvetica", "bold", 9);
  doc.text("Gross pay", L, totalsY);
  drawAmount(grossPay, leftAmountX, totalsY, { sizePt: 9, bold: true, showZero: true });
  setFont("helvetica", "bold", 9);
  doc.text("Total deductions", rightLabelX, totalsY);
  drawAmount(totalDeductions, rightAmountX, totalsY, { sizePt: 9, bold: true, showZero: true });

  // ---------- Net pay ----------
  const netY = totalsY + S(12);
  setFont("helvetica", "bold", 9);
  doc.text("NET PAY", L, netY);
  setFont("times", "bold", 20);
  const netStr = formatNumber(netPay);
  const pesoW = doc.getTextWidth("P");
  const netX = L + S(40);
  drawPeso(netX, netY, 20, { bold: true, capRatio: 0.662 });
  setFont("times", "bold", 20);
  doc.text(netStr, netX + pesoW + S(0.3), netY);

  // Attendance summary
  const regularHrs = days * 8;
  const lateMin =
    lateMinutes != null ? Math.round(Number(lateMinutes) || 0) : null;
  const summaryParts = [
    `${formatHours(days)} days worked`,
    `${formatHours(regularHrs)} regular hrs`,
    `${formatHours(round2(otHrs))} OT hrs`,
  ];
  if (lateMin != null) {
    summaryParts.push(`late ${lateMin} min (${Number(payroll.lateCount || 0)}x)`);
  } else {
    summaryParts.push(`late ${Number(payroll.lateCount || 0)}x`);
  }
  summaryParts.push(`${Number(absentCount || 0)} absent`);
  setFont("helvetica", "italic", 8, COLOR_MUTED);
  doc.text(summaryParts.join("  \u00b7  "), L, netY + S(6));

  setFont("helvetica", "italic", 8.5, COLOR_TEXT);
  doc.text("GOD BLESS YOU!", L, netY + S(12));

  setFont("helvetica", "normal", 8.5, COLOR_TEXT);
  const recvY = netY + S(18);
  doc.text("Received by:", L, recvY);
  const recvLabelW = doc.getTextWidth("Received by:");
  doc.setDrawColor(COLOR_TEXT[0], COLOR_TEXT[1], COLOR_TEXT[2]);
  doc.setLineWidth(S(0.25));
  doc.line(L + recvLabelW + S(2), recvY + S(0.6), L + recvLabelW + S(50), recvY + S(0.6));
  const dateX = L + recvLabelW + S(58);
  doc.text("Date:", dateX, recvY);
  const dateLabelW = doc.getTextWidth("Date:");
  doc.line(dateX + dateLabelW + S(2), recvY + S(0.6), dateX + dateLabelW + S(30), recvY + S(0.6));

  // reset colours for subsequent drawing
  doc.setTextColor(0, 0, 0);
  doc.setDrawColor(0, 0, 0);
}

// Dashed cut line with scissors between the two copies
function drawCutLine(doc, y) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.25);
  if (typeof doc.setLineDashPattern === "function") doc.setLineDashPattern([1.5, 1.2], 0);
  doc.line(12, y, pageW - 6, y);
  if (typeof doc.setLineDashPattern === "function") doc.setLineDashPattern([], 0);
  try {
    doc.setFont("ZapfDingbats", "normal");
    doc.setFontSize(10);
    doc.setTextColor(120, 120, 120);
    doc.text("\"", 5, y + 1.3);
  } catch (e) {
    // scissors glyph is decorative only
  }
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0, 0, 0);
  doc.setDrawColor(0, 0, 0);
}

const BASE_COPY_HEIGHT = 122; // approximate design height of one copy in mm
const COPY_MARGIN_Y = 9;

function copyScale(pageHeight) {
  const availableHalf = pageHeight / 2 - COPY_MARGIN_Y * 2;
  return Math.min(1, availableHalf / BASE_COPY_HEIGHT);
}

// Generate a single-person payslip PDF (used by PayslipModal)
export async function generatePayslipPdf(params) {
  if (!params || !params.payroll || !params.person) return;
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const logo = await loadPayslipLogo();
  const drawParams = { ...params, logo };

  const pageHeight = doc.internal.pageSize.getHeight();
  const scale = copyScale(pageHeight);
  // Top copy
  drawPayslipOnDoc(doc, drawParams, COPY_MARGIN_Y, scale);
  // Cut line between copies
  drawCutLine(doc, pageHeight / 2);
  // Bottom copy (duplicate)
  drawPayslipOnDoc(doc, drawParams, pageHeight / 2 + COPY_MARGIN_Y, scale);

  doc.save(`${params.person.name}_payslip.pdf`);
}

// Generate a single PDF containing payslips for many records (used by PayrollPage)
export async function generateAllPayslipsPdf(list = [], periodSlug = "") {
  if (!Array.isArray(list) || list.length === 0) return;
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const logo = await loadPayslipLogo();

  const pageHeight = doc.internal.pageSize.getHeight();
  const scale = copyScale(pageHeight);

  for (let i = 0; i < list.length; i++) {
    const params = { ...list[i], logo };
    const isTop = i % 2 === 0;
    const yOffset = isTop ? COPY_MARGIN_Y : pageHeight / 2 + COPY_MARGIN_Y;
    drawPayslipOnDoc(doc, params, yOffset, scale);
    if (isTop) {
      drawCutLine(doc, pageHeight / 2);
    } else if (i < list.length - 1) {
      doc.addPage();
    }
  }

  const filename = periodSlug
    ? `all_payslips_${String(periodSlug).replace(/[^\w-]/g, "_")}.pdf`
    : "payroll_summary_payslips.pdf";
  doc.save(filename);
}
