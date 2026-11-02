
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validText(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTemporaryError(error) {
  const status = Number(
    error?.status ||
    error?.statusCode ||
    error?.code
  );

  const message = String(error?.message || "").toLowerCase();

  return (
    [408, 429, 500, 502, 503, 504].includes(status) ||
    message.includes("high demand") ||
    message.includes("unavailable") ||
    message.includes("temporarily") ||
    message.includes("overloaded") ||
    message.includes("rate limit")
  );
}

async function generateWithFallback(ai, prompt) {
  const models = [
    "gemini-3.8-flash",
    "gemini-3.6-flash"
  ];

  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Trying ${model}, attempt ${attempt}`);

        const response = await ai.models.generateContent({
          model,
          contents: prompt
        });

        const cv = response?.text?.trim();

        if (!cv) {
          throw new Error("Gemini returned an empty CV.");
        }

        console.log(`CV successfully generated using ${model}`);

        return cv;

      } catch (error) {
        lastError = error;

        console.error(
          `Gemini error on ${model}, attempt ${attempt}:`,
          error?.status || error?.statusCode || error?.code || "",
          error?.message || "Unknown error"
        );

        if (!isTemporaryError(error)) {
          throw error;
        }

        if (attempt < 2) {
          await sleep(1500);
        }
      }
    }
  }

  throw lastError || new Error("All Gemini models failed.");
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

    if (requiredEnv.some(key => !process.env[key])) {
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

    let cv;

    try {
      cv = await generateWithFallback(ai, prompt);

    } catch (generationError) {
      console.error(
        "All Gemini generation attempts failed:",
        generationError?.message || generationError
      );

      return res.status(503).json({
        error: isTemporaryError(generationError)
          ? "Our AI service is temporarily busy. Please wait a moment and try again."
          : "We could not generate your CV. Please check your details and try again."
      });
    }

    const draftToken = randomBytes(32).toString("hex");
    const draftTokenHash = hashToken(draftToken);

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
      error?.message || error
    );

    return res.status(500).json({
      error: "Something went wrong generating your CV."
    });
  }
}
