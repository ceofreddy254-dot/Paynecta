// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: "https://sunny-kringle-71cc8b.netlify.app" }));

// ===== Replace these with your real credentials =====
const API_KEY = "hmp_keozjmAk6bEwi0J2vaDB063tGwKkagHJtmnykFEh";
const USER_EMAIL = "kipkoechabel69@gmail.com";
const PAYMENT_LINK_CODE = "PNT_366813";

const STATUM_KEY = "18885957c3a6cd14410aa9bfd7c16ba5273";
const STATUM_SECRET = "sqPzmmybSXtQm7BJQIbz188vUR8P";

// ===== Polling config =====
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 40;

if (!fs.existsSync("logs")) fs.mkdirSync("logs");
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
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await resp.json();
    console.log("⬅️ Statum response:", result);
    logToFile("airtime_requests.log", { reference, request: payload, response: result });

    const ok =
      (result?.status_code && Number(result.status_code) === 200) ||
      result?.success === true;

    return { ok, result };
  } catch (err) {
    console.error("❌ Statum call error:", err?.message || err);
    logToFile("airtime_error.log", { error: String(err?.message || err) });
    return { ok: false, result: { error: String(err?.message || err) } };
  }
}

// === Poll PayNecta ===
async function pollTransaction(ref) {
  const entry = pending.get(ref);
  if (!entry) return;
  if (entry.processed) {
    clearInterval(entry.intervalId);
    pending.delete(ref);
    return;
  }

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

    if (normalized === "success") {
      entry.processed = true;
      clearInterval(entry.intervalId);

      const { ok, result } = await sendAirtime(entry.mobile, entry.amount, ref);
      logToFile("poll_airtime_result.log", { ref, ok, result });

      pending.delete(ref);
      entry.receipt = result?.transaction_id || result?.id || null;
    }

    if (["failed", "cancelled"].includes(normalized)) {
      clearInterval(entry.intervalId);
      pending.delete(ref);
    }

    if (entry.attempts >= MAX_POLL_ATTEMPTS) {
      clearInterval(entry.intervalId);
      pending.delete(ref);
    }
  } catch (err) {
    console.error("❌ Poll error:", err?.message || err);
    entry.attempts++;
    if (entry.attempts >= MAX_POLL_ATTEMPTS) {
      clearInterval(entry.intervalId);
      pending.delete(ref);
    }
  }
}

// === API: initiate purchase ===
app.post("/purchase", async (req, res) => {
  const { phone_number, amount } = req.body;
  if (!phone_number || !amount) {
    return res.status(400).json({ success: false, message: "phone_number and amount required" });
  }

  try {
    const init = await axios.post(
      "https://paynecta.co.ke/api/v1/payment/initialize",
      { code: PAYMENT_LINK_CODE, mobile_number: phone_number, amount },
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-User-Email": USER_EMAIL,
          "Content-Type": "application/json",
        },
      }
    );

    const transaction_reference =
      init?.data?.data?.transaction_reference ||
      init?.data?.data?.CheckoutRequestID ||
      init?.data?.data?.reference ||
      init?.data?.data?.id;

    // track
    if (transaction_reference && !pending.has(transaction_reference)) {
      const entry = {
        mobile: phone_number,
        amount,
        status: "pending",
        processed: false,
        attempts: 0,
        intervalId: null,
        startedAt: Date.now(),
      };
      const intervalId = setInterval(() => pollTransaction(transaction_reference), POLL_INTERVAL_MS);
      entry.intervalId = intervalId;
      pending.set(transaction_reference, entry);
    }

    return res.json({
      success: true,
      message: "STK push initiated",
      data: {
        transaction_reference,
        amount,
        phone_number,
        raw: init.data,
      },
    });
  } catch (err) {
    console.error("❌ PayNecta init error:", err?.response?.data || err?.message);
    return res.status(500).json({ success: false, message: "Failed to initiate STK push" });
  }
});

// === Status route ===
app.get("/api/status/:reference", (req, res) => {
  const { reference } = req.params;
  if (pending.has(reference)) {
    const entry = pending.get(reference);
    return res.json({
      success: true,
      status: entry.status,
      reference,
      amount: entry.amount,
      phone_number: entry.mobile,
      receipt: entry.receipt || null,
    });
  }
  return res.json({ success: false, message: "Not found" });
});

// health
app.get("/", (req, res) => res.json({ message: "✅ backend running" }));

app.listen(PORT, () => console.log(`🚀 server listening on ${PORT}`));
