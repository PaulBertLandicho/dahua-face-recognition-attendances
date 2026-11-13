import React from "react";
import { render, screen, act } from "@testing-library/react";
import * as faceapi from "face-api.js";
import FaceVerificationGate, { NO_FACE_TIMEOUT_MS } from "./FaceVerificationGate";

jest.mock(
  "react-router-dom",
  () => ({
    Link: ({ children, to, ...rest }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }),
  { virtual: true }
);

jest.mock("face-api.js", () => ({
  TinyFaceDetectorOptions: function TinyFaceDetectorOptions() {},
  detectSingleFace: jest.fn(),
}));

jest.mock("../utils/buildFaceDescriptors", () => ({
  ensureFaceModelsLoaded: jest.fn(() => Promise.resolve()),
  buildDescriptors: jest.fn(() => Promise.resolve({ built: 0 })),
}));

jest.mock("../utils/offlineQueue", () => ({
  savePersons: jest.fn(() => Promise.resolve()),
  getPersons: jest.fn(() => Promise.resolve([])),
}));

describe("FaceVerificationGate no-face redirect timeout", () => {
  const originalMediaDevices = navigator.mediaDevices;
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    faceapi.detectSingleFace.mockReturnValue({
      withFaceLandmarks: () => ({
        withFaceDescriptor: () => Promise.resolve(null),
      }),
    });

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, persons: [] }),
      })
    );

    HTMLMediaElement.prototype.play = jest.fn(() => Promise.resolve());
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    HTMLMediaElement.prototype.play = originalPlay;
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test("configures NO_FACE_TIMEOUT_MS within 3-5 seconds and redirects to Ready for Verification when no face is detected", async () => {
    expect(NO_FACE_TIMEOUT_MS).toBeGreaterThanOrEqual(3000);
    expect(NO_FACE_TIMEOUT_MS).toBeLessThanOrEqual(5000);

    const stopTrack = jest.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn(() =>
          Promise.resolve({
            getTracks: () => [{ stop: stopTrack }],
          })
        ),
      },
    });

    render(
      <FaceVerificationGate
        onVerified={jest.fn()}
        locationPoint="14.5995, 120.9842"
        formattedTime="10:05:00 AM"
        formattedDate="Nov 13"
      />
    );

    // Flush model loading, auto-start getUserMedia, and video.play activation
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Ready for Verification")).not.toBeInTheDocument();

    // Still active before the timeout expires
    act(() => {
      jest.advanceTimersByTime(NO_FACE_TIMEOUT_MS - 1000);
    });
    expect(screen.queryByText("Ready for Verification")).not.toBeInTheDocument();

    // Redirects once the no-face timeout elapses
    act(() => {
      jest.advanceTimersByTime(1250);
    });

    expect(screen.getByText("Ready for Verification")).toBeInTheDocument();
    expect(
      screen.getByText(
        /No face detected for 5 seconds\. Tap below to activate your front camera and verify your identity\./i
      )
    ).toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalled();
  });
});
