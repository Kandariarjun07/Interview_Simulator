import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server as IOServer, Socket } from "socket.io";
import cors from "cors";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { convertToWav, transcribeAudio, transcribeWithDeepgram } from "./transcriber";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: "*" }
});

// SESSION STORE ---------------------------------
type Phase =
  | "intro"
  | "projects"
  | "technical"
  | "behavioral"
  | "scenario"
  | "wrapup";

type Level = "intern" | "junior" | "mid" | "senior" | "lead";

type Session = {
  id: string;
  // audio
  chunks: Buffer[];
  transcripts: string[];
  // legacy question cycling (kept for fallback)
  questionIndex: number;
  currentQuestion?: string;
  // controller fields
  company?: string;
  role?: string;
  roleDescription?: string;
  competencies?: string;
  level: Level;
  turnIndex: number;
  maxTurns: number;
  phase: Phase;
  summarySoFar: string;
  askedQuestions: string[]; // Track all questions asked to avoid repetition
  recentTranscripts: string[]; // Keep last 3 full transcripts for context
};

const sessions = new Map<string, Session>();

const QUESTION_BANK = [
  "Tell me about a challenging bug you fixed and how you approached it.",
  "Describe a time when you had to balance speed and quality. What did you do?",
  "How do you handle disagreements within a product or engineering team?",
  "What metric do you rely on most in your current role, and why?",
  "Walk me through a project where you significantly improved user experience."
];

function getQuestionByIndex(index: number) {
  if (!QUESTION_BANK.length) {
    return "Please describe a recent project you are proud of.";
  }
  return QUESTION_BANK[index % QUESTION_BANK.length];
}

// CONTROLLER: Phase mapping and utils ---------------------------
function getPhaseByTurn(turnIndex: number, maxTurns: number): Phase {
  // Controller sequence: intro → projects → technical → behavioral → scenario → wrapup
  if (turnIndex <= 0) return "intro";
  const lastIndex = Math.max(0, maxTurns - 1);
  if (turnIndex >= lastIndex) return "wrapup";
  if (turnIndex <= 2) return "projects";
  if (turnIndex <= 4) return "technical";
  if (turnIndex <= 6) return "behavioral";
  return "scenario";
}

