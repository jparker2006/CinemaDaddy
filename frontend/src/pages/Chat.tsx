import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuth } from "../lib/auth";
import ConversationList from "../components/ConversationList";
import UserMenu from "../components/UserMenu";
import {
  createConversation,
  deleteConversation,
  deleteMessage,
  insertMessages,
  loadMessages,
  updateConversation,
  deriveTitle,
} from "../lib/db";
import type {
  AssistantPart,
  DisplayItem,
  MessageParam,
  ServerEvent,
  StreamingTurn,
} from "../lib/types";

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
        return <>{children}</>;
      }
      if (imgKids.length >= 2) {
        return <div className="poster-grid">{children}</div>;
      }
    }
    return <p>{children}</p>;
  },
};

const SIDEBAR_KEY = "cinema-daddy-sidebar-open";
const MAX_TEXTAREA_HEIGHT = 220;

const MOOD_SUGGESTIONS = [
  "Something cozy under 90 minutes on Netflix",
  "Best sci-fi I haven't heard of",
  "A thriller from the last 5 years",
  "Funny movie for tonight, under 2 hours",
];

function getInitialSidebarOpen(): boolean {
  if (window.matchMedia("(max-width: 768px)").matches) return false;
  const stored = localStorage.getItem(SIDEBAR_KEY);
  return stored === null ? true : stored === "true";
}

function deriveDisplay(
  conversation: MessageParam[],
  streamingTurn: StreamingTurn | null,
  errorMessage: string | null,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of conversation) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        items.push({ kind: "user", text: msg.content });
      }
      // user-role messages whose content is an array are tool_result blocks
      // (internal plumbing) — skip
    } else if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const parts: AssistantPart[] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({
            type: "tool",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
        // tool_result is user-role only; assistant blocks include text + tool_use
      }
      if (parts.length > 0) items.push({ kind: "assistant", parts });
    }
  }
  if (streamingTurn) {
    items.push({ kind: "user", text: streamingTurn.userText });
    items.push({ kind: "assistant", parts: streamingTurn.parts, streaming: true });
  }
  if (errorMessage) {
    items.push({ kind: "error", text: errorMessage });
  }
  return items;
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

