import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import UserAttendanceScanner, { isHiddenMobileAdmin } from "./UserAttendanceScanner";
import offlineQueue from "../utils/offlineQueue";
import { isValidGpsCoords } from "../utils/gpsLocation";

jest.mock(
  "react-router-dom",
  () => ({
    Navigate: ({ to }) => <div data-testid="navigate" data-to={to} />,
    Link: ({ children, to, ...rest }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }),
  { virtual: true }
);

jest.mock("./FaceVerificationGate", () => function MockFaceVerificationGate({ onVerified }) {
  return (
    <button
      type="button"
      onClick={() =>
        onVerified({
          person: { id: "2", name: "Nathan", department: "IT-STAFF" },
          token: "face-token",
          isOffline: false,
        })
      }
    >
      Verify Mock Face
    </button>
  );
});

jest.mock("../utils/offlineQueue", () => ({
  __esModule: true,
  default: {
    savePersons: jest.fn(),
    saveSettings: jest.fn(),
    getPersons: jest.fn(),
    getSettings: jest.fn(),
    getAllQueue: jest.fn(),
    syncQueue: jest.fn(),
  },
}));

jest.mock("../utils/gpsLocation", () => ({
  createAutoGpsTracker: jest.fn(),
  isValidGpsCoords: jest.fn(),
}));

jest.mock("../mysqlClient", () => ({
  supabase: { from: jest.fn() },
  setActiveFaceToken: jest.fn(),
}));

describe("UserAttendanceScanner mobile partner dropdown", () => {
  const originalFetch = global.fetch;
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    jest.clearAllMocks();
    offlineQueue.savePersons.mockResolvedValue();
    offlineQueue.saveSettings.mockResolvedValue();
    offlineQueue.getPersons.mockResolvedValue([]);
    offlineQueue.getSettings.mockResolvedValue(null);
    offlineQueue.getAllQueue.mockResolvedValue([]);
    offlineQueue.syncQueue.mockResolvedValue();
    isValidGpsCoords.mockReturnValue(true);

    const gpsModule = require("../utils/gpsLocation");
    gpsModule.createAutoGpsTracker.mockImplementation(() => ({
      start: jest.fn(),
      stop: jest.fn(),
      refresh: jest.fn(),
      getFreshSnapshot: jest.fn().mockResolvedValue("14.5995,120.9842"),
    }));

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: jest.fn().mockResolvedValue([]),
        getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop: jest.fn() }] }),
      },
    });

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            persons: [
              { id: "13", name: "Mac mac", department: "I-TECHNICAL PERSONNEL" },
              { id: "14", name: "mjay", department: "HR ADMIN" },
              { id: "ADMIN-001", name: "Multifactors Admin", department: "Admin" },
              { id: "99", name: "Multifactors Admin", department: "Admin" },
              { id: "2", name: "Nathan", department: "IT-STAFF" },
            ],
            settings: { morning_start: "08:00:00" },
          }),
      })
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  test("isHiddenMobileAdmin identifies ADMIN-001 and Multifactors Admin cleanly", () => {
    expect(isHiddenMobileAdmin({ id: "ADMIN-001", name: "Portal Admin" })).toBe(true);
    expect(isHiddenMobileAdmin({ id: "42", name: " Multifactors Admin " })).toBe(true);
    expect(isHiddenMobileAdmin({ id: "14", name: "mjay", department: "HR ADMIN" })).toBe(false);
  });

  test("hides Multifactors Admin in the mobile partner dropdown while keeping employees visible", async () => {
    await act(async () => {
      render(<UserAttendanceScanner isMobile={true} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify Mock Face" }));
    });

    const dropdownTrigger = screen
      .getAllByText("Nathan")
      .find((el) => el.closest(".cursor-pointer"));
    expect(dropdownTrigger).toBeTruthy();

    fireEvent.click(dropdownTrigger);

    expect(screen.getByText("Mac mac")).toBeInTheDocument();
    expect(screen.getByText("mjay")).toBeInTheDocument();
    expect(screen.queryByText("Multifactors Admin")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select All" }));
    expect(screen.getByText("3 Selected")).toBeInTheDocument();
  });

  test("hides Multifactors Admin even when loading cached persons offline", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    offlineQueue.getPersons.mockResolvedValue([
      { id: "13", name: "Mac mac", department: "I-TECHNICAL PERSONNEL" },
      { id: "ADMIN-001", name: "Multifactors Admin", department: "Admin" },
      { id: "2", name: "Nathan", department: "IT-STAFF" },
    ]);

    await act(async () => {
      render(<UserAttendanceScanner isMobile={true} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify Mock Face" }));
    });

    const dropdownTrigger = screen
      .getAllByText("Nathan")
      .find((el) => el.closest(".cursor-pointer"));
    fireEvent.click(dropdownTrigger);

    expect(screen.getByText("Mac mac")).toBeInTheDocument();
    expect(screen.queryByText("Multifactors Admin")).not.toBeInTheDocument();
  });
});
