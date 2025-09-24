// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: "https://sprightly-dieffenbachia-8c081a.netlify.app" }));

// ===== Replace these with your real credentials =====
const API_KEY = "hmp_keozjmAk6bEwi0J2vaDB063tGwKkagHJtmnykFEh";
const USER_EMAIL = "kipkoechabel69@gmail.com";
const PAYMENT_LINK_CODE = "PNT_366813";

const STATUM_KEY = "18885957c3a6cd14410aa9bfd7c16ba5273";
const STATUM_SECRET = "sqPzmmybSXtQm7BJQIbz188vUR8P";

// ===== Config =====
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 40;  // ~200s
const CLEANUP_TIMEOUT = 300000; // 5 minutes

// Create logs dir if missing
if (!fs.existsSync("logs")) fs.mkdirSync("logs");

// In-memory tracker: reference → entry
const pending = new Map();

// === helpers ===
function logToFile(filename, data) {
  const logEntry = { timestamp: new Date().toISOString(), ...data };
  fs.appendFileSync(`logs/${filename}`, JSON.stringify(logEntry) + "\n", "utf8");
}

function getAuthHeader() {
  const authString = `${STATUM_KEY}:${STATUM_SECRET}`;
  return `Basic ${Buffer.from(authString).toString("base64")}`;
}

function normalizeStatus(status) {
  if (!status) return "pending";
  const s = String(status).toLowerCase();
  if (["success", "successful", "paid", "completed"].includes(s)) return "success";
  if (["failed", "fail", "declined"].includes(s)) return "failed";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  return "pending";
}

// === Statum airtime ===
async function sendAirtime(phoneNumber, amount, reference) {
  try {
    const payload = { phone_number: phoneNumber, amount: String(amount) };
    console.log("➡️  Calling Statum:", payload);
    logToFile("airtime_attempt.log", { reference, payload });

    const resp = await fetch("https://api.statum.co.ke/api/v2/airtime", {
      method: "POST",
      headers: {
        "Authorization": getAuthHeader(),
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload),
    });

    const result = await resp.json();
    console.log("⬅️ Statum response:", result);
    logToFile("airtime_requests.log", { reference, request: payload, response: result });

    const ok =
      (result?.status_code && Number(result.status_code) === 200) ||
      result?.success === true ||
      String(result?.status).toLowerCase() === "success";

    return { ok, result };
  } catch (err) {
    console.error("❌ Statum call error:", err?.message || err);
    logToFile("airtime_error.log", { error: String(err?.message || err) });
    return { ok: false, result: { error: String(err?.message || err) } };
  }
}

// === Poller ===
async function pollTransaction(ref) {
  const entry = pending.get(ref);
  if (!entry || entry.processed) return;

  try {
    const resp = await axios.get(
      `https://paynecta.co.ke/api/v1/payment/status?transaction_reference=${encodeURIComponent(ref)}`,
      { headers: { "X-API-Key": API_KEY, "X-User-Email": USER_EMAIL } }
    );

    const payStatus = resp.data;
    logToFile("paynecta_status.log", { ref, payStatus });

    const rawStatus = payStatus?.data?.status || payStatus?.status;
    const normalized = normalizeStatus(rawStatus);

    entry.attempts = (entry.attempts || 0) + 1;
    entry.status = normalized;

    console.log(`Polling ${ref}: attempt=${entry.attempts} status=${normalized}`);

    if (normalized === "success") {
      entry.processed = true;
      clearInterval(entry.intervalId);

      const { ok, result } = await sendAirtime(entry.mobile, entry.amount, ref);
      logToFile("poll_airtime_result.log", { ref, ok, result });

      entry.airtime = ok ? "success" : "failed";
      pending.set(ref, entry);

      setTimeout(() => pending.delete(ref), CLEANUP_TIMEOUT);
      return;
    }

    if (["failed", "cancelled"].includes(normalized)) {
      clearInterval(entry.intervalId);
      pending.delete(ref);
      logToFile("paynecta_failure.log", { ref, status: normalized });
      return;
    }

    if (entry.attempts >= MAX_POLL_ATTEMPTS) {
      clearInterval(entry.intervalId);
      pending.delete(ref);
      logToFile("paynecta_timeout.log", { ref, attempts: entry.attempts });
    }
  } catch (err) {
    console.error("❌ Poll error for", ref, err?.response?.data || err?.message || err);
    logToFile("poll_error.log", { ref, error: err?.response?.data || err?.message || String(err) });
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts >= MAX_POLL_ATTEMPTS) {
      clearInterval(entry.intervalId);
      pending.delete(ref);
    }
  }
}

