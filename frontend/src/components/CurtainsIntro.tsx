import { useEffect, useState } from "react";

const SESSION_KEY = "curtains_played_this_session";
const ANIMATION_MS = 1800;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function CurtainsIntro() {
  const [shouldRender, setShouldRender] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    if (sessionStorage.getItem(SESSION_KEY)) return false;
    if (prefersReducedMotion()) {
      sessionStorage.setItem(SESSION_KEY, "1");
      return false;
    }
    return true;
  });
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!shouldRender) return;
    // Mark as played up front so a refresh mid-animation doesn't replay.
    sessionStorage.setItem(SESSION_KEY, "1");
    // Two rAFs: first commits the initial closed frame, second flips the
    // class so the transition animates from closed → open instead of
    // snapping to the open state on first paint.
    let r2: number | null = null;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setOpening(true));
    });
    const t = window.setTimeout(() => setShouldRender(false), ANIMATION_MS + 80);
    return () => {
      cancelAnimationFrame(r1);
      if (r2 !== null) cancelAnimationFrame(r2);
      window.clearTimeout(t);
    };
  }, [shouldRender]);

  if (!shouldRender) return null;

  return (
    <div
      className={`curtains${opening ? " curtains--open" : ""}`}
      aria-hidden="true"
    >
      <div className="curtains__panel curtains__panel--left">
        <div className="curtains__valance" />
        <div className="curtains__trim" />
      </div>
      <div className="curtains__panel curtains__panel--right">
        <div className="curtains__valance" />
        <div className="curtains__trim" />
      </div>
    </div>
  );
}
