
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const reference =
    typeof req.query?.reference === "string"
      ? req.query.reference.trim()
      : "";

  if (!reference || reference.length > 100) {
    return res.status(400).json({
      error: "A valid payment reference is required."
    });
  }

  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
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
      .select("reference, status, amount, cv_count")
      .eq("reference", reference)
      .maybeSingle();

    if (error) {
      console.error("Payment status lookup failed:", error.message);

      return res.status(500).json({
        error: "Could not check payment status."
      });
    }

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found."
      });
    }

    // This endpoint reports status only.
    // It does not grant CV credits or authorize CV generation.
    return res.status(200).json({
      reference: payment.reference,
      status: payment.status,
      amount: payment.amount
    });
  } catch (error) {
    console.error("Payment status error:", error.message);

    return res.status(500).json({
      error: "Could not check payment status."
    });
  }
}
