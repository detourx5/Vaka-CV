
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  const {
    reference,
    accessToken
  } = req.body || {};

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
      .select("reference, status, amount, cv_count, used_cvs")
      .eq("reference", reference.trim())
      .eq("access_token_hash", hashToken(accessToken))
      .maybeSingle();

    if (error) {
      console.error("Payment status lookup failed:", error.message);

      return res.status(500).json({
        error: "Could not check payment status."
      });
    }

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found or access denied."
      });
    }

    return res.status(200).json({
      reference: payment.reference,
      status: payment.status,
      amount: payment.amount,
      cvCount: payment.cv_count,
      usedCvs: payment.used_cvs
    });

  } catch (error) {
    console.error("Payment status error:", error.message);

    return res.status(500).json({
      error: "Could not check payment status."
    });
  }
}