// === /purchase ===
app.post("/purchase", async (req, res) => {
  let { phone_number, amount } = req.body;
  if (!phone_number || !amount) {
    return res.status(400).json({ success: false, message: "phone_number and amount required" });
  }

  if (phone_number.startsWith("07")) {
    phone_number = "254" + phone_number.slice(1);
  }

  try {
    const init = await axios.post(
      "https://paynecta.co.ke/api/v1/payment/initialize",
      { code: PAYMENT_LINK_CODE, mobile_number: phone_number, amount },
      { headers: { "X-API-Key": API_KEY, "X-User-Email": USER_EMAIL, "Content-Type": "application/json" } }
    );

    logToFile("paynecta_init.log", { request: { phone_number, amount }, response: init.data });

    const transaction_reference =
      init?.data?.data?.transaction_reference ||
      init?.data?.data?.CheckoutRequestID ||
      init?.data?.data?.reference ||
      init?.data?.data?.id;

    if (!transaction_reference) {
      return res.json({ success: true, message: "STK push initiated (no reference returned)", data: init.data });
    }

    if (!pending.has(transaction_reference)) {
      const entry = {
        mobile: phone_number,
        amount,
        attempts: 0,
        status: "pending",
        airtime: "pending",
        processed: false,
        intervalId: null,
        startedAt: Date.now()
      };
      const intervalId = setInterval(() => pollTransaction(transaction_reference), POLL_INTERVAL_MS);
      entry.intervalId = intervalId;
      pending.set(transaction_reference, entry);

      logToFile("pending_added.log", { transaction_reference, entry });
    }

    return res.json({ success: true, message: "STK push initiated", data: init.data?.data || init.data });
  } catch (err) {
    const errorData = err?.response?.data || err?.message || err;
    console.error("❌ PayNecta init error:", errorData);
    logToFile("paynecta_init_error.log", { error: errorData });

    return res.json({
      success: true,
      message: "STK push may have been initiated — check your phone",
      error: errorData
    });
  }
});

// === PayNecta callback ===
app.post("/paynecta/callback", async (req, res) => {
  const callbackData = req.body;
  console.log("📩 PayNecta callback:", JSON.stringify(callbackData, null, 2));
  logToFile("paynecta_callback.log", callbackData);

  const ref =
    callbackData?.data?.transaction_reference ||
    callbackData?.transaction_reference ||
    callbackData?.data?.CheckoutRequestID ||
    callbackData?.data?.reference ||
    callbackData?.reference;

  const statusRaw = callbackData?.data?.status || callbackData?.status;
  const mobile = callbackData?.data?.mobile_number || callbackData?.mobile_number || callbackData?.data?.msisdn;
  const amount = callbackData?.data?.amount || callbackData?.amount;

  const normalized = normalizeStatus(statusRaw);

  if (ref && pending.has(ref)) {
    const entry = pending.get(ref);
    entry.status = normalized;

    if (normalized === "success" && !entry.processed) {
      entry.processed = true;
      clearInterval(entry.intervalId);

      const { ok, result } = await sendAirtime(entry.mobile || mobile, entry.amount || amount, ref);
      logToFile("callback_airtime_result.log", { ref, ok, result });

      entry.airtime = ok ? "success" : "failed";
      pending.set(ref, entry);

      setTimeout(() => pending.delete(ref), CLEANUP_TIMEOUT);
    } else if (["failed", "cancelled"].includes(normalized)) {
      clearInterval(entry.intervalId);
      pending.delete(ref);
      logToFile("callback_failure.log", { ref, status: normalized });
    }
  }

  res.json({ success: true });
});

// === /api/status/:reference ===
app.get("/api/status/:reference", async (req, res) => {
  const { reference } = req.params;
  if (pending.has(reference)) {
    const entry = pending.get(reference);
    return res.json({
      success: true,
      status: entry.status || "pending",
      airtime: entry.airtime || "pending",
      reference
    });
  }

  try {
    const response = await axios.get(
      `https://paynecta.co.ke/api/v1/payment/status?transaction_reference=${encodeURIComponent(reference)}`,
      { headers: { "X-API-Key": API_KEY, "X-User-Email": USER_EMAIL } }
    );
    const payStatus = response.data;
    logToFile("paynecta_status.log", { reference, payStatus });

    const rawStatus = payStatus?.data?.status || payStatus?.status;
    let normalized = normalizeStatus(rawStatus);

    if ((!rawStatus || normalized === "pending") &&
        (payStatus?.data?.status_code === 200 || payStatus?.status_code === 200)) {
      normalized = "success";
    }

    return res.json({ success: true, status: normalized, airtime: "unknown", reference, raw: payStatus });
  } catch (err) {
    console.error("❌ Status lookup error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ success: false, message: "Failed to check status", error: err?.response?.data || err?.message });
  }
});

// === debug & health ===
app.get("/pending", (req, res) => {
  const arr = [];
  for (const [k, v] of pending.entries()) {
    arr.push({ reference: k, mobile: v.mobile, amount: v.amount, attempts: v.attempts, status: v.status, airtime: v.airtime, startedAt: v.startedAt });
  }
  res.json({ success: true, pending: arr });
});

app.get("/logs/:type", (req, res) => {
  const filename = `logs/${req.params.type}.log`;
  if (!fs.existsSync(filename)) return res.status(404).json({ success: false, message: "log not found" });
  const lines = fs.readFileSync(filename, "utf8").trim().split("\n").slice(-50).map(l => {
    try { return JSON.parse(l); } catch { return l; }
  });
  res.json({ success: true, entries: lines });
});

app.get("/", (req, res) => res.json({ message: "✅ backend running" }));

app.listen(PORT, () => console.log(`🚀 server listening on ${PORT}`));