function clampSummary(texts: string[], maxChars = 1000) {
  const joined = texts.join(" \n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(-maxChars);
}

function extractKeyFacts(transcript: string): string {
  const t = (transcript || "").trim();
  if (!t) return "";
  const oneLine = t.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").slice(0, 1200);

  function grab(re: RegExp): string | null {
    const m = oneLine.match(re);
    return m && m[1] ? m[1].trim() : null;
  }

  const name =
    grab(/(?:my name is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/) ||
    null;
  const college =
    grab(/(?:from|at|stud(?:y|ied) at)\s+([A-Z][A-Za-z&. ]+(?:University|Institute|College)\b[^,.]*)/) ||
    null;
  const degree =
    grab(/\b(B\.?(?:Tech|E)|BSc|MSc|M\.?(?:Tech)|MS|Bachelor(?:'s)?|Master(?:'s)?)[^,.]*/i) ||
    null;

  const skills: string[] = [];
  const known = [
    "java",
    "python",
    "javascript",
    "typescript",
    "react",
    "node",
    "express",
    "spring",
    "c++",
    "sql",
    "mongodb",
    "postgres",
    "aws",
    "docker",
    "kubernetes",
    "git",
    "rest",
    "graphql",
    "html",
    "css"
  ];
  for (const k of known) {
    const re = new RegExp(`\\b${k.replace(/\+/g, "\\+")}\\b`, "i");
    if (re.test(oneLine)) skills.push(k);
  }

  const projMatches = oneLine
    .split(/[.;]/)
    .map((s) => s.trim())
    .filter((s) => /\b(project|built|developed|implemented)\b/i.test(s))
    .slice(0, 2);

  const facts: string[] = [];
  if (name) facts.push(`Name=${name}`);
  if (college) facts.push(`College=${college}`);
  if (degree) facts.push(`Degree=${degree}`);
  if (projMatches.length) facts.push(`Projects=${projMatches.join(" | ")}`);
  if (skills.length) facts.push(`Skills=${Array.from(new Set(skills)).slice(0, 8).join(", ")}`);
  return facts.join("; ");
}

function inferLevel(role?: string): Level {
  const r = (role || "").toLowerCase();
  if (/intern|apprentice|trainee/.test(r)) return "intern";
  if (/junior|grad|graduate|entry/.test(r)) return "junior";
  if (/lead|principal|staff|architect/.test(r)) return "lead";
  if (/senior|sr\.?/.test(r)) return "senior";
  return "mid";
}

const INTERVIEWER_PROMPT_TEMPLATE = `You are an interviewer simulator. 
Your behavior is fixed by the controller. 
Never decide phases or time. 
Never produce anything except the next interview question.

=== CONTEXT PROVIDED BY CONTROLLER ===
Company: {{COMPANY}}
Role: {{ROLE}}
Level: {{LEVEL}}
Role_Description: {{ROLE_DESCRIPTION}}
Competencies: {{ROLE_COMPETENCIES}}
Phase: {{PHASE}}        # intro | projects | technical | behavioral | scenario | wrapup
Turn_Index: {{TURN_INDEX}}
Max_Turns: {{MAX_TURNS}}
Candidate_Summary: {{SUMMARY_SO_FAR}}  
# Summary contains distilled points extracted from all past candidate answers.
Recent_Answers: {{RECENT_ANSWERS}}
# Last few complete answers from candidate - use these to generate relevant follow-ups.
Asked_Questions: {{ASKED_QUESTIONS}}
# Questions already asked in this interview. Do NOT repeat or rephrase these.

=== BEHAVIOR RULES ===
1. Ask exactly one question per response.
2. Question must align with the current Phase AND build naturally from the candidate's previous answers.
3. Generate questions dynamically based on:
   - Candidate_Summary: What they've revealed about their background, skills, projects
   - Asked_Questions: What's already been covered (never repeat)
   - Role, Level, Role_Description: Target appropriate depth and relevance
   - Company context when relevant
4. Prioritize follow-up questions that dig deeper into what the candidate mentioned.
5. If candidate mentioned specific technologies, projects, or experiences, ask about those.
6. No explanations. No prefacing. No lists. No meta-language.
7. Keep question concise; default target <= 25 words unless PHASE demands depth.
8. Maintain interviewer tone: direct, neutral, professional.
9. Favor high-frequency interview questions for the given Level; avoid niche or unusually advanced topics for lower Levels.
10. CRITICAL: Generate unique questions each time - never use the same phrasing twice.

=== PHASE LOGIC (controller-enforced; you must obey) ===
intro:
  - ask only for basic self-introduction or context-setting
projects:
  - ask about projects aligned to Role_Description and Competencies
technical:
  - ask deep role-aligned technical, system, algorithmic, or domain questions
behavioral:
  - ask behavioral or ownership questions (e.g., conflict, leadership, ambiguity)
scenario:
  - ask applied problem-solving / situational judgement / case-based questions
wrapup:
  - ask final closing question (e.g., reasons for role, questions for interviewer)

=== OUTPUT FORMAT ===
Return only the interview question for the candidate.
No additional text.`;

function fillInterviewerPrompt(s: Session) {
  const vars: Record<string, string | number> = {
    COMPANY: s.company ?? "",
    ROLE: s.role ?? "",
    LEVEL: s.level,
    ROLE_DESCRIPTION: s.roleDescription ?? "",
    ROLE_COMPETENCIES: s.competencies ?? "",
    PHASE: s.phase,
    TURN_INDEX: s.turnIndex,
    MAX_TURNS: s.maxTurns,
    SUMMARY_SO_FAR: s.summarySoFar ?? "",
    RECENT_ANSWERS: s.recentTranscripts.length > 0 ? s.recentTranscripts.slice(-3).join(" | ") : "None yet",
    ASKED_QUESTIONS: s.askedQuestions.length > 0 ? s.askedQuestions.join("; ") : "None yet"
  };
  let prompt = INTERVIEWER_PROMPT_TEMPLATE;
  for (const [k, v] of Object.entries(vars)) {
    prompt = prompt.replace(new RegExp(`{{${k}}}`, "g"), String(v));
  }
  return prompt;
}

function fallbackQuestionForPhase(s: Session): string {
  const lvl = s.level;
  const isJunior = lvl === "intern" || lvl === "junior";
  switch (s.phase) {
    case "intro":
      return `Briefly introduce yourself and your relevant experience.`;
    case "projects":
      return isJunior
        ? `Tell me about a project you built or contributed to and your role.`
        : `Describe a project where you owned key responsibilities.`;
    case "technical":
      return isJunior
        ? `Explain an algorithm or data structure you know well and when you'd use it.`
        : `Explain how you'd design a scalable, fault-tolerant solution.`;
    case "behavioral":
      return `Tell me about a time you demonstrated ownership and handled ambiguity.`;
    case "scenario":
      return `An outage impacts customers; what immediate steps would you take and why?`;
    case "wrapup":
    default:
      return `Why are you interested in this role, and any questions for us?`;
  }
}

function buildMockEvaluation(transcript: string) {
  const normalizedLength = Math.min(1, transcript.length / 800);
  const baseScore = Math.round(2 + normalizedLength * 3 + Math.random());
  const score = Math.max(1, Math.min(5, baseScore));
  return {
    score,
    pass: score >= 3,
    feedback:
      score >= 3
        ? "Solid answer. You clearly explained the situation and your impact."
        : "Try adding more detail about your actions and measurable outcomes.",
    next_question: null
  };
}

async function callOpenRouter(prompt: string, systemPrompt?: string) {
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

  if (!OPENROUTER_KEY) {
    console.error("❌ OPENROUTER_API_KEY missing. Add it to backend/.env");
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  console.log("🔑 Using OpenRouter API key:", OPENROUTER_KEY.slice(0, 10) + "...");
  console.log("📤 Sending prompt (first 200 chars):", prompt.slice(0, 200));

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openai/gpt-oss-20b:free",
        messages: [
          { role: "system", content: systemPrompt ?? "You are an interviewer and evaluator." },
          { role: "user", content: prompt }
        ],
        max_tokens: 600
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer": "http://localhost:4000",
          "X-Title": "Interview Simulator"
        },
        timeout: 30000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
      console.error("❌ OpenRouter returned no content:", JSON.stringify(response.data));
      throw new Error("No content in OpenRouter response");
    }

    console.log("✅ OpenRouter response (first 150 chars):", content.slice(0, 150));
    return content;
  } catch (err: any) {
    console.error("❌ OpenRouter API error:", err?.response?.data || err?.message);
    throw err;
  }
}

