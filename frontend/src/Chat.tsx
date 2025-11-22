import React, { useState, FormEvent, ChangeEvent, memo } from "react";

export type ChatMessage = {
  id: string;
  sender: string;
  text: string;
  role: "interviewer" | "candidate" | "system";
  timestamp: number;
};

interface ChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
}

function formatTime(ts: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(ts);
}

const Chat = memo(({ messages, onSendMessage }: ChatProps) => {
  const [chatInput, setChatInput] = useState("");

  function handleChatInput(event: ChangeEvent<HTMLInputElement>) {
    setChatInput(event.target.value);
  }

  function handleSendChat(event: FormEvent) {
    event.preventDefault();
    if (!chatInput.trim()) return;
    onSendMessage(chatInput.trim());
    setChatInput("");
  }

  return (
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
  );
});

export default Chat;
