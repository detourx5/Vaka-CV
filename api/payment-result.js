
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
      typeof body.reference === "string" ? body.reference.trim() : "";
    const pollUrl = body.pollurl || body.pollUrl;
    const receivedHash = body.hash;

    if (!reference || !pollUrl || !receivedHash) {
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
      return res.status(400).send("Invalid payment hash");
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: record, error } = await supabase
      .from("payments")
      .select("reference, amount, status, poll_url")
      .eq("reference", reference)
      .maybeSingle();

    if (error) {
      console.error("Payment lookup failed:", error.message);
      return res.status(500).send("Could not check payment");
    }

    if (!record) {
      return res.status(404).send("Payment not found");
    }

    // Never allow a callback to change an already-final payment.
    if (record.status === "paid") {
      return res.status(200).send("Payment already verified");
    }

    if (record.status !== "pending") {
      return res.status(200).send("Payment is not pending");
    }

    if (
      !Number.isFinite(Number(body.amount)) ||
      Math.abs(Number(body.amount) - Number(record.amount)) > 0.001
    ) {
      return res.status(400).send("Payment amount mismatch");
    }

    // Use the poll URL saved during checkout rather than trusting
    // a URL supplied by the callback.
    if (!record.poll_url) {
      return res.status(400).send("Saved payment polling URL is missing");
    }

    const status = await paynow.pollTransaction(record.poll_url);

    if (
      !status.paid() ||
      !Number.isFinite(Number(status.amount)) ||
      Math.abs(Number(status.amount) - Number(record.amount)) > 0.001
    ) {
      return res.status(200).send("Payment not confirmed");
    }

    // Conditional update makes duplicate callbacks harmless.
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

    return res.status(200).send("Payment verified");
  } catch (error) {
    console.error("Payment verification error:", error.message);
    return res.status(500).send("Verification failed");
  }
}
