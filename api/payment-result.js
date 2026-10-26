
import { Paynow } from "paynow";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const body = req.body || {};
    const reference = body.reference;
    const pollUrl = body.pollurl || body.pollUrl;
    const receivedHash = body.hash;

    if (!reference || !pollUrl || !receivedHash) {
      return res.status(400).send("Missing payment details");
    }

    const paynow = new Paynow(
      process.env.PAYNOW_INTEGRATION_ID,
      process.env.PAYNOW_INTEGRATION_KEY
    );

    // Verify that the notification was signed using your Paynow key.
    if (!paynow.verifyHash(body)) {
      return res.status(400).send("Invalid payment hash");
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: record, error } = await supabase
      .from("payments")
      .select("*")
      .eq("reference", reference)
      .single();

    if (error || !record) {
      return res.status(404).send("Payment not found");
    }

    // Do not accept a notification with a different amount.
    if (Number(body.amount) !== Number(record.amount)) {
      return res.status(400).send("Payment amount mismatch");
    }

    // Ask Paynow directly for the current transaction status.
    const status = await paynow.pollTransaction(record.poll_url || pollUrl);

    if (
      status.paid() &&
      Number(status.amount) === Number(record.amount)
    ) {
      const { error: updateError } = await supabase
        .from("payments")
        .update({
          status: "paid",
          paid_at: new Date().toISOString()
        })
        .eq("reference", reference)
        .eq("status", "pending");

      if (updateError) {
        console.error("Database update failed:", updateError.message);
        return res.status(500).send("Could not update payment");
      }

      return res.status(200).send("Payment verified");
    }

    return res.status(200).send("Payment not confirmed");
  } catch (error) {
    console.error("Payment verification error:", error.message);
    return res.status(500).send("Verification failed");
  }
}
