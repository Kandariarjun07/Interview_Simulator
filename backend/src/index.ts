import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server as IOServer, Socket } from "socket.io";
import cors from "cors";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { convertToWav, transcribeAudio } from "./transcriber";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: "*" }
});

// SESSION STORE ---------------------------------
type Session = {
  id: string;
  chunks: Buffer[];
  transcripts: string[];
  questionIndex: number;
  currentQuestion?: string;
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

async function callOpenRouter(prompt: string) {
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

  if (!OPENROUTER_KEY) {
    console.warn("OPENROUTER_API_KEY missing. Returning mock evaluation.");
    return JSON.stringify(buildMockEvaluation(prompt));
  }

  const response = await axios.post(
    "https://api.openrouter.ai/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an interviewer and evaluator." },
        { role: "user", content: prompt }
      ],
      max_tokens: 600
    },
    {
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}` }
    }
  );

  return (
    response.data?.choices?.[0]?.message?.content ??
    JSON.stringify(response.data)
  );
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

// ROUTE: Create Interview ------------------------
app.post("/api/interviews", (req, res) => {
  const id = uuidv4();
  const session: Session = {
    id,
    chunks: [],
    transcripts: [],
    questionIndex: 0
  };
  session.currentQuestion = getQuestionByIndex(session.questionIndex);
  sessions.set(id, session);

  res.json({ id, question: session.currentQuestion });
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
    const audioBuffer = Buffer.concat(session.chunks);
    session.chunks = [];

    // SAVE AUDIO FILE
    const filePath = `./tmp/${sid}-${Date.now()}.webm`;
    fs.mkdirSync("./tmp", { recursive: true });
    fs.writeFileSync(filePath, audioBuffer);

    // TRANSCRIBE WITH WHISPER
    let transcript = "";
    try {
      const wavPath = await convertToWav(filePath);
      transcript = await transcribeAudio(wavPath);
      console.log("Transcript:", transcript);
    } catch (err) {
      console.error("Whisper failed:", err);
      transcript = "Transcription failed.";
    }

    session.transcripts.push(transcript);

    // BUILD PROMPT FOR LLM
    const prompt = `
Question: ${session.currentQuestion}
Transcript: ${transcript}
Rubric: grade 0-5, give feedback, and propose a next question.
Return JSON only.
    `;

    // CALL LLM (WITH FALLBACK)
    let evalJson: any;
    try {
      evalJson = await evaluateAnswer(prompt, transcript);
    } catch (err) {
      console.error("evaluateAnswer failed, using mock:", err);
      evalJson = buildMockEvaluation(transcript);
    }

    session.questionIndex = (session.questionIndex + 1) % QUESTION_BANK.length;
    const nextQuestion =
      evalJson.next_question ?? getQuestionByIndex(session.questionIndex);
    session.currentQuestion = nextQuestion;

    io.of("/interview").to(sid).emit("evaluation", {
      evaluation: evalJson,
      nextQuestion
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
