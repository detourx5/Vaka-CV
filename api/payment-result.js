
import { Paynow } from "paynow";
import { createClient } from "@supabase/supabase-js";

const acceptedStatuses = [
  "paid",
  "awaiting delivery",
  "delivered"
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  try {
    const body = req.body || {};

    const reference =
      typeof body.reference === "string"
        ? body.reference.trim()
        : "";

    const receivedAmount = Number(body.amount);
    const callbackStatus = String(body.status || "").toLowerCase();

    if (!reference || !body.hash || !body.pollurl) {
      return res.status(400).send("Missing payment details");
    }

    const requiredEnv = [
      "PAYNOW_INTEGRATION_ID",
      "PAYNOW_INTEGRATION_KEY",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY"
    ];

    if (requiredEnv.some((key) => !process.env[key])) {
      console.error("Payment verification environment is incomplete.");
      return res.status(500).send("Payment verification is not configured");
    }

    const paynow = new Paynow(
      process.env.PAYNOW_INTEGRATION_ID,
      process.env.PAYNOW_INTEGRATION_KEY
    );

    if (!paynow.verifyHash(body)) {
      console.error("Paynow callback hash verification failed.");
      return res.status(400).send("Invalid payment hash");
    }

    if (!acceptedStatuses.includes(callbackStatus)) {
      return res.status(200).send("Payment not confirmed");
    }

    if (!Number.isFinite(receivedAmount)) {
      return res.status(400).send("Invalid payment amount");
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: record, error: lookupError } = await supabase
      .from("payments")
      .select("reference, amount, status, poll_url, draft_id")
      .eq("reference", reference)
      .maybeSingle();

    if (lookupError) {
      console.error("Payment lookup failed:", lookupError.message);
      return res.status(500).send("Could not check payment");
    }

    if (!record) {
      return res.status(404).send("Payment not found");
    }

    if (record.status === "paid") {
      // Ensure a previously confirmed payment has an unlocked draft.
      if (record.draft_id) {
        const { error: unlockError } = await supabase
          .from("cv_drafts")
          .update({ status: "unlocked" })
          .eq("id", record.draft_id);

        if (unlockError) {
          console.error("CV unlock recovery failed:", unlockError.message);
          return res.status(500).send("Could not unlock CV");
        }
      }

      return res.status(200).send("Payment already verified");
    }

    if (record.status !== "pending") {
      return res.status(200).send("Payment is not pending");
    }

    if (Math.abs(receivedAmount - Number(record.amount)) > 0.001) {
      console.error("Payment amount mismatch.");
      return res.status(400).send("Payment amount mismatch");
    }

    if (!record.poll_url) {
      console.error("Saved polling URL is missing.");
      return res.status(500).send("Payment polling URL is missing");
    }

    // Independently confirm payment with Paynow.
    const polledPayment = await paynow.pollTransaction(record.poll_url);

    const verifiedStatus = String(
      polledPayment?.status || ""
    ).toLowerCase();

    console.log("Paynow verification status:", verifiedStatus);

    if (!acceptedStatuses.includes(verifiedStatus)) {
      return res.status(200).send("Payment not confirmed by Paynow");
    }

    // Mark the payment as paid only if it is still pending.
    const { data: updated, error: updateError } = await supabase
      .from("payments")
      .update({
        status: "paid",
        paid_at: new Date().toISOString()
      })
      .eq("reference", reference)
      .eq("status", "pending")
      .select("reference");

    if (updateError) {
      console.error("Payment update failed:", updateError.message);
      return res.status(500).send("Could not update payment");
    }

    if (!updated || updated.length === 0) {
      return res.status(200).send("Payment already processed");
    }

    // Unlock the CV associated with the verified payment.
    if (record.draft_id) {
      const { error: unlockError } = await supabase
        .from("cv_drafts")
        .update({ status: "unlocked" })
        .eq("id", record.draft_id);

      if (unlockError) {
        console.error("CV unlock failed:", unlockError.message);
        return res.status(500).send("Payment verified but CV unlock failed");
      }
    }

    console.log("Payment successfully verified:", reference);

    return res.status(200).send("Payment verified and CV unlocked");

  } catch (error) {
    console.error("Payment verification error:", error.message);
    return res.status(500).send("Verification failed");
  }
}
