import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  deleteConversation,
  listConversations,
  setStarred,
  type ConversationRow,
} from "../lib/db";

function KebabIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="8" cy="3" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="8" cy="13" r="1.4" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.5l1.95 4.34 4.55.5-3.43 3.18.99 4.48L8 11.7l-4.06 2.3.99-4.48L1.5 6.34l4.55-.5z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.4}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M3.75 4l.65 9.2a1 1 0 0 0 1 .8h5.2a1 1 0 0 0 1-.8L12.25 4" />
      <path d="M6.5 7v4" />
      <path d="M9.5 7v4" />
    </svg>
  );
}

interface Props {
  version: number;
  onChange: () => void;
}

export default function ConversationList({ version, onChange }: Props) {
  const navigate = useNavigate();
  const { conversationId: activeId } = useParams<{ conversationId: string }>();
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    listConversations()
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Close the open kebab menu on outside click or Escape.
  useEffect(() => {
    if (!openMenuId) return;
    function onMouseDown(e: MouseEvent) {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenuId(null);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenuId]);

  async function handleStar(row: ConversationRow) {
    setOpenMenuId(null);
    try {
      await setStarred(row.id, !row.starred);
      onChange();
    } catch {
      /* swallow — UI just won't update */
    }
  }

  async function handleDelete(row: ConversationRow) {
    setOpenMenuId(null);
    const label = row.title?.trim() || "this chat";
    if (!window.confirm(`Delete "${label}"? This can't be undone.`)) return;
    try {
      await deleteConversation(row.id);
      // If the deleted conversation is the one currently being viewed,
      // bounce to the empty-state.
      if (activeId === row.id) navigate("/", { replace: true });
      onChange();
    } catch {
      /* swallow */
    }
  }

  if (rows.length === 0) return null;

  const starred = rows.filter((r) => r.starred);
  const others = rows.filter((r) => !r.starred);

  function renderRow(row: ConversationRow) {
    const isMenuOpen = openMenuId === row.id;
    return (
      <li key={row.id} className="conversation-list__row">
        <NavLink
          to={`/chat/${row.id}`}
          className={({ isActive }) =>
            "conversation-list__item" +
            (isActive ? " conversation-list__item--active" : "")
          }
        >
          <span className="conversation-list__title">
            {row.title?.trim() || "Untitled chat"}
          </span>
        </NavLink>
        <button
          className="conversation-list__menu-btn"
          type="button"
          aria-label="Conversation actions"
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpenMenuId((id) => (id === row.id ? null : row.id));
          }}
        >
          <KebabIcon />
        </button>
        {isMenuOpen && (
          <div className="conversation-list__menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="conversation-list__menu-item"
              onClick={() => void handleStar(row)}
            >
              <StarIcon filled={!row.starred} />
              {row.starred ? "Unstar" : "Star"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="conversation-list__menu-item conversation-list__menu-item--danger"
              onClick={() => void handleDelete(row)}
            >
              <TrashIcon />
              Delete
            </button>
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="conversation-list" ref={listRef}>
      {starred.length > 0 && (
        <>
          <div className="conversation-list__section-label">Starred</div>
          <ul className="conversation-list__group">{starred.map(renderRow)}</ul>
        </>
      )}
      {others.length > 0 && (
        <>
          <div className="conversation-list__section-label">Recent</div>
          <ul className="conversation-list__group">{others.map(renderRow)}</ul>
        </>
      )}
    </div>
  );
}
