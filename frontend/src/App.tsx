import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function parseYouTubeKey(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com") {
      if (u.pathname.startsWith("/embed/")) {
        return u.pathname.slice("/embed/".length) || null;
      }
      return u.searchParams.get("v");
    }
    if (host === "youtu.be") {
      return u.pathname.replace(/^\//, "") || null;
    }
    return null;
  } catch {
    return null;
  }
}

type HastImg = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: { src?: string };
};

function isTrailerHastNode(c: HastImg): boolean {
  if (c.type !== "element" || c.tagName !== "img") return false;
  const src = c.properties?.src;
  return typeof src === "string" && parseYouTubeKey(src) !== null;
}

const MARKDOWN_COMPONENTS: Components = {
  img: ({ src, alt }) => {
    if (typeof src === "string") {
      const key = parseYouTubeKey(src);
      if (key) {
        return (
          <div className="trailer">
            <iframe
              className="trailer__iframe"
              src={`https://www.youtube.com/embed/${key}`}
              title={alt || "Trailer"}
              loading="lazy"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        );
      }
    }
    return (
      <img
        className="poster"
        src={typeof src === "string" ? src : ""}
        alt={alt ?? ""}
        loading="lazy"
      />
    );
  },
  p: ({ children, node }) => {
    // hast inspection: paragraphs containing only image elements (plus
    // whitespace) get special handling — a single trailer image renders
    // bare (the iframe needs to escape the <p>); multiple images become
    // a flex grid; otherwise default <p>.
    const kids: HastImg[] =
      ((node as { children?: HastImg[] } | undefined)?.children ?? []);
    const imgKids = kids.filter(
      (c) => c.type === "element" && c.tagName === "img",
    );
    const onlyImagesOrWhitespace =
      imgKids.length >= 1 &&
      kids.every(
        (c) =>
          (c.type === "element" && c.tagName === "img") ||
          (c.type === "text" && !(c.value ?? "").trim()),
      );
    if (onlyImagesOrWhitespace) {
      const hasTrailer = imgKids.some(isTrailerHastNode);
      if (hasTrailer && imgKids.length === 1) {
        // Single trailer — render bare so the iframe div isn't nested in <p>.
        return <>{children}</>;
      }
      if (imgKids.length >= 2) {
        return <div className="poster-grid">{children}</div>;
      }
    }
    return <p>{children}</p>;
  },
};

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
  chips?: string[];
}

interface ServerEvent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  sessionId?: string;
  message?: string;
  chips?: string[];
}

const SESSION_KEY = "cinema-daddy-session";
const SIDEBAR_KEY = "cinema-daddy-sidebar-open";
const MAX_TEXTAREA_HEIGHT = 220;

const MOOD_SUGGESTIONS = [
  "Something cozy under 90 minutes on Netflix",
  "Best sci-fi I haven't heard of",
  "A thriller from the last 5 years",
  "Funny movie for tonight, under 2 hours",
];

function getSessionId() {
  return localStorage.getItem(SESSION_KEY);
}

function setSessionId(id: string) {
  localStorage.setItem(SESSION_KEY, id);
}

function clearSessionId() {
  localStorage.removeItem(SESSION_KEY);
}

function getInitialSidebarOpen(): boolean {
  // Mobile always starts with the drawer closed regardless of persisted desktop preference
  if (window.matchMedia("(max-width: 768px)").matches) return false;
  const stored = localStorage.getItem(SIDEBAR_KEY);
  return stored === null ? true : stored === "true";
}

function PanelIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <line
        x1="9.5"
        y1="5"
        x2="9.5"
        y2="19"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function PlusCircleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <line
        x1="12"
        y1="8"
        x2="12"
        y2="16"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <line
        x1="8"
        y1="12"
        x2="16"
        y2="12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
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
    case "get_cast_and_crew":
      return "Looking up cast & crew…";
    case "get_trailer":
      return "Finding the trailer…";
    case "discover_titles":
      return "Browsing the catalog…";
    default:
      return `Running ${name}…`;
  }
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(getInitialSidebarOpen);
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

  useEffect(() => {
    // Persist sidebar state on desktop only; mobile drawer always starts closed each session
    if (window.matchMedia("(min-width: 769px)").matches) {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    }
  }, [sidebarOpen]);

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
    if (ev.type === "followups" && Array.isArray(ev.chips)) {
      const chips = ev.chips
        .filter((c): c is string => typeof c === "string")
        .slice(0, 4);
      setMessages((m) => {
        const last = m[m.length - 1];
        if (!last || last.role !== "assistant") return m;
        return [...m.slice(0, -1), { ...last, chips }];
      });
      return;
    }
    if (ev.type === "error" && typeof ev.message === "string") {
      replaceLastAssistantWithError(ev.message);
      return;
    }
  }

  async function sendDirect(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
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

  async function send() {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setInput("");
    await sendDirect(trimmed);
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

  function handleNewChat() {
    // On mobile only: close the drawer so the user sees the fresh empty state
    if (window.matchMedia("(max-width: 768px)").matches) {
      setSidebarOpen(false);
    }
    void handleReset();
  }

  const isEmpty = messages.length === 0;

  return (
    <div className={`shell shell--sidebar-${sidebarOpen ? "open" : "closed"}`}>
      <aside className="sidebar" aria-label="Chat history">
        <div className="sidebar__expanded">
          <div className="sidebar__top">
            <h1 className="sidebar__brand">CinemaDaddy</h1>
            <button
              className="sidebar__close"
              onClick={() => setSidebarOpen(false)}
              type="button"
              aria-label="Collapse sidebar"
            >
              <PanelIcon />
            </button>
          </div>
          <button
            className="new-chat"
            onClick={handleNewChat}
            type="button"
          >
            <span className="new-chat__plus" aria-hidden="true">+</span>
            New Chat
          </button>
          <div className="sidebar__label">Recent</div>
          <div className="sidebar__history" aria-hidden="true" />
        </div>
        <div className="sidebar__mini" aria-hidden={sidebarOpen}>
          <button
            className="mini-btn"
            onClick={() => setSidebarOpen(true)}
            type="button"
            aria-label="Expand sidebar"
            tabIndex={sidebarOpen ? -1 : 0}
          >
            <PanelIcon />
          </button>
          <button
            className="mini-btn"
            onClick={handleNewChat}
            type="button"
            aria-label="New chat"
            tabIndex={sidebarOpen ? -1 : 0}
          >
            <PlusCircleIcon />
          </button>
        </div>
      </aside>
      <div
        className="shell__backdrop"
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <div className={`app${isEmpty ? " app--empty" : ""}`}>
        <button
          className="sidebar-trigger"
          onClick={() => setSidebarOpen(true)}
          type="button"
          aria-label="Open sidebar"
          aria-expanded={sidebarOpen}
        >
          <PanelIcon />
        </button>

        <div className="app__inner">
        <main className="messages" ref={messagesRef}>
        {messages.length === 0 && (
          <h2 className="greeting">What are we watching?</h2>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
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
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={MARKDOWN_COMPONENTS}
                      >
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
                {isLast && !m.streaming && m.chips && m.chips.length > 0 && (
                  <div className="chips">
                    {m.chips.map((c, k) => (
                      <button
                        key={k}
                        type="button"
                        className="chip"
                        onClick={() => void sendDirect(c)}
                      >
                        {c}
                      </button>
                    ))}
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
          <div className="composer__actions">
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
        </div>
      </footer>
      {isEmpty && (
        <div className="mood-suggestions">
          {MOOD_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="mood-chip"
              onClick={() => void sendDirect(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
