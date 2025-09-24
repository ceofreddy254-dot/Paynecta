const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Only allow your frontend origin
const allowedOrigin = "https://swiftloanfinance.onrender.com";
app.use(cors({ origin: allowedOrigin }));

app.use(express.json());

// 🔑 PayNecta API credentials (hardcoded for now)
const PAYNECTA_BASE_URL = "https://paynecta.co.ke/api/v1";
const PAYNECTA_API_KEY = "hmp_keozjmAk6bEwi0J2vaDB063tGwKkagHJtmnykFEh";
const PAYNECTA_EMAIL = "kipkoechabel69@gmail.com";

// 🚀 Route: STK Push (initiate payment)
app.post("/stkpush", async (req, res) => {
  try {
    const { amount, phone, account_reference, transaction_desc, callback_url } = req.body;

    const response = await axios.post(
      `${PAYNECTA_BASE_URL}/payments/stkpush`,
      { amount, phone, account_reference, transaction_desc, callback_url },
      {
        headers: {
          "X-API-Key": PAYNECTA_API_KEY,
          "X-User-Email": PAYNECTA_EMAIL,
          "Content-Type": "application/json"
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
    res.status(500).json({
      status: "error",
      message: "Failed to initiate payment",
      details: error.response?.data || error.message
    });
  }
});

// 🚀 Route: Check payment status
app.get("/status/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const response = await axios.get(
      `${PAYNECTA_BASE_URL}/payments/status/${id}`,
      {
        headers: {
          "X-API-Key": PAYNECTA_API_KEY,
          "X-User-Email": PAYNECTA_EMAIL
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
    res.status(500).json({
      status: "error",
      message: "Failed to fetch payment status",
      details: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
