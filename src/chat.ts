import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, HAIKU_MODEL } from "./anthropic.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { TOOL_SCHEMAS, dispatch } from "./tools/registry.js";

export type ChatEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "followups"; chips: string[] };

const FOLLOWUP_PROMPT = `You are generating follow-up question suggestions for a movie/TV chatbot called CinemaDaddy. The user has just received a response. Suggest 3 brief follow-up questions they might naturally want to ask next.

Each suggestion should:
- Be specific to the movie or TV show currently being discussed
- Cover a different angle than what was already answered
- Sound like how a person would actually ask (casual, 4-10 words)
- Be answerable by the assistant's available tools (streaming providers, IMDB rating, seasons, episodes, best-of, cast & crew, details)

Return ONLY a JSON array of strings. No surrounding text, no markdown fences, no explanation.

Example output:
["Where can I stream it?", "Top episodes of season 1?", "Who's in the cast?"]`;

const FOLLOWUP_TURN_LIMIT = 6;

type LooseBlock = { type: string; text?: string };

function conversationToText(
  convo: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingAssistant = "";
  const flushAssistant = () => {
    if (pendingAssistant) {
      out.push({ role: "assistant", content: pendingAssistant });
      pendingAssistant = "";
    }
  };
  for (const msg of convo) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        flushAssistant();
        out.push({ role: "user", content: msg.content });
      }
      // Array content on user messages = tool_result blocks; skip.
    } else {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content as LooseBlock[])
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("");
      pendingAssistant += text;
    }
  }
  flushAssistant();
  return out.slice(-FOLLOWUP_TURN_LIMIT);
}

function parseChips(raw: string): string[] {
  let candidate = raw.trim();
  candidate = candidate
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const tryParse = (s: string): string[] | null => {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (p): p is string => typeof p === "string" && p.trim().length > 0,
          )
          .slice(0, 4);
      }
    } catch {
      // fall through
    }
    return null;
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const match = candidate.match(/\[[\s\S]*?\]/);
  if (match) {
    const fromMatch = tryParse(match[0]);
    if (fromMatch) return fromMatch;
  }
  return [];
}

const TITLE_PROMPT = `Generate a very short title (3-5 words) for this CinemaDaddy chat. The title should name the specific movie or show the conversation is about, plus the subject (rating, cast, where to stream, etc.) when relevant.

Rules:
- Return ONLY the title text, on a single line, as plain text
- NO markdown formatting whatsoever — no **bold**, no ***, no ---, no #, no \`backticks\`, no italics, no bullets
- 3 to 5 words
- No quotes around the title, no trailing punctuation
- Title Case
- Be specific: Severance Season 2 Rating, Cast of The Bear, Sci-fi Recommendations
- Never generic (TV Show Question, Movie Chat)`;

export async function generateTitle(
  client: Anthropic,
  conversation: Anthropic.MessageParam[],
): Promise<string | null> {
  try {
    const messages = conversationToText(conversation);
    if (messages.length === 0) return null;
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 30,
      system: TITLE_PROMPT,
      messages,
    });
    const text = (response.content as LooseBlock[])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    // Take only the first non-empty line in case Haiku adds an explanation
    // after the title.
    const firstLine =
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";
    // Aggressive markdown / quote / punctuation scrub. Order matters:
    // strip emphasis pairs first (preserving inner text), then strip any
    // stray markers left over.
    const cleaned = firstLine
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^[#>\-*=`~|]+\s*/, "")
      .replace(/\s*[\-=]{2,}\s*/g, " ")
      .replace(/[*_`~]/g, "")
      .replace(/^["'“”‘’]+/, "")
      .replace(/["'“”‘’]+$/, "")
      .replace(/[.!?]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return null;
    return cleaned.length > 60 ? cleaned.slice(0, 60).trimEnd() + "…" : cleaned;
  } catch {
    return null;
  }
}

async function generateFollowups(
  client: Anthropic,
  conversation: Anthropic.MessageParam[],
): Promise<string[]> {
  try {
    const messages = conversationToText(conversation);
    if (messages.length === 0) return [];
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 200,
      system: FOLLOWUP_PROMPT,
      messages,
    });
    const text = (response.content as LooseBlock[])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return parseChips(text);
  } catch {
    return [];
  }
}

export async function runTurn(
  client: Anthropic,
  conversation: Anthropic.MessageParam[],
  userInput: string,
  emit: (event: ChatEvent) => void,
): Promise<void> {
  conversation.push({ role: "user", content: userInput });

  while (true) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOL_SCHEMAS,
      messages: conversation,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        emit({ type: "text_delta", text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    conversation.push({ role: "assistant", content: final.content });

    if (final.stop_reason !== "tool_use") break;

    const toolUseBlocks = final.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    for (const b of toolUseBlocks) {
      emit({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      });
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (b) => {
        try {
          const result = await dispatch(
            b.name,
            b.input as Record<string, unknown>,
          );
          return {
            type: "tool_result",
            tool_use_id: b.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          return {
            type: "tool_result",
            tool_use_id: b.id,
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
            is_error: true,
          };
        }
      }),
    );

    conversation.push({ role: "user", content: toolResults });
  }

  const chips = await generateFollowups(client, conversation);
  emit({ type: "followups", chips });
}
