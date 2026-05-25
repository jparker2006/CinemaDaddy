import type Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./anthropic.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { TOOL_SCHEMAS, dispatch } from "./tools/registry.js";

export type ChatEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

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
}
