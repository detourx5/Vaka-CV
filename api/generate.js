
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";

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

  try {
    const {
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

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

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
- Return the CV only, without commentary before or after it.
`;

    let response;

    try {
      response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt
      });
    } catch (generationError) {
      console.error(
        "Gemini generation failed:",
        generationError.message
      );

      return res.status(502).json({
        error: "CV generation failed. Please try again."
      });
    }

    const cv = response?.text?.trim();

    if (!cv) {
      return res.status(502).json({
        error: "No CV was returned. Please try again."
      });
    }

    // Create a private access token for this CV.
    const draftToken = randomBytes(32).toString("hex");

    const draftTokenHash = hashToken(draftToken);

    // Store the complete CV privately in Supabase.
    const { data: draft, error: insertError } = await supabase
      .from("cv_drafts")
      .insert({
        draft_token_hash: draftTokenHash,
        full_name: fullName.trim(),
        cv_text: cv,
        status: "locked"
      })
      .select("id")
      .single();

    if (insertError) {
      console.error(
        "CV draft storage failed:",
        insertError.message
      );

      return res.status(500).json({
        error: "Could not securely save your CV. Please try again."
      });
    }

    // Do not return the complete CV before payment.
    return res.status(200).json({
      success: true,
      draftId: draft.id,
      draftToken,
      status: "locked",
      message: "Your CV has been generated successfully."
    });

  } catch (error) {
    console.error(
      "CV generation endpoint failed:",
      error.message
    );

    return res.status(500).json({
      error: "Something went wrong generating your CV."
    });
  }
}
