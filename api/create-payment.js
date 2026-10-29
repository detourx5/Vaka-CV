
import { Paynow } from "paynow";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";

const packages = {
  single: { amount: 1.20, cvs: 1, name: "1 CV" },
  two: { amount: 2.00, cvs: 2, name: "2 CVs" },
  three: { amount: 3.00, cvs: 4, name: "4 CVs" },
  five: { amount: 5.00, cvs: 6, name: "6 CVs" }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { packageId } = req.body || {};
    const selected = packages[packageId];

    if (!selected) {
      return res.status(400).json({
        error: "Invalid CV package"
      });
    }

    const requiredEnv = [
      "PAYNOW_INTEGRATION_ID",
      "PAYNOW_INTEGRATION_KEY",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY"
    ];

    if (requiredEnv.some((key) => !process.env[key])) {
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
      `VAKA-${Date.now()}-${randomBytes(8).toString("hex")}`;

    // Generate a private token and store only its SHA-256 hash.
    const accessToken = randomBytes(32).toString("hex");

    const accessTokenHash = createHash("sha256")
      .update(accessToken)
      .digest("hex");

    const { error: insertError } = await supabase
      .from("payments")
      .insert({
        reference,
        package_id: packageId,
        amount: selected.amount,
        cv_count: selected.cvs,
        used_cvs: 0,
        access_token_hash: accessTokenHash,
        status: "pending"
      });

    if (insertError) {
      console.error("Payment record creation failed:", insertError.message);

      return res.status(500).json({
        error: "Could not create payment record."
      });
    }

    const payment = paynow.createPayment(reference);
    payment.add(selected.name, selected.amount);

    const response = await paynow.send(payment);

    if (!response.success || !response.redirectUrl || !response.pollUrl) {
      await supabase
        .from("payments")
        .update({ status: "failed" })
        .eq("reference", reference)
        .eq("status", "pending");

      console.error("Paynow initiation failed:", response.error);

      return res.status(502).json({
        error: "Could not start payment. Please try again."
      });
    }

    const { error: updateError } = await supabase
      .from("payments")
      .update({ poll_url: response.pollUrl })
      .eq("reference", reference)
      .eq("status", "pending");

    if (updateError) {
      console.error("Saving Paynow details failed:", updateError.message);

      return res.status(500).json({
        error: "Could not save payment details. Please contact support before retrying."
      });
    }

    return res.status(200).json({
      checkoutUrl: response.redirectUrl,
      reference,
      amount: selected.amount,
      cvs: selected.cvs,
      accessToken
    });
  } catch (error) {
    console.error("Payment setup failed:", error.message);

    return res.status(500).json({
      error: "Something went wrong starting your payment."
    });
  }
}
