const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your frontend origin only
app.use(cors({
  origin: "https://stupendous-salamander-117b97.netlify.app"
}));
app.use(express.json());

// Hardcoded credentials (⚠️ remove later for security)
const API_KEY = "hmp_keozjmAk6bEwi0J2vaDB063tGwKkagHJtmnykFEh";
const USER_EMAIL = "kipkoechabel69@gmail.com";
const PAYMENT_LINK_CODE = "PNT_366813"; // 👈 from your dashboard

// Health check
app.get("/", (req, res) => {
  res.json({ message: "PayNecta API proxy server is running" });
});

// Initialize Payment (STK Push)
app.post("/api/pay", async (req, res) => {
  const { mobile_number, amount } = req.body;

  if (!mobile_number || !amount) {
    return res.status(400).json({
      success: false,
      message: "Mobile number and amount are required"
    });
  }

  try {
    const response = await axios.post(
      "https://paynecta.co.ke/api/v1/payment/initialize",
      {
        code: PAYMENT_LINK_CODE,
        mobile_number,
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

    res.json(response.data);
  } catch (error) {
    console.error("Payment error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json(
      error.response?.data || { success: false, message: "Server error" }
    );
  }
});

// Check Payment Status
app.get("/api/status/:reference", async (req, res) => {
  const { reference } = req.params;

  if (!reference) {
    return res.status(400).json({
      success: false,
      message: "Transaction reference is required"
    });
  }

  try {
    const response = await axios.get(
      `https://paynecta.co.ke/api/v1/payment/status?transaction_reference=${reference}`,
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-User-Email": USER_EMAIL
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Status error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json(
      error.response?.data || { success: false, message: "Server error" }
    );
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
