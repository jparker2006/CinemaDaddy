import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-sonnet-4-6";

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "ANTHROPIC_API_KEY is not set; /api/chat requests will fail until it is.",
  );
}

export const anthropic = new Anthropic();
