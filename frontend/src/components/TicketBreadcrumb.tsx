import type { CSSProperties } from "react";

// Tiny per-ticket settle rotation so a stack of tickets doesn't look
// ruler-aligned. Cycles through a short pattern keyed by the tool's
// position in its assistant turn.
const SETTLE_ROTATIONS = ["0.3deg", "-0.3deg", "0.2deg", "-0.25deg"] as const;

interface Props {
  label: string;
  index: number;
}

export default function TicketBreadcrumb({ label, index }: Props) {
  const style = {
    "--ticket-rot": SETTLE_ROTATIONS[index % SETTLE_ROTATIONS.length],
  } as CSSProperties;
  return (
    <div className="ticket-stub" style={style}>
      <span className="ticket-stub__phrase">{label}</span>
    </div>
  );
}
