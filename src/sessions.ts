import type Anthropic from "@anthropic-ai/sdk";

type Conversation = Anthropic.MessageParam[];

const store = new Map<string, Conversation>();

export function getOrCreate(sessionId: string): Conversation {
  let convo = store.get(sessionId);
  if (!convo) {
    convo = [];
    store.set(sessionId, convo);
  }
  return convo;
}

export function reset(sessionId: string | undefined): void {
  if (sessionId) store.delete(sessionId);
}
