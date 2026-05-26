// Loose mirror of @anthropic-ai/sdk's MessageParam shape, used as the
// canonical conversation representation on the client. We round-trip this
// shape into /api/chat (server-side runTurn) and into the messages.content
// jsonb column verbatim.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export type MessageParam =
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: string | ContentBlock[] };

export type AssistantPart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; parts: AssistantPart[]; streaming?: boolean }
  | { kind: "error"; text: string };

export type StreamingTurn = { userText: string; parts: AssistantPart[] };

export interface ServerEvent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  message?: string;
  chips?: string[];
  conversation?: MessageParam[];
  title?: string;
}
