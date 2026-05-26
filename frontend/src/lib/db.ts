import { supabase } from "./supabase";
import type { MessageParam } from "./types";

export interface ConversationRow {
  id: string;
  title: string | null;
  starred: boolean;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  role: "user" | "assistant";
  content: MessageParam["content"];
  sequence: number;
}

export async function createConversation(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, title: null })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function insertMessages(
  conversationId: string,
  rows: MessageRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const payload = rows.map((r) => ({
    conversation_id: conversationId,
    role: r.role,
    content: r.content,
    sequence: r.sequence,
  }));
  const { error } = await supabase.from("messages").insert(payload);
  if (error) throw error;
}

export async function updateConversation(
  conversationId: string,
  patch: { title?: string },
): Promise<void> {
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.title !== undefined) update.title = patch.title;
  const { error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", conversationId);
  if (error) throw error;
}

export async function deleteConversation(
  conversationId: string,
): Promise<void> {
  // Cascading FK on messages.conversation_id removes all messages.
  await supabase.from("conversations").delete().eq("id", conversationId);
}

export async function deleteMessage(
  conversationId: string,
  sequence: number,
): Promise<void> {
  await supabase
    .from("messages")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("sequence", sequence);
}

export async function loadMessages(
  conversationId: string,
): Promise<MessageParam[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("sequence", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.content as MessageParam["content"],
  })) as MessageParam[];
}

export async function listConversations(): Promise<ConversationRow[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, starred, created_at, updated_at")
    .order("starred", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as ConversationRow[];
}

export async function setStarred(
  conversationId: string,
  starred: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("conversations")
    .update({ starred })
    .eq("id", conversationId);
  if (error) throw error;
}

export function deriveTitle(firstUserText: string): string {
  const trimmed = firstUserText.trim();
  if (trimmed.length <= 30) return trimmed;
  return trimmed.slice(0, 30).trimEnd() + "…";
}
