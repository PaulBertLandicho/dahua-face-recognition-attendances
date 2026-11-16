import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import Dashboard from "./Dashboard";
import { supabase } from "../mysqlClient";

jest.mock(
  "react-router-dom",
  () => ({
    useNavigate: () => jest.fn(),
  }),
  { virtual: true }
);

jest.mock("sweetalert2", () => ({
  fire: jest.fn(),
}));

jest.mock("xlsx", () => ({
  utils: { json_to_sheet: jest.fn(), book_new: jest.fn(), book_append_sheet: jest.fn() },
  writeFile: jest.fn(),
}));

jest.mock("../mysqlClient", () => ({
  supabase: {
    from: jest.fn(),
  },
}));

describe("Dashboard Today's Attendance photo rendering", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("fetches registration_photo and today's attendance photo and renders images with registration fallback", async () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const todayPrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const selectedCalls = [];

    const attendanceHistoryRows = [
      {
        id: 101,
        device_time: `${todayPrefix} 09:01:08`,
        person_id: "12",
        name: "Beca",
        department: "EXE. SECRETARY",
        event: "time-in",
        status: "late",
        method: "face",
        point: null,
      },
      {
        id: 102,
        device_time: `${todayPrefix} 08:24:00`,
        person_id: "3",
        name: "Kent",
        department: "IT-STAFF",
        event: "time-in",
        status: "late",
        method: "field-site",
        point: "14.5,121.0",
      },
      {
        id: 103,
        device_time: `${todayPrefix} 08:05:00`,
        person_id: "99",
        name: "NoPic",
        department: "IT-STAFF",
        event: "time-in",
        status: "late",
        method: "face",
        point: null,
      },
    ];

    const todayPhotoRows = [
      { id: 101, photo: null },
      { id: 102, photo: "data:image/jpeg;base64,STOREPF" },
      { id: 103, photo: null },
    ];

    const personRows = [
      {
        id: "12",
        name: "Beca",
        department: "EXE. SECRETARY",
        registration_photo: "data:image/jpeg;base64,BECAREG",
      },
      {
        id: "3",
        name: "Kent",
        department: "IT-STAFF",
        registration_photo: "data:image/jpeg;base64,KENTREG",
      },
      {
        id: "99",
        name: "NoPic",
        department: "IT-STAFF",
        registration_photo: null,
      },
    ];

    const makeBuilder = (table) => {
      const builder = {
        columns: "*",
        select(cols) {
          this.columns = cols;
          selectedCalls.push({ table, columns: cols });
          return this;
        },
        gte() {
          return this;
        },
        eq() {
          return this;
        },
        order() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: { morning_start: "08:00:00" }, error: null });
        },
        then(resolve, reject) {
          let payload;
          if (table === "attendance") {
            payload = String(this.columns).includes("photo")
              ? { data: todayPhotoRows, error: null }
              : { data: attendanceHistoryRows, error: null };
          } else if (table === "persons") {
            payload = { data: personRows, error: null };
          } else if (table === "payroll_released_history") {
            payload = { data: [], error: null };
          } else {
            payload = { data: [], error: null };
          }
          return Promise.resolve(payload).then(resolve, reject);
        },
      };
      return builder;
    };

    supabase.from.mockImplementation((table) => makeBuilder(table));

    render(<Dashboard />);

    const becaImg = await screen.findByAltText("Beca");
    expect(becaImg).toHaveAttribute("src", "data:image/jpeg;base64,BECAREG");

    const kentImg = await screen.findByAltText("Kent");
    expect(kentImg).toHaveAttribute("src", "data:image/jpeg;base64,STOREPF");

    await waitFor(() => {
      expect(screen.getByText("NO")).toBeInTheDocument();
    });

    const attHistorySelect = selectedCalls.find(
      (c) => c.table === "attendance" && c.columns.includes("device_time")
    );
    const attTodayPhotoSelect = selectedCalls.find(
      (c) => c.table === "attendance" && c.columns.includes("photo")
    );
    const personsSelect = selectedCalls.find((c) => c.table === "persons");

    expect(attHistorySelect.columns).not.toContain("photo");
    expect(attTodayPhotoSelect.columns).toBe("id,photo");
    expect(personsSelect.columns).toContain("registration_photo");
  });
});