export default function Chat() {
  const navigate = useNavigate();
  const { conversationId: urlConversationId } = useParams<{ conversationId: string }>();
  const { user } = useAuth();

  const [conversation, setConversation] = useState<MessageParam[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(
    urlConversationId ?? null,
  );
  const [streamingTurn, setStreamingTurn] = useState<StreamingTurn | null>(null);
  const [latestChips, setLatestChips] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(getInitialSidebarOpen);
  // Bumped after every successful send so `<ConversationList />` refetches.
  const [sidebarVersion, setSidebarVersion] = useState(0);
  // True while we're fetching a conversation from the DB after a route
  // change. Suppresses the empty-state UI (greeting + mood chips) so we
  // don't flash it between conversations.
  const [isHydrating, setIsHydrating] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tracks which conversation id we've already loaded into state, so the
  // hydration effect below skips refetching after `sendDirect` populates
  // state directly from the server's `done` event.
  const loadedConvIdRef = useRef<string | null>(null);

  const displayed = useMemo(
    () => deriveDisplay(conversation, streamingTurn, errorMessage),
    [conversation, streamingTurn, errorMessage],
  );

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayed.length, streamingTurn]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
  }, [input]);

  useEffect(() => {
    if (window.matchMedia("(min-width: 769px)").matches) {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    }
  }, [sidebarOpen]);

  // On mobile, auto-close the sidebar drawer when the URL's conversationId
  // changes (sidebar item tapped, programmatic navigate, etc.).
  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) {
      setSidebarOpen(false);
    }
  }, [urlConversationId]);

  // Hydrate `conversation` state from the DB whenever the URL's
  // conversationId changes (refresh, sidebar click, browser back/forward).
  // sendDirect bypasses this fetch by setting loadedConvIdRef before
  // navigating, so we don't redundantly refetch right after a send.
  useEffect(() => {
    if (!user) return;

    // No /:conversationId in the URL — we're on `/`. Reset state and
    // bail; the empty-state UI handles rendering.
    if (!urlConversationId) {
      if (loadedConvIdRef.current !== null) {
        setConversation([]);
        setConversationId(null);
        setStreamingTurn(null);
        setLatestChips([]);
        setErrorMessage(null);
        loadedConvIdRef.current = null;
      }
      setIsHydrating(false);
      return;
    }

    // Already showing this conversation in state — skip the fetch.
    if (loadedConvIdRef.current === urlConversationId) {
      setIsHydrating(false);
      return;
    }

    // Different conversation — clear current view, then load from DB.
    // `isHydrating` suppresses the empty-state greeting + mood chips
    // during the brief fetch so we don't flash them between conversations.
    setIsHydrating(true);
    setConversation([]);
    setStreamingTurn(null);
    setLatestChips([]);
    setErrorMessage(null);

    let cancelled = false;
    (async () => {
      try {
        const rows = await loadMessages(urlConversationId);
        if (cancelled) return;
        if (rows.length === 0) {
          // RLS hid it, it was deleted, or the id is bogus — bounce home.
          setIsHydrating(false);
          navigate("/", { replace: true });
          return;
        }
        setConversation(rows);
        setConversationId(urlConversationId);
        loadedConvIdRef.current = urlConversationId;
        setIsHydrating(false);
      } catch {
        if (cancelled) return;
        setIsHydrating(false);
        navigate("/", { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [urlConversationId, user, navigate]);

  function handleStreamEvent(ev: ServerEvent) {
    if (ev.type === "text_delta" && typeof ev.text === "string") {
      const delta = ev.text;
      setStreamingTurn((t) => {
        if (!t) return t;
        const parts = [...t.parts];
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.type === "text") {
          parts[parts.length - 1] = {
            type: "text",
            text: lastPart.text + delta,
          };
        } else {
          parts.push({ type: "text", text: delta });
        }
        return { ...t, parts };
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
      setStreamingTurn((t) => (t ? { ...t, parts: [...t.parts, tool] } : t));
      return;
    }
    if (ev.type === "followups" && Array.isArray(ev.chips)) {
      const chips = ev.chips
        .filter((c): c is string => typeof c === "string")
        .slice(0, 4);
      setLatestChips(chips);
      return;
    }
    // `done` is handled inline in sendDirect so the DB writes can `await`
    // before clearing state. (See sendDirect.)
    if (ev.type === "error" && typeof ev.message === "string") {
      setErrorMessage(ev.message);
      setStreamingTurn(null);
      return;
    }
  }

  async function sendDirect(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (!user) {
      setErrorMessage("Not signed in.");
      return;
    }
    setBusy(true);
    setLatestChips([]);
    setErrorMessage(null);
    setStreamingTurn({ userText: trimmed, parts: [] });

    // Sequence we'll assign to the user message we're about to insert.
    const userSequence = conversation.length;
    let convId = conversationId;
    const isFirstTurn = convId === null;

    try {
      // 1. Create the conversation row on the first turn so we have an id
      //    to attach messages to. URL updates immediately so a refresh
      //    mid-stream still leaves the conversation discoverable.
      if (convId === null) {
        convId = await createConversation(user.id);
        setConversationId(convId);
        // Mark as already loaded so the hydration effect skips refetching
        // when the URL changes on the next line.
        loadedConvIdRef.current = convId;
        navigate(`/chat/${convId}`, { replace: true });
      }

      // 2. Persist the user message before posting. If the server fails
      //    or the user closes the tab mid-stream, at least their input is
      //    saved in the DB.
      await insertMessages(convId, [
        { role: "user", content: trimmed, sequence: userSequence },
      ]);

      // 3. POST to the streaming chat endpoint. `conversation` is the
      //    history BEFORE this turn; the server appends the user message
      //    and the assistant turns inside runTurn.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, conversation }),
      });

      if (!res.ok || !res.body) {
        let errMsg = `Error ${res.status}`;
        try {
          const data = await res.json();
          if (data?.error) errMsg = data.error;
        } catch {
          /* ignore */
        }
        throw new Error(errMsg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Track the full conversation that came back in the `done` event.
      // We commit DB writes AFTER the stream loop ends, not inline, so
      // the UI clears its streaming cursor the moment `done` arrives
      // even if the DB writes are still in flight.
      let finalConv: MessageParam[] | null = null;
      // Optional Haiku-generated title from the server (first-turn only).
      let finalTitle: string | null = null;

      const processEvent = (ev: ServerEvent): void => {
        if (ev.type === "done" && Array.isArray(ev.conversation)) {
          finalConv = ev.conversation as MessageParam[];
          if (typeof ev.title === "string" && ev.title.trim()) {
            finalTitle = ev.title.trim();
          }
          setConversation(finalConv);
          setStreamingTurn(null);
          return;
        }
        handleStreamEvent(ev);
      };

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
            processEvent(JSON.parse(line) as ServerEvent);
          } catch {
            /* drop malformed line */
          }
        }
      }
      // Flush any trailing line that didn't end in \n — some upstream
      // proxies (and `vercel dev`'s emulator on older CLI versions)
      // close the connection without the final newline.
      const tail = buffer.trim();
      if (tail) {
        try {
          processEvent(JSON.parse(tail) as ServerEvent);
        } catch {
          /* drop malformed trailing line */
        }
      }

      if (finalConv === null) {
        throw new Error(
          "Server closed the connection before completing the turn.",
        );
      }

      // Now that streaming is fully done and the UI has cleared, persist
      // the assistant turn(s) to the DB. We already inserted the user
      // message before POSTing, so we only insert rows from
      // userSequence+1 onward.
      const newServerRows = (finalConv as MessageParam[])
        .slice(userSequence + 1)
        .map((m, i) => ({
          role: m.role,
          content: m.content,
          sequence: userSequence + 1 + i,
        }));
      await insertMessages(convId, newServerRows);
      // First turn: prefer the Haiku-generated title from the server,
      // falling back to first-30-chars if the server didn't supply one
      // (older deploys, Haiku rate limit, etc.). Later turns just bump
      // updated_at via updateConversation's set of new Date().
      await updateConversation(convId, {
        title: isFirstTurn
          ? (finalTitle ?? deriveTitle(trimmed))
          : undefined,
      });
      // Re-fetch the sidebar list: new title appears (first turn) or the
      // active conversation rises to the top (every turn bumps updated_at).
      setSidebarVersion((v) => v + 1);
    } catch (err) {
      // Roll back DB writes for this turn so the next attempt has a
      // clean sequence number. If the whole conversation was just
      // created this turn, drop it entirely (cascading delete clears
      // the user msg too).
      if (convId !== null) {
        try {
          if (isFirstTurn) {
            await deleteConversation(convId);
            setConversationId(null);
            loadedConvIdRef.current = null;
            navigate("/", { replace: true });
          } else {
            await deleteMessage(convId, userSequence);
          }
        } catch {
          /* swallow cleanup errors — the UI error message is the
             primary signal to the user */
        }
      }
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStreamingTurn(null);
    } finally {
      setBusy(false);
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

  function handleNewChat() {
    if (window.matchMedia("(max-width: 768px)").matches) {
      setSidebarOpen(false);
    }
    setConversation([]);
    setStreamingTurn(null);
    setLatestChips([]);
    setErrorMessage(null);
    setConversationId(null);
    loadedConvIdRef.current = null;
    navigate("/");
    textareaRef.current?.focus();
  }

  const isEmpty =
    conversation.length === 0 &&
    !streamingTurn &&
    !errorMessage &&
    !isHydrating;

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
          <div className="sidebar__history">
            <ConversationList
              version={sidebarVersion}
              onChange={() => setSidebarVersion((v) => v + 1)}
            />
          </div>
          <UserMenu />
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

        <main className="messages" ref={messagesRef}>
          <div className="messages__column">
            {isEmpty && (
              <h2 className="greeting">What are we watching?</h2>
            )}
            {displayed.map((item, i) => {
              const isLast = i === displayed.length - 1;
              if (item.kind === "assistant") {
                const parts = item.parts;
                const lastIdx = parts.length - 1;
                const lastIsText =
                  lastIdx >= 0 && parts[lastIdx]!.type === "text";
                return (
                  <article key={i} className="message message--assistant">
                    <div className="label label--assistant">CinemaDaddy</div>
                    {parts.length === 0 && item.streaming && (
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
                            (item.streaming && j === lastIdx
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
                    {item.streaming && parts.length > 0 && !lastIsText && (
                      <div className="cursor-only">
                        <span className="cursor" aria-label="Streaming" />
                      </div>
                    )}
                    {isLast &&
                      !item.streaming &&
                      latestChips.length > 0 && (
                        <div className="chips">
                          {latestChips.map((c, k) => (
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
              if (item.kind === "user") {
                return (
                  <article key={i} className="message message--user">
                    <div className="label label--user">You</div>
                    <div className="text">{item.text}</div>
                  </article>
                );
              }
              return (
                <article key={i} className="message message--error">
                  <div className="label label--error">Error</div>
                  <div className="text">{item.text}</div>
                </article>
              );
            })}
          </div>
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
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
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
  );
}