async function evaluateAnswer(prompt: string, transcript: string) {
  try {
    const llmText = await callOpenRouter(prompt);
    const start = llmText.indexOf("{");
    const jsonStr = start >= 0 ? llmText.substring(start) : llmText;
    return JSON.parse(jsonStr);
  } catch (err: any) {
    console.warn("Evaluation failed, using mock data:", err?.message);
    return buildMockEvaluation(transcript);
  }
}

async function getNextQuestionFromLLM(session: Session) {
  console.log("\n🎯 Generating question for turn", session.turnIndex, "phase:", session.phase);
  const interviewerPrompt = fillInterviewerPrompt(session);
  console.log("📋 Asked questions so far:", session.askedQuestions.length);
  console.log("💬 Recent answers count:", session.recentTranscripts.length);

  function sanitizeQuestion(raw: string): string {
    let t = String(raw || "");
    // Remove code fences and markdown artifacts
    t = t.replace(/```[\s\S]*?```/g, " ");
    // Remove common labels if present
    t = t.replace(/^\s*(Company|Role|Role_Description|Competencies|Phase|Turn_Index|Max_Turns|Candidate_Summary)\s*:.*$/gim, " ");
    t = t.replace(/^\s*(BEHAVIOR RULES|PHASE LOGIC|OUTPUT FORMAT).*$/gim, " ");
    // Remove leading prefixes
    t = t.replace(/^\s*(Q:|Question:|Interviewer:|Prompt:)\s*/i, "");
    // Remove role/company references like "for the <role>" or "at <company>"
    t = t.replace(/\bfor (the )?(position|role) of\b[^?.!]*?/gi, "");
    t = t.replace(/\bfor (the )?[A-Za-z0-9 ./#+-]+ role\b/gi, "");
    t = t.replace(/\bat [A-Za-z0-9 ./#+-]+\b/gi, "");
    // Take first line with substantive content
    const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let first = lines.join(" ").trim();
    // Prefer first sentence ending with a question mark
    const qIdx = first.indexOf("?");
    if (qIdx >= 0) first = first.slice(0, qIdx + 1);
    // Collapse whitespace and clamp length
    first = first.replace(/\s+/g, " ").trim().slice(0, 240);
    return first;
  }

  try {
    const text = await callOpenRouter(
      interviewerPrompt,
      `You are an interviewer for a position with the following role description: ${session.roleDescription} for role ${session.role} at ${session.company}. Start by greeting the candidate and saying something like: “Good morning/afternoon, thank you for joining us today.” Then ask the candidate to introduce themselves: include their background (education/work/internship), key projects they’ve worked on (names, technologies used), the technical skills they have, and their motivation for applying to this role. Listen to their answer and capture keywords (e.g., project titles, languages, frameworks, tools, internships). After this introduction phase, move into follow-up questions based on those keywords: ask about specific contributions, design decisions, challenges faced, outcomes. Keep track of all questions already asked and never repeat a question. Calibrate the difficulty of questions to match the role description and the candidate’s level.`
    );
    const q = sanitizeQuestion(text);
    if (!q || q.startsWith("{") || q.length < 4) {
      console.warn("⚠️ Sanitized question is invalid, using fallback");
      const fb = fallbackQuestionForPhase(session);
      console.log("📦 Fallback question:", fb);
      return fb;
    }
    console.log("✨ Generated question:", q);
    return q;
  } catch (err: any) {
    console.error("❌ Question generation failed:", err?.message);
    const fb = fallbackQuestionForPhase(session);
    console.log("📦 Using fallback question:", fb);
    return fb;
  }
}

// ROUTE: Create Interview ------------------------
app.post("/api/interviews", async (req, res) => {
  const id = uuidv4();
  const {
    company,
    role,
    roleDescription,
    competencies,
    maxTurns,
    level
  } = req.body ?? {};

  const initialTurn = 0;
  const mTurns = typeof maxTurns === "number" && maxTurns > 0 ? maxTurns : 8;
  const initialPhase = getPhaseByTurn(initialTurn, mTurns);

  const session: Session = {
    id,
    chunks: [],
    transcripts: [],
    questionIndex: 0,
    company,
    role,
    roleDescription,
    competencies,
    level: level ?? inferLevel(role),
    turnIndex: initialTurn,
    maxTurns: mTurns,
    phase: initialPhase,
    summarySoFar: "",
    askedQuestions: [],
    recentTranscripts: []
  };
  // Generate first question via interviewer prompt
  console.log("\n🚀 Creating new interview for:", role, "at", company, "(level:", session.level, ")");
  try {
    session.currentQuestion = await getNextQuestionFromLLM(session);
    if (session.currentQuestion) {
      session.askedQuestions.push(session.currentQuestion);
      console.log("✅ First question generated:", session.currentQuestion);
    }
  } catch (err: any) {
    console.error("❌ First question generation failed:", err?.message);
    session.currentQuestion = getQuestionByIndex(session.questionIndex);
    if (session.currentQuestion) {
      session.askedQuestions.push(session.currentQuestion);
    }
  }
  sessions.set(id, session);

  res.json({ id, question: session.currentQuestion, phase: session.phase });
});

// ROUTE: OpenRouter Proxy -------------------------
app.post("/api/openrouter/proxy", async (req, res) => {
  const { prompt } = req.body;

  try {
    const text = await callOpenRouter(prompt);
    res.json({ text, mock: !process.env.OPENROUTER_API_KEY });
  } catch (err: any) {
    console.error("OpenRouter proxy error:", err?.message);
    const fallback = buildMockEvaluation(prompt);
    res.json({ text: JSON.stringify(fallback), mock: true });
  }
});

// ROUTE: ElevenLabs TTS -------------------------
app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

  if (!text) {
    return res.status(400).json({ error: "Missing text" });
  }

  if (!ELEVENLABS_KEY) {
    return res.status(503).json({ error: "ElevenLabs API key not configured" });
  }

  try {
    // Using Adam voice (preset) with turbo v2.5 model for low latency
    const voiceId = "pNInz6obpgDQGcFmaJgB"; // Adam voice
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const response = await axios.post(
      url,
      {
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      },
      {
        headers: {
          "xi-api-key": ELEVENLABS_KEY,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer",
        timeout: 30000
      }
    );

    res.set("Content-Type", "audio/mpeg");
    res.send(response.data);
  } catch (err: any) {
    console.error("ElevenLabs TTS error:", err?.message);
    res.status(500).json({ error: "TTS generation failed" });
  }
});

// SOCKET.IO ---------------------------------------
io.of("/interview").on("connection", (socket: Socket) => {
  console.log("client connected", socket.id);

  let sid: string | null = null;

  socket.on("join", (data: { interviewId: string }) => {
    const requestedId = data.interviewId;
    const session = sessions.get(requestedId);

    if (!session) {
      console.warn("join: session missing for", requestedId);
      socket.emit("session-missing");
      return;
    }

    sid = requestedId;
    socket.join(sid);
    console.log("joined", sid);

    if (session.currentQuestion) {
      socket.emit("question", { question: session.currentQuestion });
    }
  });

  socket.on("audio-chunk", (chunk: ArrayBuffer) => {
    if (!sid) return;

    const session = sessions.get(sid);
    if (!session) {
      console.warn("audio-chunk: session not found for", sid);
      return;
    }

    session.chunks.push(Buffer.from(chunk));
  });

  socket.on("end-answer", async () => {
    if (!sid) return;

    const session = sessions.get(sid);
    if (!session) {
      console.warn("end-answer: session not found for", sid);
      return;
    }
    // Grace period to allow final audio chunks to arrive
    await new Promise((r) => setTimeout(r, 350));
    const audioBuffer = Buffer.concat(session.chunks);
    session.chunks = [];

    // SAVE AUDIO FILE
    const filePath = `./tmp/${sid}-${Date.now()}.webm`;
    fs.mkdirSync("./tmp", { recursive: true });
    fs.writeFileSync(filePath, audioBuffer);

    // TRANSCRIBE (Deepgram preferred, Whisper fallback)
    let transcript = "";
    try {
      if (process.env.DEEPGRAM_API_KEY) {
        transcript = await transcribeWithDeepgram(filePath, "audio/webm");
      } else {
        const wavPath = await convertToWav(filePath);
        transcript = await transcribeAudio(wavPath);
      }
      console.log("Transcript:", transcript);
    } catch (err) {
      console.error("Whisper failed:", err);
      transcript = "Transcription failed.";
    }

    session.transcripts.push(transcript);
    // Keep last 3 full transcripts for adaptive questioning
    session.recentTranscripts.push(transcript);
    if (session.recentTranscripts.length > 3) {
      session.recentTranscripts.shift();
    }
    // Extract compact facts and update summary (avoid passing full transcript)
    const factsLine = extractKeyFacts(transcript);
    session.summarySoFar = clampSummary(
      [session.summarySoFar, factsLine].filter(Boolean) as string[],
      1200
    );
    // Advance turn and phase
    session.turnIndex = Math.min(session.turnIndex + 1, session.maxTurns);
    session.phase = getPhaseByTurn(session.turnIndex, session.maxTurns);

    // BUILD PROMPT FOR LLM
    const prompt = `
  Question: ${session.currentQuestion}
  Transcript: ${transcript}
  Rubric: grade 0-5 and give brief feedback. Return JSON only with keys: score, pass, feedback.
    `;

    // CALL LLM (WITH FALLBACK)
    let evalJson: any;
    try {
      evalJson = await evaluateAnswer(prompt, transcript);
    } catch (err) {
      console.error("evaluateAnswer failed, using mock:", err);
      evalJson = buildMockEvaluation(transcript);
    }

    // CHECK FOR INTERVIEW COMPLETION
    if (session.turnIndex >= session.maxTurns) {
      console.log("🏁 Interview complete for session:", sid);
      
      // Calculate average score
      // In a real app, we'd store all scores in session.evaluations array
      // For now, we'll just use the last score or a mock average
      const avgScore = evalJson?.score || 3; 

      io.of("/interview").to(sid).emit("evaluation", {
        evaluation: evalJson,
        nextQuestion: null, // No next question
        transcript
      });

      io.of("/interview").to(sid).emit("interview-ended", {
        summary: session.summarySoFar,
        averageScore: avgScore
      });
      
      // Clean up or mark session as done
      return;
    }

    // Generate next interviewer question strictly from controller state
    let nextQuestion = await getNextQuestionFromLLM(session);
    if (!nextQuestion) {
      session.questionIndex = (session.questionIndex + 1) % QUESTION_BANK.length;
      nextQuestion = getQuestionByIndex(session.questionIndex);
    }
    session.currentQuestion = nextQuestion;
    if (nextQuestion) {
      session.askedQuestions.push(nextQuestion);
    }

    io.of("/interview").to(sid).emit("evaluation", {
      evaluation: evalJson,
      nextQuestion,
      transcript
    });
  });

  socket.on("proctor-update", (meta: any) => {
    if (!sid) return;
    io.of("/interview").to(sid).emit("proctor-status", meta);
  });

  socket.on("disconnect", () => {
    console.log("socket disconnected", socket.id);
  });
});

// START SERVER --------------------------------------
const PORT = process.env.PORT ?? 4000;
server.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
