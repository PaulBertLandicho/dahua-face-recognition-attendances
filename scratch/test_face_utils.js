const assert = require("assert");
const crypto = require("crypto");

// 1. Test EAR calculation
function eyeAspectRatio(p) {
  if (!p || p.length < 6) return 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const v1 = dist(p[1], p[5]);
  const v2 = dist(p[2], p[4]);
  const h = dist(p[0], p[3]);
  if (h <= 0) return 0;
  return (v1 + v2) / (2.0 * h);
}

// 6 points representing an open eye (approx 30px width, 10px height)
const openEye = [
  { x: 10, y: 50 },  // p1 (outer)
  { x: 20, y: 45 },  // p2 (top outer)
  { x: 30, y: 45 },  // p3 (top inner)
  { x: 40, y: 50 },  // p4 (inner)
  { x: 30, y: 55 },  // p5 (bottom inner)
  { x: 20, y: 55 },  // p6 (bottom outer)
];

// Closed eye (vertical distance collapsed to 1px)
const closedEye = [
  { x: 10, y: 50 },
  { x: 20, y: 49.5 },
  { x: 30, y: 49.5 },
  { x: 40, y: 50 },
  { x: 30, y: 50.5 },
  { x: 20, y: 50.5 },
];

const openEar = eyeAspectRatio(openEye);
const closedEar = eyeAspectRatio(closedEye);

console.log("Open EAR:", openEar.toFixed(3));
console.log("Closed EAR:", closedEar.toFixed(3));
assert(openEar >= 0.25, "Open EAR should be >= 0.25");
assert(closedEar <= 0.10, "Closed EAR should be <= 0.10");
console.log("TEST 1 PASSED: Eye aspect ratio calculation is correct.");

// 2. Test Blink Detector State Machine
function createBlinkDetector({
  openThreshold = 0.23,
  closeThreshold = 0.19,
  windowMs = 5000,
} = {}) {
  let state = "WAIT_OPEN";
  let startTime = 0;

  return {
    update(ear, now = Date.now()) {
      if (state === "BLINK_CONFIRMED") return true;

      if (startTime > 0 && now - startTime > windowMs) {
        state = "WAIT_OPEN";
        startTime = 0;
      }

      if (state === "WAIT_OPEN") {
        if (ear >= openThreshold) {
          state = "DETECT_CLOSED";
          startTime = now;
        }
      } else if (state === "DETECT_CLOSED") {
        if (ear <= closeThreshold) {
          state = "CONFIRM_REOPEN";
        }
      } else if (state === "CONFIRM_REOPEN") {
        if (ear >= openThreshold) {
          state = "BLINK_CONFIRMED";
          return true;
        }
      }

      return state === "BLINK_CONFIRMED";
    },
    reset() {
      state = "WAIT_OPEN";
      startTime = 0;
    },
    getState() {
      return state;
    },
  };
}

const detector = createBlinkDetector();
let t = 1000;
// Frame 1: eye open
assert(!detector.update(0.30, t), "Should not confirm on initial open eye");
assert.strictEqual(detector.getState(), "DETECT_CLOSED");

// Frame 2: eyes close (blink)
t += 100;
assert(!detector.update(0.12, t), "Should not confirm while eye is closed");
assert.strictEqual(detector.getState(), "CONFIRM_REOPEN");

// Frame 3: eye opens again
t += 100;
assert(detector.update(0.30, t), "Should confirm blink on reopen");
assert.strictEqual(detector.getState(), "BLINK_CONFIRMED");

// Verify staying open does not trigger a false blink
const staticDetector = createBlinkDetector();
for (let i = 0; i < 20; i++) {
  assert(!staticDetector.update(0.32, 2000 + i * 50), "Static open eyes must never trigger a blink");
}

console.log("TEST 2 PASSED: Blink detector handles Open -> Closed -> Open and rejects static open eyes.");

// 3. Test Token Signing and Verification (from server.js)
const SECRET = "test_secret_key_1234567890";

function signFaceToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyFaceToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: "Malformed token" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, error: "Invalid token format" };
  const [bodyB64, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SECRET).update(bodyB64).digest("base64url");
  
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: "Invalid signature" };
  }

  try {
    const payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf-8"));
    const now = Date.now();
    if (payload.exp && now > payload.exp + (10 * 60 * 1000)) {
      return { valid: false, error: "Token expired" };
    }
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: "Corrupted payload" };
  }
}

const token = signFaceToken({ pid: "101", name: "Paulix", exp: Date.now() + 300000 });
const verified = verifyFaceToken(token);
assert(verified.valid, "Valid token should verify");
assert.strictEqual(verified.payload.name, "Paulix");

// Tampered token test
const tampered = token.slice(0, -4) + "XXXX";
const tamperedRes = verifyFaceToken(tampered);
assert(!tamperedRes.valid, "Tampered token signature must fail");

// Expired token test
const expiredToken = signFaceToken({ pid: "101", name: "Paulix", exp: Date.now() - 700000 });
const expiredRes = verifyFaceToken(expiredToken);
assert(!expiredRes.valid, "Expired token must fail");

console.log("TEST 3 PASSED: HMAC token generation, verification, tamper-detection, and expiry work as expected.");
console.log("ALL ALGORITHMIC TESTS PASSED SUCCESSFULLY!");
