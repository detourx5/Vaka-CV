
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validText(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  let supabase;
  let paymentReference;
  let creditReserved = false;

  try {
    const {
      accessToken,
      fullName,
      email = "",
      phone = "",
      location = "",
      jobTitle,
      experience = "",
      education = "",
      skills = "",
      jobDescription
    } = req.body || {};

    if (
      typeof accessToken !== "string" ||
      !/^[a-f0-9]{64}$/i.test(accessToken)
    ) {
      return res.status(401).json({
        error: "Payment access is missing. Please complete checkout first."
      });
    }

    if (
      !validText(fullName, 150) ||
      !fullName.trim() ||
      !validText(email, 200) ||
      !validText(phone, 60) ||
      !validText(location, 200) ||
      !validText(jobTitle, 200) ||
      !jobTitle.trim() ||
      !validText(experience, 10000) ||
      !validText(education, 6000) ||
      !validText(skills, 4000) ||
      !validText(jobDescription, 10000) ||
      !jobDescription.trim()
    ) {
      return res.status(400).json({
        error: "Please complete the required fields and check their length."
      });
    }

    const requiredEnv = [
      "GEMINI_API_KEY",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY"
    ];

    if (requiredEnv.some((key) => !process.env[key])) {
      return res.status(500).json({
        error: "The CV generation service is not configured."
      });
    }

    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Match the private browser token to its payment record.
    const tokenHash = hashToken(accessToken);

    const { data: payment, error: lookupError } = await supabase
      .from("payments")
      .select("reference, status, cv_count, used_cvs")
      .eq("access_token_hash", tokenHash)
      .maybeSingle();

    if (lookupError) {
      console.error("Payment lookup failed:", lookupError.message);
      return res.status(500).json({
        error: "Could not verify your payment. Please try again."
      });
    }

    if (!payment || payment.status !== "paid") {
      return res.status(402).json({
        error: "Payment has not been confirmed. Please check your payment status."
      });
    }

    if (payment.used_cvs >= payment.cv_count) {
      return res.status(403).json({
        error: "You have used all your CV credits. Please purchase another package."
      });
    }

    paymentReference = payment.reference;

    // Reserve one credit atomically to prevent exceeding the package limit.
    const { data: reservation, error: reservationError } =
      await supabase.rpc("use_cv_credit", {
        p_reference: paymentReference
      });

    if (reservationError) {
      console.error("Credit reservation failed:", reservationError.message);
      return res.status(500).json({
        error: "Could not reserve a CV credit. Please try again."
      });
    }

    if (!reservation || reservation.length === 0) {
      return res.status(403).json({
        error: "No unused CV credits remain. Please purchase another package."
      });
    }

    creditReserved = true;

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    const prompt = `
You are a professional CV writer and recruitment specialist.

Create a professional, ATS-friendly CV tailored to the job description.

Candidate information:
Full name: ${fullName.trim()}
Email: ${email}
Phone: ${phone}
Location: ${location}
Target job title: ${jobTitle.trim()}

Work experience:
${experience || "Not provided"}

Education:
${education || "Not provided"}

Skills:
${skills || "Not provided"}

Job description:
${jobDescription.trim()}

Instructions:
- Use clear professional English.
- Tailor the CV to the job description.
- Use relevant keywords naturally for applicant tracking systems.
- Present the professional summary, skills, work experience and education clearly.
- Use bullet points for responsibilities and achievements.
- Improve wording without inventing qualifications, employers, dates or achievements.
- Do not invent missing contact details or personal information.
- If information is missing, do not fabricate it.
- Make the CV easy to copy into a document.
- Return the CV only, without commentary before or after it.
`;

    let response;

    try {
      response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt
      });
    } catch (generationError) {
      // Refund the reserved credit if Gemini fails.
      const { error: refundError } = await supabase.rpc(
        "refund_cv_credit",
        { p_reference: paymentReference }
      );

      if (refundError) {
        console.error("Credit refund failed:", refundError.message);
      } else {
        creditReserved = false;
      }

      console.error("Gemini generation failed:", generationError.message);

      return res.status(502).json({
        error: "CV generation failed. If your credit was not restored, contact support before paying again."
      });
    }

    const cv = response?.text?.trim();

    if (!cv) {
      const { error: refundError } = await supabase.rpc(
        "refund_cv_credit",
        { p_reference: paymentReference }
      );

      if (refundError) {
        console.error("Credit refund failed:", refundError.message);
      } else {
        creditReserved = false;
      }

      return res.status(502).json({
        error: "No CV was returned. Please try again."
      });
    }

    return res.status(200).json({
      cv,
      message: "CV generated successfully."
    });
  } catch (error) {
    console.error("CV generation endpoint failed:", error.message);

    // Attempt to restore the reserved credit after an unexpected error.
    if (supabase && paymentReference && creditReserved) {
      const { error: refundError } = await supabase.rpc(
        "refund_cv_credit",
        { p_reference: paymentReference }
      );

      if (refundError) {
        console.error("Credit refund failed:", refundError.message);
      }
    }

    return res.status(500).json({
      error: "Something went wrong generating your CV."
    });
  }
}
