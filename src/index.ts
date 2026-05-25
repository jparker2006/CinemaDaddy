import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { runTurn, type ChatEvent } from "./chat.js";
import { anthropic } from "./anthropic.js";
import { getOrCreate, reset } from "./sessions.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/api/chat", async (req, res) => {
  const { sessionId: incoming, message } = (req.body ?? {}) as {
    sessionId?: string;
    message?: unknown;
  };
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const sessionId = incoming ?? randomUUID();
  const conversation = getOrCreate(sessionId);

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const writeEvent = (obj: Record<string, unknown>) => {
    res.write(JSON.stringify(obj) + "\n");
  };

  writeEvent({ type: "session", sessionId });

  try {
    await runTurn(anthropic, conversation, message, (e: ChatEvent) =>
      writeEvent(e),
    );
    writeEvent({ type: "done" });
  } catch (err) {
    console.error("/api/chat error:", err);
    writeEvent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    res.end();
  }
});

app.post("/api/reset", (req, res) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  reset(sessionId);
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`CinemaDaddy http://localhost:${port}`);
});
