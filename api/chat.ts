import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, generateTitle, type ChatEvent } from "../src/chat.js";
import { anthropic } from "../src/anthropic.js";

export const config = { maxDuration: 60 };

interface RequestBody {
  message?: unknown;
  conversation?: unknown;
}

function isMessageParamArray(x: unknown): x is Anthropic.MessageParam[] {
  if (!Array.isArray(x)) return false;
  for (const item of x) {
    if (!item || typeof item !== "object") return false;
    const role = (item as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") return false;
  }
  return true;
}

// Named-method export — Vercel routes POST /api/chat here.
// `export default` would bind to the legacy (req, res) Node signature
// and ignore a returned Response; the named-method export uses the
// Web Request/Response style.
export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const message = body.message;
  const conversation: Anthropic.MessageParam[] = isMessageParamArray(
    body.conversation,
  )
    ? body.conversation
    : [];
  if (typeof message !== "string" || !message.trim()) {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // controller already closed; ignore
        }
      };
      // fire-and-forget: the controller stays open across this async work,
      // events stream out as they're produced
      // Captured before runTurn mutates `conversation` — used below to
      // decide whether we should also generate a Haiku-powered title.
      const isFirstTurn = conversation.length === 0;

      void (async () => {
        try {
          await runTurn(anthropic, conversation, message, (e: ChatEvent) =>
            write(e),
          );
          let title: string | undefined;
          if (isFirstTurn) {
            const generated = await generateTitle(anthropic, conversation);
            title = generated ?? undefined;
          }
          write({ type: "done", conversation, title });
        } catch (err) {
          console.error("/api/chat error:", err);
          write({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
