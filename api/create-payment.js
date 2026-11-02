
import { Paynow } from "paynow";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

const packages = {
  single: { amount: 1.20, cvs: 1, name: "1 CV" },
  two: { amount: 2.00, cvs: 2, name: "2 CVs" },
  three: { amount: 3.00, cvs: 4, name: "4 CVs" },
  five: { amount: 5.00, cvs: 6, name: "6 CVs" }
};

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { packageId, draftId, draftToken } = req.body || {};

    const selected = packages[packageId];

    if (!selected) {
      return res.status(400).json({
        error: "Invalid CV package."
      });
    }

    if (
      typeof draftId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(draftId) ||
      typeof draftToken !== "string" ||
      !/^[a-f0-9]{64}$/i.test(draftToken)
    ) {
      return res.status(400).json({
        error: "Your CV session is invalid. Please generate your CV again."
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

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Confirm ownership of the generated CV draft.
    const { data: draft, error: draftError } = await supabase
      .from("cv_drafts")
      .select("id, status")
      .eq("id", draftId)
      .eq("draft_token_hash", hashToken(draftToken))
      .maybeSingle();

    if (draftError) {
      console.error("CV draft lookup failed:", draftError.message);

      return res.status(500).json({
        error: "Could not verify your CV."
      });
    }

    if (!draft || draft.status !== "locked") {
      return res.status(404).json({
        error: "CV draft not found or already unlocked."
      });
    }

    const paynow = new Paynow(
      process.env.PAYNOW_INTEGRATION_ID,
      process.env.PAYNOW_INTEGRATION_KEY
    );

    const baseUrl = "https://vaka-cv.vercel.app";

    paynow.returnUrl = `${baseUrl}/?payment=return`;
    paynow.resultUrl = `${baseUrl}/api/payment-result`;

    const reference =
      `VAKA-${Date.now()}-${randomBytes(8).toString("hex")}`;

    const accessToken = randomBytes(32).toString("hex");

    const accessTokenHash = hashToken(accessToken);

    // Create the payment and link it to this CV draft.
    const { error: insertError } = await supabase
      .from("payments")
      .insert({
        reference,
        package_id: packageId,
        amount: selected.amount,
        cv_count: selected.cvs,
        used_cvs: 0,
        access_token_hash: accessTokenHash,
        draft_id: draftId,
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
        error: "Could not save payment details."
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
