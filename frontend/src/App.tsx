import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Role = "user" | "assistant" | "error";

type AssistantPart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

interface Message {
  role: Role;
  text?: string;
  parts?: AssistantPart[];
  streaming?: boolean;
}

interface ServerEvent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  sessionId?: string;
  message?: string;
}

const SESSION_KEY = "cinema-daddy-session";
const MAX_TEXTAREA_HEIGHT = 220;

function getSessionId() {
  return localStorage.getItem(SESSION_KEY);
}

function setSessionId(id: string) {
  localStorage.setItem(SESSION_KEY, id);
}

function clearSessionId() {
  localStorage.removeItem(SESSION_KEY);
}

function friendlyToolPhrase(
  name: string,
  input: Record<string, unknown>,
): string {
  switch (name) {
    case "search_title": {
      const q = typeof input?.query === "string" ? input.query : "";
      return q ? `Searching for "${q}"…` : "Searching TMDB…";
    }
    case "get_details":
      return "Fetching details…";
    case "get_streaming_providers":
      return "Checking where to stream…";
    case "get_imdb_rating":
      return "Looking up IMDB rating…";
    case "get_show_seasons":
      return "Pulling season list…";
    case "get_season_episodes": {
      const n = input?.season_number;
      return typeof n === "number"
        ? `Fetching season ${n} episodes…`
        : "Fetching episodes…";
    }
    case "get_best_episodes":
      return "Finding the best episodes…";
    default:
      return `Running ${name}…`;
  }
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
  }, [input]);

  function replaceLastAssistantWithError(msg: string) {
    setMessages((m) => {
      const last = m[m.length - 1];
      if (last && last.role === "assistant") {
        return [...m.slice(0, -1), { role: "error", text: msg }];
      }
      return [...m, { role: "error", text: msg }];
    });
  }

  function handleStreamEvent(ev: ServerEvent) {
    if (ev.type === "session" && ev.sessionId) {
      setSessionId(ev.sessionId);
      return;
    }
    if (ev.type === "text_delta" && typeof ev.text === "string") {
      const delta = ev.text;
      setMessages((m) => {
        const last = m[m.length - 1];
        if (!last || last.role !== "assistant" || !last.parts) return m;
        const parts = [...last.parts];
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.type === "text") {
          parts[parts.length - 1] = {
            type: "text",
            text: lastPart.text + delta,
          };
        } else {
          parts.push({ type: "text", text: delta });
        }
        return [...m.slice(0, -1), { ...last, parts }];
      });
      return;
    }
    if (
      ev.type === "tool_use" &&
      typeof ev.id === "string" &&
      typeof ev.name === "string"
    ) {
      const tool: AssistantPart = {
        type: "tool",
        id: ev.id,
        name: ev.name,
        input: ev.input ?? {},
      };
      setMessages((m) => {
        const last = m[m.length - 1];
        if (!last || last.role !== "assistant" || !last.parts) return m;
        return [
          ...m.slice(0, -1),
          { ...last, parts: [...last.parts, tool] },
        ];
      });
      return;
    }
    if (ev.type === "error" && typeof ev.message === "string") {
      replaceLastAssistantWithError(ev.message);
      return;
    }
  }

  async function send() {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [
      ...m,
      { role: "user", text: trimmed },
      { role: "assistant", parts: [], streaming: true },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: getSessionId(), message: trimmed }),
      });

      if (!res.ok || !res.body) {
        let errMsg = `Error ${res.status}`;
        try {
          const data = await res.json();
          if (data?.error) errMsg = data.error;
        } catch {
          /* ignore */
        }
        replaceLastAssistantWithError(errMsg);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            handleStreamEvent(JSON.parse(line));
          } catch {
            /* drop malformed line */
          }
        }
      }
    } catch (err) {
      replaceLastAssistantWithError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
      setMessages((m) =>
        m.map((msg, i) =>
          i === m.length - 1 && msg.role === "assistant"
            ? { ...msg, streaming: false }
            : msg,
        ),
      );
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function handleReset() {
    const id = getSessionId();
    if (id) {
      try {
        await fetch("/api/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: id }),
        });
      } catch {
        // best-effort; the local clear below is what matters
      }
    }
    clearSessionId();
    setMessages([]);
    textareaRef.current?.focus();
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">CinemaDaddy</h1>
        <button className="reset-btn" onClick={handleReset} type="button">
          Reset
        </button>
      </header>

      <main className="messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="welcome">
            <p>Ask about a movie or show — streaming, ratings, episodes, best of.</p>
          </div>
        )}
        {messages.map((m, i) => {
          if (m.role === "assistant") {
            const parts = m.parts ?? [];
            const lastIdx = parts.length - 1;
            const lastIsText = lastIdx >= 0 && parts[lastIdx]!.type === "text";
            return (
              <article key={i} className="message message--assistant">
                <div className="label label--assistant">CinemaDaddy</div>
                {parts.length === 0 && m.streaming && (
                  <div className="cursor-only">
                    <span className="cursor" aria-label="Streaming" />
                  </div>
                )}
                {parts.map((part, j) =>
                  part.type === "text" ? (
                    <div
                      key={j}
                      className={
                        "markdown" +
                        (m.streaming && j === lastIdx
                          ? " markdown--streaming"
                          : "")
                      }
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {part.text}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div key={j} className="tool-status">
                      <span className="tool-status__arrow">→</span>
                      <span className="tool-status__phrase">
                        {friendlyToolPhrase(part.name, part.input)}
                      </span>
                    </div>
                  ),
                )}
                {m.streaming && parts.length > 0 && !lastIsText && (
                  <div className="cursor-only">
                    <span className="cursor" aria-label="Streaming" />
                  </div>
                )}
              </article>
            );
          }
          return (
            <article key={i} className={`message message--${m.role}`}>
              {m.role === "user" && <div className="label label--user">You</div>}
              {m.role === "error" && (
                <div className="label label--error">Error</div>
              )}
              <div className="text">{m.text}</div>
            </article>
          );
        })}
      </main>

      <footer className="composer">
        <div className="composer__wrap">
          <textarea
            ref={textareaRef}
            className="composer__input"
            placeholder="Ask about a movie or show…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            rows={1}
            autoFocus
          />
          <button
            className="composer__send"
            onClick={() => void send()}
            disabled={!input.trim() || busy}
            aria-label="Send message"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 19V5M12 5L5 12M12 5L19 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
}
