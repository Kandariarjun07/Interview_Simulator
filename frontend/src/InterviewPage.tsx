import React, {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { io, Socket } from "socket.io-client";

const BACKEND_BASE =
  (import.meta as any).env.VITE_BACKEND_URL || "http://localhost:4000";

type ChatMessage = {
  id: string;
  sender: string;
  text: string;
  role: "interviewer" | "candidate" | "system";
  timestamp: number;
};

const navItems = [
  "Main Menu",
  "Dashboard",
  "Interview",
  "Insight",
  "Talent",
  "General",
  "FAQ",
  "Setting"
];

function formatTime(ts: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(ts);
}

const SILENCE_THRESHOLD = 0.01; // Lowered threshold
const MIN_SPEECH_DURATION_MS = 250; // User must speak for at least 250ms to be considered "speaking"
const SILENCE_WINDOW_MS = 3000;

export default function InterviewPage() {
  const [uiState, setUiState] = useState<"card" | "normal">("card");
  const [consented, setConsented] = useState(false);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "recording" | "processing">(
    "idle"
  );
  const displayRole = useMemo(() => {
    const text = (role || "").trim();
    if (!text) return "";
    const firstLine = text.split(/\r?\n/)[0];
    return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
  }, [role]);
  const displayCompany = useMemo(() => {
    const text = (company || "").trim();
    return text.length > 40 ? text.slice(0, 37) + "..." : text;
  }, [company]);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [sessionLost, setSessionLost] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      sender: "AI Interviewer",
      text: "Hello, welcome back! Ready when you are.",
      role: "interviewer",
      timestamp: Date.now()
    }
  ]);

  const socketRef = useRef<Socket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const lastQuestionRef = useRef<string | null>(null);
  const lastFeedbackRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceSinceRef = useRef<number | null>(null);
  const autoStopTriggeredRef = useRef(false);
  const hasStartedSpeakingRef = useRef(false);

  // Initialize to card view if no details are set
  useEffect(() => {
    if (!company && !role) {
      setUiState("card");
    } else {
      setUiState("normal");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      camStream?.getTracks().forEach((track) => track.stop());
      micStream?.getTracks().forEach((track) => track.stop());
      audioContextRef.current?.close();
    };
  }, [camStream, micStream]);

  useEffect(() => {
    let interval: number | undefined;
    if (camStream && socketRef.current && interviewId) {
      interval = window.setInterval(() => {
        const facePresent = camStream.getVideoTracks().some((track) => track.enabled);
        socketRef.current?.emit("proctor-update", {
          facePresent,
          timestamp: Date.now()
        });
      }, 2500);
    }
    return () => {
      if (interval) window.clearInterval(interval);
    };
  }, [camStream, interviewId]);

  useEffect(() => {
    if (question && question !== lastQuestionRef.current) {
      lastQuestionRef.current = question;
      pushMessage({
        sender: "AI Interviewer",
        text: question,
        role: "interviewer"
      });
    }
  }, [question]);

  useEffect(() => {
    if (evaluation?.feedback && evaluation.feedback !== lastFeedbackRef.current) {
      lastFeedbackRef.current = evaluation.feedback;
      pushMessage({
        sender: "AI Coach",
        text: evaluation.feedback,
        role: "system"
      });
    }
  }, [evaluation]);

  function pushMessage(message: Omit<ChatMessage, "id" | "timestamp">) {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), timestamp: Date.now(), ...message }
    ]);
  }

  function setupAudioAnalyser(stream: MediaStream) {
    try {
      audioContextRef.current?.close();
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
    } catch (err) {
      console.warn("Audio analyser unavailable:", err);
    }
  }

  async function handleConsent() {
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 }
      });
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      setCamStream(camera);
      setMicStream(mic);
      setupAudioAnalyser(mic);
      setConsented(true);
    } catch (error) {
      console.error("Permission denied:", error);
      alert("Mic/Camera permission denied. Please allow them & refresh.");
      setConsented(false);
    }
  }

  async function createInterview() {
    if (!company || !role) {
      alert("Please enter a company and role to start the interview.");
      return;
    }
    try {
      const r = await fetch(`${BACKEND_BASE}/api/interviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, role, roleDescription }),
      });
      if (!r.ok) throw new Error("Failed to create interview");
      const data = await r.json();

      setInterviewId(data.id);
      setQuestion(data.question);
      setSessionLost(false);
      connectSocket(data.id);
    } catch (error) {
      console.error("Interview creation failed:", error);
      alert("Error creating interview. Please try again.");
    }
  }

  function connectSocket(id: string) {
    socketRef.current?.disconnect();
    const socket = io(`${BACKEND_BASE}/interview`, {
      transports: ["websocket"]
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join", { interviewId: id });
    });

    socket.on("question", (payload: { question: string }) => {
      setQuestion(payload.question);
      speak(payload.question, () => {
        if (interviewId) {
          startRecording();
        }
      });
      setStatus("idle");
    });

    socket.on(
      "evaluation",
      (payload: { evaluation: any; nextQuestion: string | null; transcript?: string }) => {
        setEvaluation(payload.evaluation);
        if (payload?.transcript) {
          pushMessage({ sender: "You", text: payload.transcript, role: "candidate" });
        }
        setQuestion(payload.nextQuestion);
        setStatus("idle");
        if (payload.nextQuestion) {
          speak(payload.nextQuestion, () => {
            if (interviewId) {
              startRecording();
            }
          });
        }
      }
    );

    socket.on("session-missing", () => {
      setSessionLost(true);
      setInterviewId(null);
      setStatus("idle");
      socket.disconnect();
      pushMessage({
        sender: "System",
        text: "Session expired. Please start a new interview.",
        role: "system"
      });
    });
  }

  function speak(text: string, onEnd?: () => void) {
    // Try ElevenLabs TTS first
    fetch(`${BACKEND_BASE}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    })
      .then((res) => {
        if (!res.ok) throw new Error("TTS failed");
        return res.blob();
      })
      .then((blob) => {
        const audio = new Audio(URL.createObjectURL(blob));
        audio.onended = () => {
          if (onEnd) onEnd();
        };
        audio.onerror = () => {
          console.warn("Audio playback failed, trying browser TTS");
          fallbackToSpeechSynthesis(text, onEnd);
        };
        audio.play().catch(() => {
          console.warn("Audio play blocked, trying browser TTS");
          fallbackToSpeechSynthesis(text, onEnd);
        });
      })
      .catch((err) => {
        console.warn("ElevenLabs TTS unavailable, using browser TTS:", err?.message);
        fallbackToSpeechSynthesis(text, onEnd);
      });
  }

  function fallbackToSpeechSynthesis(text: string, onEnd?: () => void) {
    try {
      if ("speechSynthesis" in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        if (onEnd) {
          utterance.onend = onEnd;
        }
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } else if (onEnd) {
        onEnd();
      }
    } catch (error) {
      console.warn("Speech synthesis failed:", error);
      if (onEnd) {
        onEnd();
      }
    }
  }

  function pickSupportedMime() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ];
    for (const c of candidates) {
      if ((MediaRecorder as any).isTypeSupported?.(c)) return c;
    }
    return undefined;
  }

  function startRecording() {
    if (!micStream || !socketRef.current) {
      alert("Microphone not available.");
      return;
    }

    const tracks = micStream.getAudioTracks();
    if (!tracks.length) {
      alert("No microphone detected.");
      return;
    }

    const mime = pickSupportedMime();
    const options =
      mime !== undefined
        ? { mimeType: mime, audioBitsPerSecond: 128000 }
        : { audioBitsPerSecond: 128000 };
    let recorder: MediaRecorder;

    try {
      recorder = new MediaRecorder(micStream, options as any);
    } catch (err) {
      try {
        recorder = new MediaRecorder(micStream);
      } catch (err2) {
        console.error("MediaRecorder cannot start:", err2);
        alert("Recording is not supported on this browser.");
        return;
      }
    }

    recorder.ondataavailable = (event) => {
      if (event.data?.size) {
        event.data.arrayBuffer().then((buffer) => {
          socketRef.current?.emit("audio-chunk", buffer);
        });
      }
    };

    mediaRecorderRef.current = recorder;
    autoStopTriggeredRef.current = false;
    hasStartedSpeakingRef.current = false;
    silenceSinceRef.current = null;

    try {
      recorder.start(800);
      setStatus("recording");
    } catch (error) {
      console.error("Failed to start recording:", error);
      alert("Could not start microphone recording.");
    }
  }

  function stopRecordingAndSubmit() {
    if (!mediaRecorderRef.current) return;

    try {
      // Request final data flush, then stop
      try { (mediaRecorderRef.current as any).requestData?.(); } catch {}
      mediaRecorderRef.current.stop();
    } catch (error) {
      console.warn("Error stopping recorder:", error);
    }

    setStatus("processing");
    // Slight delay to ensure the last dataavailable reaches the server
    setTimeout(() => {
      socketRef.current?.emit("end-answer");
    }, 350);
  }

  useEffect(() => {
    if (!micStream || !analyserRef.current) return;
    let rafId: number;
    const analyser = analyserRef.current;
    const dataArray = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const deviation = dataArray[i] - 128;
        sumSquares += deviation * deviation;
      }
      const rms = Math.sqrt(sumSquares / dataArray.length) / 128;
      const now = Date.now();
      
      if (rms >= SILENCE_THRESHOLD) {
        // User is speaking
        hasStartedSpeakingRef.current = true;
        silenceSinceRef.current = null;
        autoStopTriggeredRef.current = false;
      } else if (hasStartedSpeakingRef.current) {
        // User has spoken before and is now silent
        if (!silenceSinceRef.current) {
          silenceSinceRef.current = now;
        } else if (
          status === "recording" &&
          !autoStopTriggeredRef.current &&
          now - silenceSinceRef.current > SILENCE_WINDOW_MS
        ) {
          autoStopTriggeredRef.current = true;
          stopRecordingAndSubmit();
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [micStream, status]);

  const displayScore = useMemo(() => {
    const raw =
      typeof evaluation?.score === "number" ? Number(evaluation.score) : 0;
    return Math.max(0, Math.min(100, Math.round(raw * 20)));
  }, [evaluation]);

  const workmapScores = useMemo(() => {
    const base = displayScore || 60;
    return [
      { label: "Presentation", value: base },
      { label: "Business Acumen", value: Math.min(100, base + 15) },
      { label: "Closing Technique", value: Math.max(35, base - 20) }
    ];
  }, [displayScore]);

  const statusClass =
    status === "recording"
      ? "status-pill status-recording"
      : status === "processing"
      ? "status-pill status-processing"
      : "status-pill status-idle";

  const primaryButtonLabel = !consented
    ? "Allow Camera & Mic"
    : !interviewId
    ? "Start Interview"
    : status === "recording"
    ? "Stop & Submit"
    : "Start Answer";

  function handlePrimaryAction() {
    if (!consented) {
      handleConsent();
      return;
    }
    if (!interviewId) {
      createInterview();
      return;
    }
    if (status === "recording") {
      stopRecordingAndSubmit();
    } else {
      startRecording();
    }
  }

  function handleChatInput(event: ChangeEvent<HTMLInputElement>) {
    setChatInput(event.target.value);
  }

  function handleSendChat(event: FormEvent) {
    event.preventDefault();
    if (!chatInput.trim()) return;
    pushMessage({
      sender: "You",
      text: chatInput.trim(),
      role: "candidate"
    });
    setChatInput("");
  }

  function handleSaveAndNext() {
    if (!company || !role) return;
    setUiState("normal");
  }

  if (uiState === "card") {
    return (
      <div className="card-view">
        <div className="card-backdrop">
          <div className="details-card">
            <h1 className="card-title">Interview Setup</h1>
            <p className="card-subtitle">
              Configure your interview details to get started.
            </p>
            
            <div className="card-input-group">
              <label>Company</label>
              <input
                type="text"
                placeholder="Google, Apple, Microsoft..."
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>
            
            <div className="card-input-group">
              <label>Role</label>
              <input
                type="text"
                placeholder="Software Engineer, Product Manager..."
                value={role}
                onChange={(e) => setRole(e.target.value)}
              />
            </div>
            
            <div className="card-input-group">
              <label>Role Details</label>
              <textarea
                placeholder="Key responsibilities, required skills, job description..."
                value={roleDescription}
                onChange={(e) => setRoleDescription(e.target.value)}
                rows={4}
              />
            </div>
            
            <button
              className="card-save-btn"
              onClick={handleSaveAndNext}
              disabled={!company || !role}
            >
              Save & Next
            </button>
          </div>
        </div>
      </div>
    );
  }


  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">IA</div>
          InterviewAI
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item}
              className={item === "Interview" ? "active" : ""}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-profile">
            <img
              src="https://img.stablecog.com/insecure/1920w/aHR0cHM6Ly9iLnN0YWJsZWNvZy5jb20vNGFiZjY0ODQtOWY3Zi00NTIyLWFjOGQtZmZkOTNmNWU3ZmRjLmpwZWc.webp"
              alt="profile avatar"
              draggable={false}
            />
            <div>
              <div style={{ fontWeight: 600 }}>You</div>
              <div style={{ opacity: 0.7, fontSize: "0.85rem" }}>Candidate</div>
            </div>
          </div>
          <button className="secondary-btn">Log Out</button>
        </div>
      </aside>

      <main className="content-area">
        <header className="content-header">
          <div className="header-info">
            <p className="subtitle-ellipsis" style={{ margin: 0, color: "#7d7f95" }}>
              Interview for{" "}
              {displayRole && displayCompany ? `${displayRole} at ${displayCompany}` : "a new role"}
            </p>
            <h2 className="title-ellipsis" style={{ margin: 0 }}>
              {displayRole || "UI/UX Designer"}
            </h2>
          </div>
          <div className="action-row">
            {sessionLost && (
              <div className="session-banner">
                Session expired — start a new interview to continue.
              </div>
            )}
            <button
              className="primary-btn"
              onClick={handlePrimaryAction}
              disabled={status === "processing"}
            >
              {primaryButtonLabel}
            </button>
          </div>
        </header>

        <div className="content-grid">
          <section className="card video-card">
            <div className="video-frame">
              {camStream ? (
                <video
                  autoPlay
                  muted
                  playsInline
                  ref={(el) => {
                    if (el && camStream) el.srcObject = camStream;
                  }}
                />
              ) : (
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "grid",
                    placeItems: "center",
                    color: "#fff",
                    fontSize: "1.1rem"
                  }}
                >
                  Camera preview will appear here once you allow access.
                </div>
              )}
              <div className="video-overlay">
                {status === "recording" && (
                  <div className="recording-pill">Recording</div>
                )}
                <div className="video-controls">
                  <button className="control-button" title="Microphone">
                    🎙
                  </button>
                  <button
                    className="control-button end"
                    title={status === "recording" ? "Stop" : "Start"}
                    onClick={() =>
                      status === "recording"
                        ? stopRecordingAndSubmit()
                        : startRecording()
                    }
                    disabled={!interviewId || status === "processing"}
                  >
                    {status === "recording" ? "■" : "▶"}
                  </button>
                  <button className="control-button" title="Settings">
                    ⚙️
                  </button>
                </div>
              </div>
            </div>

            <div className="question-card">
              <div className={statusClass}>
                Status: {status.charAt(0).toUpperCase() + status.slice(1)}
              </div>
              <h4>Conversation now</h4>
              <p style={{ fontSize: "1.1rem", margin: 0 }}>
                {question ??
                  "Click Start Interview to receive your first question."}
              </p>
            </div>

            <div className="score-card">
              <div className="score-header">
                <h3 style={{ margin: 0 }}>AI Video Score</h3>
                <span style={{ color: "#7a7c92" }}>Latest breakdown</span>
              </div>

              <div className="meter-group">
                <div className="meter">
                  <h5>AI Score</h5>
                  <strong>{displayScore}%</strong>
                </div>
                <div className="meter">
                  <h5>Workmap Score</h5>
                  <strong>
                    {evaluation?.workmap ?? Math.min(100, displayScore + 12)}%
                  </strong>
                </div>
              </div>

              <div className="workmap-list">
                {workmapScores.map((item) => (
                  <div className="workmap-item" key={item.label}>
                    <span>{item.label}</span>
                    <div className="workmap-bar">
                      <div
                        className="workmap-bar-fill"
                        style={{ width: `${item.value}%` }}
                      />
                    </div>
                    <strong>{item.value}%</strong>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <aside className="card chat-card">
            <div className="chat-tabs">
              <button className="active">Chat</button>
              <button type="button">Participant</button>
            </div>
            <div className="chat-messages">
              {messages.map((msg) => {
                const bubbleClass =
                  msg.role === "candidate"
                    ? "chat-bubble outgoing"
                    : msg.role === "system"
                    ? "chat-bubble system"
                    : "chat-bubble incoming";
                return (
                  <div key={msg.id}>
                    <small style={{ color: "#9a9cc2" }}>
                      {msg.sender} • {formatTime(msg.timestamp)}
                    </small>
                    <div className={bubbleClass}>{msg.text}</div>
                  </div>
                );
              })}
            </div>
            <form className="chat-input" onSubmit={handleSendChat}>
              <input
                placeholder="Send your message..."
                value={chatInput}
                onChange={handleChatInput}
              />
              <button type="submit">Send</button>
            </form>
          </aside>
        </div>
      </main>
    </div>
  );
}
