
import { Paynow } from "paynow";

const PACKAGES = {
  single: { amount: 1.50, cvs: 1, name: "1 CV" },
  three: { amount: 3.50, cvs: 3, name: "3 CVs" },
  five: { amount: 5.00, cvs: 5, name: "5 CVs" }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const integrationId = process.env.PAYNOW_INTEGRATION_ID;
    const integrationKey = process.env.PAYNOW_INTEGRATION_KEY;

    if (!integrationId || !integrationKey) {
      return res.status(500).json({
        error: "Payment settings are missing"
      });
    }

    const { packageId } = req.body || {};
    const selected = PACKAGES[packageId];

    if (!selected) {
      return res.status(400).json({
        error: "Please select a valid CV package"
      });
    }

    const paynow = new Paynow(integrationId, integrationKey);
    const baseUrl = "https://vaka-cv.vercel.app";

    paynow.returnUrl = `${baseUrl}/?payment=return`;
    paynow.resultUrl = `${baseUrl}/api/payment-result`;

    const reference =
      `VAKA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const payment = paynow.createPayment(reference);
    payment.add(selected.name, selected.amount);

    const response = await paynow.send(payment);

    if (!response.success || !response.redirectUrl) {
      console.error("Paynow initiation failed:", response.error);
      return res.status(502).json({
        error: "Unable to start payment. Please try again."
      });
    }

    return res.status(200).json({
      checkoutUrl: response.redirectUrl,
      reference,
      amount: selected.amount,
      cvs: selected.cvs
    });
  } catch (error) {
    console.error("Payment error:", error.message);
    return res.status(500).json({
      error: "Something went wrong starting your payment."
    });
  }
}
