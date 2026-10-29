
import { Paynow } from "paynow";
import { createClient } from "@supabase/supabase-js";

const packages = {
  single: { amount: 1.20, cvs: 1, name: "1 CV" },
  three: { amount: 3.00, cvs: 4, name: "4 CVs" },
  five: { amount: 5.00, cvs: 6, name: "6 CVs" }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { packageId } = req.body || {};
    const selected = packages[packageId];

    if (!selected) {
      return res.status(400).json({ error: "Invalid CV package" });
    }

    if (
      !process.env.PAYNOW_INTEGRATION_ID ||
      !process.env.PAYNOW_INTEGRATION_KEY ||
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      console.error("Required payment environment variables are missing.");
      return res.status(500).json({
        error: "Payment service is not configured."
      });
    }

    const paynow = new Paynow(
      process.env.PAYNOW_INTEGRATION_ID,
      process.env.PAYNOW_INTEGRATION_KEY
    );

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const baseUrl = "https://vaka-cv.vercel.app";

    paynow.returnUrl = `${baseUrl}/?payment=return`;
    paynow.resultUrl = `${baseUrl}/api/payment-result`;

    const reference =
      `VAKA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { error: insertError } = await supabase
      .from("payments")
      .insert({
        reference,
        package_id: packageId,
        amount: selected.amount,
        cv_count: selected.cvs,
        status: "pending"
      });

    if (insertError) {
      console.error("Supabase insert failed:", insertError.message);
      return res.status(500).json({
        error: "Could not create payment record."
      });
    }

    const payment = paynow.createPayment(reference);
    payment.add(selected.name, selected.amount);

    const response = await paynow.send(payment);

    if (
      !response.success ||
      !response.redirectUrl ||
      !response.pollUrl
    ) {
      await supabase
        .from("payments")
        .update({ status: "failed" })
        .eq("reference", reference);

      console.error("Paynow initiation failed:", response.error);

      return res.status(502).json({
        error: "Could not start payment. Please try again."
      });
    }

    const { error: updateError } = await supabase
      .from("payments")
      .update({ poll_url: response.pollUrl })
      .eq("reference", reference);

    if (updateError) {
      console.error(
        "Could not save Paynow poll URL:",
        updateError.message
      );

      return res.status(500).json({
        error: "Could not save payment details. Please contact support before retrying."
      });
    }

    return res.status(200).json({
      checkoutUrl: response.redirectUrl,
      reference,
      amount: selected.amount,
      cvs: selected.cvs
    });
  } catch (error) {
    console.error("Payment setup error:", error.message);

    return res.status(500).json({
      error: "Something went wrong starting your payment."
    });
  }
}
