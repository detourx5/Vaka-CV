
import { GoogleGenAI } from "@google/genai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error: "CV generation is not configured."
    });
  }

  try {
    const {
      fullName,
      email,
      phone,
      location,
      jobTitle,
      experience,
      education,
      skills,
      jobDescription
    } = req.body || {};

    if (
      !fullName?.trim() ||
      !jobTitle?.trim() ||
      !jobDescription?.trim()
    ) {
      return res.status(400).json({
        error: "Please provide your name, target job title and job description."
      });
    }

    if (jobDescription.length > 12000) {
      return res.status(400).json({
        error: "The job description is too long."
      });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    const prompt = `
Create a professional, ATS-friendly CV tailored to the job description.

Use only the applicant's supplied information. Never invent qualifications,
employers, dates, achievements or skills. Improve wording without changing facts.
Use clear headings and concise bullet points. Return plain text.

APPLICANT DETAILS
Name: ${fullName}
Email: ${email || ""}
Phone: ${phone || ""}
Location: ${location || ""}
Target role: ${jobTitle}

WORK EXPERIENCE:
${experience || "Not provided"}

EDUCATION:
${education || "Not provided"}

SKILLS:
${skills || "Not provided"}

JOB DESCRIPTION:
${jobDescription}
`;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    return res.status(200).json({
      cv: result.text
    });
  } catch (error) {
    console.error("CV generation failed:", error.message);

    return res.status(500).json({
      error: "CV generation failed. Please try again later."
    });
  }
}
