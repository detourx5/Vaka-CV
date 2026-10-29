
import { Paynow } from "paynow";
import { createClient } from "@supabase/supabase-js";

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

    const receivedHash = body.hash;

    if (!reference || !receivedHash) {
      console.error("Paynow callback missing reference or hash.");
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

    // Verify that the notification genuinely came from Paynow.
    if (!paynow.verifyHash(body)) {
      console.error("Paynow callback hash verification failed.");
      return res.status(400).send("Invalid payment hash");
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: record, error: lookupError } = await supabase
      .from("payments")
      .select("reference, amount, status, poll_url")
      .eq("reference", reference)
      .maybeSingle();

    if (lookupError) {
      console.error("Payment lookup failed:", lookupError.message);
      return res.status(500).send("Could not check payment");
    }

    if (!record) {
      console.error("Payment reference not found:", reference);
      return res.status(404).send("Payment not found");
    }

    if (record.status === "paid") {
      return res.status(200).send("Payment already verified");
    }

    if (record.status !== "pending") {
      return res.status(200).send("Payment is not pending");
    }

    const callbackAmount = Number(body.amount);

    if (
      !Number.isFinite(callbackAmount) ||
      Math.abs(callbackAmount - Number(record.amount)) > 0.001
    ) {
      console.error("Payment callback amount mismatch.");
      return res.status(400).send("Payment amount mismatch");
    }

    if (!record.poll_url) {
      console.error("Saved Paynow polling URL is missing.");
      return res.status(500).send("Payment polling URL is missing");
    }

    // Confirm the transaction directly with Paynow.
    const pollResult = await paynow.pollTransaction(record.poll_url);

    // The Node.js SDK exposes status as a property, not paid().
    const transactionStatus = String(
      pollResult?.status || ""
    ).trim().toLowerCase();

    const confirmedStatuses = [
      "paid",
      "awaiting delivery",
      "delivered"
    ];

    const pollAmount = Number(pollResult?.amount);

    console.log("Paynow verification result:", {
      reference,
      transactionStatus,
      amountMatches:
        Number.isFinite(pollAmount) &&
        Math.abs(pollAmount - Number(record.amount)) <= 0.001
    });

    if (!confirmedStatuses.includes(transactionStatus)) {
      return res.status(200).send("Payment not confirmed");
    }

    if (
      !Number.isFinite(pollAmount) ||
      Math.abs(pollAmount - Number(record.amount)) > 0.001
    ) {
      console.error("Polled payment amount mismatch.");
      return res.status(400).send("Payment amount mismatch");
    }

    // Only mark the record paid after verification.
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

    console.log("Payment successfully verified:", reference);

    return res.status(200).send("Payment verified");
  } catch (error) {
    console.error("Payment verification error:", error.message);
    return res.status(500).send("Verification failed");
  }
}
