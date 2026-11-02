
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

  try {
    const {
      draftId,
      draftToken,
      reference,
      accessToken
    } = req.body || {};

    if (
      typeof draftId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(draftId) ||
      typeof draftToken !== "string" ||
      !/^[a-f0-9]{64}$/i.test(draftToken) ||
      typeof reference !== "string" ||
      !reference.trim() ||
      typeof accessToken !== "string" ||
      !/^[a-f0-9]{64}$/i.test(accessToken)
    ) {
      return res.status(400).json({
        error: "Your CV access details are invalid."
      });
    }

    if (
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      return res.status(500).json({
        error: "CV access service is not configured."
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Verify the private CV draft.
    const { data: draft, error: draftError } = await supabase
      .from("cv_drafts")
      .select("id, full_name, cv_text, status")
      .eq("id", draftId)
      .eq("draft_token_hash", hashToken(draftToken))
      .maybeSingle();

    if (draftError) {
      console.error("CV lookup failed:", draftError.message);

      return res.status(500).json({
        error: "Could not retrieve your CV."
      });
    }

    if (!draft) {
      return res.status(403).json({
        error: "CV access denied."
      });
    }

    // Verify the payment and ensure it belongs to this CV.
    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .select("reference, status, draft_id, access_token_hash")
      .eq("reference", reference.trim())
      .eq("access_token_hash", hashToken(accessToken))
      .maybeSingle();

    if (paymentError) {
      console.error("Payment lookup failed:", paymentError.message);

      return res.status(500).json({
        error: "Could not verify your payment."
      });
    }

    if (!payment || payment.draft_id !== draft.id) {
      return res.status(403).json({
        error: "This payment does not belong to this CV."
      });
    }

    if (payment.status !== "paid") {
      return res.status(402).json({
        error: "Your payment has not yet been confirmed."
      });
    }

    // Payment is confirmed. Return the complete CV.
    return res.status(200).json({
      success: true,
      fullName: draft.full_name,
      cv: draft.cv_text,
      message: "Your CV has been unlocked."
    });

  } catch (error) {
    console.error("CV retrieval failed:", error.message);

    return res.status(500).json({
      error: "Something went wrong retrieving your CV."
    });
  }
}
