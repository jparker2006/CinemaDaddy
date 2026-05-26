import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";

export default function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;

  const metadata = user.user_metadata as
    | { full_name?: string; avatar_url?: string }
    | undefined;
  const avatarUrl =
    typeof metadata?.avatar_url === "string" ? metadata.avatar_url : null;
  const fullName =
    typeof metadata?.full_name === "string" ? metadata.full_name : null;
  const displayName = fullName || user.email || "Signed in";
  const initial = (displayName[0] || "?").toUpperCase();

  async function handleSignOut() {
    setOpen(false);
    await signOut();
    // AuthProvider's onAuthStateChange fires → ProtectedRoute redirects
    // to /login. No explicit navigate needed here.
  }

  return (
    <div className="user-menu" ref={ref}>
      {open && (
        <div className="user-menu__panel" role="menu">
          <div className="user-menu__identity">
            <div className="user-menu__name">{displayName}</div>
            {user.email && fullName ? (
              <div className="user-menu__email">{user.email}</div>
            ) : null}
          </div>
          <button
            className="user-menu__signout"
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
          >
            Sign out
          </button>
        </div>
      )}
      <button
        className="user-menu__trigger"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {avatarUrl ? (
          <img
            className="user-menu__avatar"
            src={avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="user-menu__avatar user-menu__avatar--initial">
            {initial}
          </span>
        )}
        <span className="user-menu__display">{displayName}</span>
      </button>
    </div>
  );
}
