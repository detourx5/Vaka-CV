
import { Paynow } from "paynow";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

const acceptedStatuses = [
  "paid",
  "awaiting delivery",
  "delivered"
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  const { reference, accessToken } = req.body || {};

  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    reference.length > 100 ||
    typeof accessToken !== "string" ||
    !/^[a-f0-9]{64}$/i.test(accessToken)
  ) {
    return res.status(400).json({
      error: "Valid payment access details are required."
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
      error: "Payment status is not configured."
    });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: payment, error } = await supabase
      .from("payments")
      .select(
        "reference, status, amount, cv_count, used_cvs, poll_url, draft_id"
      )
      .eq("reference", reference.trim())
      .eq("access_token_hash", hashToken(accessToken))
      .maybeSingle();

    if (error) {
      console.error("Payment lookup failed:", error.message);

      return res.status(500).json({
        error: "Could not check payment status."
      });
    }

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found or access denied."
      });
    }

    // If Paynow has already confirmed payment, ensure the CV is unlocked.
    if (payment.status === "paid") {
      if (payment.draft_id) {
        const { error: unlockError } = await supabase
          .from("cv_drafts")
          .update({ status: "unlocked" })
          .eq("id", payment.draft_id);

        if (unlockError) {
          console.error("CV unlock recovery failed:", unlockError.message);

          return res.status(500).json({
            error: "Payment is confirmed but the CV could not be unlocked."
          });
        }
      }

      return res.status(200).json({
        reference: payment.reference,
        status: "paid",
        amount: payment.amount,
        cvCount: payment.cv_count,
        usedCvs: payment.used_cvs
      });
    }

    // Only pending payments should be checked with Paynow.
    if (payment.status !== "pending") {
      return res.status(200).json({
        reference: payment.reference,
        status: payment.status,
        amount: payment.amount,
        cvCount: payment.cv_count,
        usedCvs: payment.used_cvs
      });
    }

    if (!payment.poll_url) {
      return res.status(200).json({
        reference: payment.reference,
        status: "pending",
        amount: payment.amount,
        cvCount: payment.cv_count,
        usedCvs: payment.used_cvs
      });
    }

    // Ask Paynow directly for the latest payment result.
    const paynow = new Paynow(
      process.env.PAYNOW_INTEGRATION_ID,
      process.env.PAYNOW_INTEGRATION_KEY
    );

    const result = await paynow.pollTransaction(payment.poll_url);

    const verifiedStatus = String(result?.status || "").toLowerCase();

    console.log(
      "Paynow payment check:",
      payment.reference,
      verifiedStatus
    );

    // Do not unlock anything unless Paynow confirms payment.
    if (!acceptedStatuses.includes(verifiedStatus)) {
      return res.status(200).json({
        reference: payment.reference,
        status: verifiedStatus || "pending",
        amount: payment.amount,
        cvCount: payment.cv_count,
        usedCvs: payment.used_cvs
      });
    }

    // Check the returned reference and amount when Paynow supplies them.
    if (
      result.reference &&
      String(result.reference).trim() !== payment.reference
    ) {
      console.error("Paynow reference mismatch.");

      return res.status(400).json({
        error: "Payment reference could not be verified."
      });
    }

    if (
      result.amount !== undefined &&
      result.amount !== null &&
      Math.abs(Number(result.amount) - Number(payment.amount)) > 0.001
    ) {
      console.error("Paynow payment amount mismatch.");

      return res.status(400).json({
        error: "Payment amount could not be verified."
      });
    }

    // Mark the payment as paid only after Paynow confirms it.
    const { data: updatedPayment, error: updateError } = await supabase
      .from("payments")
      .update({
        status: "paid",
        paid_at: new Date().toISOString()
      })
      .eq("reference", payment.reference)
      .eq("status", "pending")
      .select("reference");

    if (updateError) {
      console.error("Payment update failed:", updateError.message);

      return res.status(500).json({
        error: "Could not update payment."
      });
    }

    // Another request may have updated the payment at the same time.
    if (!updatedPayment || updatedPayment.length === 0) {
      const { data: latestPayment, error: latestError } = await supabase
        .from("payments")
        .select("status")
        .eq("reference", payment.reference)
        .maybeSingle();

      if (latestError || latestPayment?.status !== "paid") {
        return res.status(200).json({
          reference: payment.reference,
          status: "pending",
          amount: payment.amount,
          cvCount: payment.cv_count,
          usedCvs: payment.used_cvs
        });
      }
    }

    // Unlock only the CV attached to this verified payment.
    if (payment.draft_id) {
      const { error: unlockError } = await supabase
        .from("cv_drafts")
        .update({ status: "unlocked" })
        .eq("id", payment.draft_id);

      if (unlockError) {
        console.error("CV unlock failed:", unlockError.message);

        return res.status(500).json({
          error: "Payment is confirmed but the CV could not be unlocked."
        });
      }
    }

    console.log("Payment verified and CV unlocked:", payment.reference);

    return res.status(200).json({
      reference: payment.reference,
      status: "paid",
      amount: payment.amount,
      cvCount: payment.cv_count,
      usedCvs: payment.used_cvs
    });

  } catch (error) {
    console.error("Payment status check failed:", error.message);

    return res.status(502).json({
      error: "Could not verify payment with Paynow. Please try again."
    });
  }
}
