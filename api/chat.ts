import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, type ChatEvent } from "../src/chat.js";
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

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

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
      void (async () => {
        try {
          await runTurn(anthropic, conversation, message, (e: ChatEvent) =>
            write(e),
          );
          write({ type: "done", conversation });
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
