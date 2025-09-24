import express from "express";
import cors from "cors";
import axios from "axios";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin: "https://leafy-manatee-53abab.netlify.app" // 🔧 change to your frontend domain
}));

// ===== PayNecta Credentials (⚠️ remove later for security) =====
const API_KEY = "hmp_keozjmAk6bEwi0J2vaDB063tGwKkagHJtmnykFEh";
const USER_EMAIL = "kipkoechabel69@gmail.com";
const PAYMENT_LINK_CODE = "PNT_366813";

// ===== Statum Credentials (⚠️ remove later for security) =====
const STATUM_KEY = "18885957c3a6cd14410aa9bfd7c16ba5273";
const STATUM_SECRET = "sqPzmmybSXtQm7BJQIbz188vUR8P";

// === Utility: Generate Auth Header for Statum ===
function getAuthHeader() {
  const authString = `${STATUM_KEY}:${STATUM_SECRET}`;
  const encoded = Buffer.from(authString).toString("base64");
  return `Basic ${encoded}`;
}

// === Utility: Logging ===
function logToFile(filename, data) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    ...data,
  };
  fs.appendFileSync(filename, JSON.stringify(logEntry) + "\n", "utf8");
}

// =====================================
// Step 1: Initiate STK Push (PayNecta)
// =====================================
app.post("/purchase", async (req, res) => {
  const { phone_number, amount } = req.body;

  if (!phone_number || !amount) {
    return res.status(400).json({ success: false, message: "Phone number and amount are required" });
  }

  try {
    const response = await axios.post(
      "https://paynecta.co.ke/api/v1/payment/initialize",
      {
        code: PAYMENT_LINK_CODE,
        mobile_number: phone_number,
        amount
      },
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-User-Email": USER_EMAIL,
          "Content-Type": "application/json"
        }
      }
    );

    const payData = response.data;
    logToFile("paynecta_init.log", payData);

    // Respond to frontend
    res.json({
      success: true,
      message: "STK push initiated. Await confirmation.",
      data: payData.data
    });

  } catch (error) {
    console.error("PayNecta Init Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: "Failed to initiate STK push" });
  }
});

// =====================================
// Step 2: PayNecta Callback Handler
// =====================================
app.post("/paynecta/callback", async (req, res) => {
  const callbackData = req.body;
  console.log("📩 PayNecta Callback:", callbackData);
  logToFile("paynecta_callback.log", callbackData);

  const { status, mobile_number, amount } = callbackData.data || {};

  if (status === "success") {
    try {
      // Step 3: Send Airtime via Statum
      const payload = { phone_number: mobile_number, amount: String(amount) };

      const response = await fetch("https://api.statum.co.ke/api/v2/airtime", {
        method: "POST",
        headers: {
          "Authorization": getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      console.log("📤 Airtime Topup Response:", result);
      logToFile("airtime_requests.log", { request: payload, response: result });

    } catch (err) {
      console.error("❌ Airtime Error:", err);
      logToFile("airtime_error.log", { error: err.message });
    }
  } else {
    console.log(`❌ Payment ${status}. No airtime sent.`);
  }

  res.json({ success: true });
});

// =====================================
// Step 3: Check Payment Status (for frontend polling)
// =====================================
app.get("/api/status/:reference", async (req, res) => {
  const { reference } = req.params;

  if (!reference) {
    return res.status(400).json({ success: false, message: "Transaction reference is required" });
  }

  try {
    const response = await axios.get(
      `https://paynecta.co.ke/api/v1/payment/status?transaction_reference=${reference}`,
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-User-Email": USER_EMAIL,
        },
      }
    );

    const payStatus = response.data;
    logToFile("paynecta_status.log", payStatus);

    // normalize status
    let normalized = "pending";
    const rawStatus =
      payStatus?.data?.status?.toLowerCase?.() ||
      payStatus?.status?.toLowerCase?.();

    if (["success", "successful", "paid"].includes(rawStatus)) {
      normalized = "success";
    } else if (["failed", "fail", "cancelled", "declined"].includes(rawStatus)) {
      normalized = "failed";
    }

    res.json({
      success: true,
      status: normalized,
      reference,
      raw: payStatus
    });

  } catch (error) {
    console.error("Status error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Error checking status",
      error: error.response?.data || error.message
    });
  }
});

// =====================================
// Health check
// =====================================
app.get("/", (req, res) => {
  res.json({ message: "✅ Airtime purchase server running" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
