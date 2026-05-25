# CinemaDaddy — Implementation Plan

## Context

You're building a chatbot ("CinemaDaddy") that answers questions about movies and TV shows by driving Claude's tool-use loop against TMDB and OMDb. The chatbot runs in the browser as a simple web chat UI, served by a small Express server in Node. The point is to practice the Anthropic tool-use pattern end-to-end on a small, self-contained problem — not to ship a product. State lives in memory on the server, keyed by a per-browser session id; no database, no auth, no build step for the frontend.

Responses are **request/response** in v1 (the browser waits for the full reply). Token streaming via SSE is a v2 nicety.

---

## 1. Project Structure

```
CinemaDaddy/
├── .env.example                 # ANTHROPIC_API_KEY, TMDB_BEARER_TOKEN, OMDB_API_KEY, STREAMING_REGION, PORT
├── .gitignore                   # node_modules, .env, dist
├── package.json                 # scripts: "dev" (tsx watch), "start" (tsx)
├── tsconfig.json                # strict ESM TS, target ES2022, module NodeNext
├── README.md                    # setup + run instructions
├── PLAN.md                      # this plan
├── public/                      # static frontend, no build step
│   ├── index.html               # chat page markup
│   ├── styles.css               # chat styling
│   └── chat.js                  # vanilla JS: form submit, fetch /api/chat, render, persist sessionId in localStorage
└── src/
    ├── index.ts                 # entry: dotenv, Express app, static /public, POST /api/chat + /api/reset, listen on PORT
    ├── chat.ts                  # tool-use loop: runTurn(client, conversation, userInput) -> assistant text
    ├── sessions.ts              # in-memory Map<sessionId, MessageParam[]>
    ├── anthropic.ts             # Anthropic SDK client + model id
    ├── systemPrompt.ts          # the system prompt string
    ├── types.ts                 # shared types (TmdbSearchHit, OmdbRating, etc.)
    ├── cache.ts                 # tiny per-process Map<string, unknown> for TMDB/OMDb URL → payload
    ├── clients/
    │   ├── tmdb.ts              # fetch wrapper: bearer auth, baseURL, cache, error mapping
    │   └── omdb.ts              # fetch wrapper: apikey, daily-limit detection, cache
    └── tools/
        ├── registry.ts          # exports TOOL_SCHEMAS array + dispatch(name, input) → result
        ├── searchTitle.ts
        ├── getDetails.ts
        ├── getStreamingProviders.ts
        ├── getImdbRating.ts
        ├── getShowSeasons.ts
        ├── getSeasonEpisodes.ts
        └── getBestEpisodes.ts
```

Why this shape: server-side state, stateless-looking client. The browser sends `{ sessionId, message }`; the server keeps the conversation array per session in memory and runs the whole tool-use loop synchronously inside one HTTP request, returning the final assistant text. The tool layer (clients + tools + registry) is identical to what a CLI version would have used — only the entry point changes.

---

## 2. Dependencies

Runtime:
- `@anthropic-ai/sdk` — `^0.98` (installed)
- `dotenv` — `^17` (installed)
- `express` — `^5` (HTTP server, static file serving, JSON body parsing)

Dev:
- `typescript` — `^6` (installed)
- `@types/node` — `^25` (installed)
- `@types/express` — `^5`
- `tsx` — `^4` (installed)

`package.json` scripts:
- `"start": "tsx src/index.ts"`
- `"dev": "tsx watch src/index.ts"`
- `"typecheck": "tsc --noEmit"`

Node version: 20+ (native `fetch`, `crypto.randomUUID()`). Frontend has no build step — plain HTML/CSS/JS served from `public/`.

---

## 3. API Research

### 3.1 TMDB (themoviedb.org/documentation/api)

**Auth:** v4 bearer token in `Authorization: Bearer <token>` header. (Free; you sign up, get an API Read Access Token.) Don't use the legacy v3 `api_key=` query param — bearer works for the v3 endpoints below and is what TMDB recommends now.

**Base URL:** `https://api.themoviedb.org/3`

**Rate limit:** TMDB removed their hard rate limit in late 2023 but asks you to stay reasonable (~50 req/sec is the unofficial ceiling). For this app you'll be well under it. No retry/backoff needed for v1.

**Endpoints we need:**

| Use case | Endpoint | Notes |
|---|---|---|
| Search any media | `GET /search/multi?query={q}&include_adult=false` | Returns mixed movie/tv/person; filter `media_type !== "person"`. Use when the user didn't specify movie vs TV. |
| Search movie | `GET /search/movie?query={q}&year={y}` | Use when user specified movie or you need to disambiguate by year. |
| Search TV | `GET /search/tv?query={q}&first_air_date_year={y}` | Same, for shows. |
| Movie details | `GET /movie/{id}?append_to_response=external_ids` | `external_ids.imdb_id` is the `tt...` id for OMDb. |
| TV details | `GET /tv/{id}?append_to_response=external_ids` | Returns `seasons[]`, `last_air_date`, `last_episode_to_air`, `number_of_seasons`, `status`. |
| Streaming providers (movie) | `GET /movie/{id}/watch/providers` | Returns `results.{REGION}.{flatrate, rent, buy, ads}`. |
| Streaming providers (TV) | `GET /tv/{id}/watch/providers` | Same shape. Data is licensed from JustWatch — include their attribution string in any UI that displays it (a comment in code is fine; not user-visible required for this app). |
| Season episodes | `GET /tv/{id}/season/{n}` | `episodes[]` with `episode_number`, `name`, `air_date`, `vote_average`, `vote_count`, `overview`. |

**Example search response (truncated):**
```json
{
  "page": 1,
  "results": [
    {
      "id": 95396,
      "media_type": "tv",
      "name": "Severance",
      "first_air_date": "2022-02-17",
      "overview": "Mark leads a team...",
      "popularity": 142.3,
      "vote_average": 8.4
    }
  ]
}
```

**Example watch/providers response (truncated):**
```json
{
  "id": 95396,
  "results": {
    "US": {
      "link": "https://www.themoviedb.org/tv/95396/watch?locale=US",
      "flatrate": [{ "provider_id": 350, "provider_name": "Apple TV+", "logo_path": "/..." }]
    },
    "GB": { "...": "..." }
  }
}
```

**Gotchas:**
- `vote_average` of `0` usually means "no votes yet" (unaired or brand new). Filter with `vote_count >= 50` before calling something a "best episode".
- TV shows have a "Season 0" for specials — exclude `season_number === 0` when computing best episodes.
- `search/multi` returns `person` results — filter them out.
- For shows that haven't aired yet, `last_episode_to_air` is `null` — handle it.
- TMDB does serve IMDB ids for most titles but a few obscure ones lack them; fall back to OMDb title+year search in that case.

### 3.2 OMDb (omdbapi.com)

**Auth:** `apikey` query param. Free tier: **1,000 requests/day**. Hitting the limit returns `{"Response":"False","Error":"Request limit reached!"}` with HTTP 200 — you must check `Response === "False"`, not the status code.

**Base URL:** `https://www.omdbapi.com/`

**Endpoints we need:**

| Use case | URL | Notes |
|---|---|---|
| Lookup by IMDB id | `?i=tt3896198&apikey=...` | Preferred. Get `tt` id from TMDB external_ids. |
| Lookup by title | `?t={title}&y={year}&type={movie|series}&apikey=...` | Fallback when no IMDB id. |

**Example response (truncated):**
```json
{
  "Title": "The Bear",
  "Year": "2022–",
  "imdbRating": "8.6",
  "imdbVotes": "152,341",
  "imdbID": "tt14452776",
  "Type": "series",
  "Response": "True"
}
```

**Gotchas:**
- `imdbRating` is a string, not a number. Parse before comparing.
- `"N/A"` is a sentinel value for missing fields — check before parsing.
- Daily limit resets at 00:00 UTC. When tripped, surface a graceful error to Claude as a tool_result so it can fall back to TMDB's `vote_average`.
- OMDb episode-level ratings exist (`?i=tt...&Season=1`) but are slower and rate-limit-hungry. Use TMDB per-episode `vote_average` instead — fine for v1.

---

## 4. Tool Definitions

All tools return JSON-serializable objects. Errors are returned as `{ error: string }` so Claude can recover gracefully rather than crashing the loop.

### 4.1 `search_title`
```json
{
  "name": "search_title",
  "description": "Search TMDB for a movie or TV show by title. Use this first when the user mentions a title and you don't already have its tmdb_id. Returns up to 5 matches ordered by popularity, each with year and overview so the user can disambiguate.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "The title to search for." },
      "media_type": { "type": "string", "enum": ["movie", "tv", "any"], "default": "any" },
      "year": { "type": "integer", "description": "Optional release year / first-air year to narrow results." }
    },
    "required": ["query"]
  }
}
```
Output: `{ results: Array<{ tmdb_id: number; media_type: "movie"|"tv"; title: string; year: number|null; overview: string; popularity: number }> }`

### 4.2 `get_details`
```json
{
  "name": "get_details",
  "description": "Fetch full metadata for a movie or TV show by tmdb_id. Includes imdb_id (for the IMDB rating tool), genres, status, number of seasons, last/next episode info.",
  "input_schema": {
    "type": "object",
    "properties": {
      "tmdb_id": { "type": "integer" },
      "media_type": { "type": "string", "enum": ["movie", "tv"] }
    },
    "required": ["tmdb_id", "media_type"]
  }
}
```
Output: `{ tmdb_id, media_type, title, year, imdb_id, overview, genres: string[], status, runtime_minutes?, number_of_seasons?, number_of_episodes?, last_air_date?, last_episode_to_air?: { season_number, episode_number, name, air_date, vote_average }, next_episode_to_air?: same }`

### 4.3 `get_streaming_providers`
```json
{
  "name": "get_streaming_providers",
  "description": "Find streaming/rent/buy options for a movie or TV show in a given country. Default region is US; ask the user if they want a different region.",
  "input_schema": {
    "type": "object",
    "properties": {
      "tmdb_id": { "type": "integer" },
      "media_type": { "type": "string", "enum": ["movie", "tv"] },
      "region": { "type": "string", "description": "ISO 3166-1 alpha-2 country code, e.g. 'US', 'GB', 'CA'.", "default": "US" }
    },
    "required": ["tmdb_id", "media_type"]
  }
}
```
Output: `{ region, flatrate: string[], rent: string[], buy: string[], ads: string[], link?: string }` (provider names only; drop logos). Empty arrays when nothing's available.

### 4.4 `get_imdb_rating`
```json
{
  "name": "get_imdb_rating",
  "description": "Fetch IMDB rating and vote count via OMDb. Prefer imdb_id when you have it (from get_details); fall back to title+year only if no id is available.",
  "input_schema": {
    "type": "object",
    "properties": {
      "imdb_id": { "type": "string", "description": "IMDB id like 'tt3896198'." },
      "title": { "type": "string" },
      "year": { "type": "integer" },
      "media_type": { "type": "string", "enum": ["movie", "tv"] }
    }
  }
}
```
Output: `{ title, year, imdb_id, imdb_rating: number|null, imdb_votes: number|null }` or `{ error: "rate_limit"|"not_found" }`.

### 4.5 `get_show_seasons`
```json
{
  "name": "get_show_seasons",
  "description": "List the seasons of a TV show (excludes 'Season 0' specials).",
  "input_schema": {
    "type": "object",
    "properties": { "tmdb_id": { "type": "integer" } },
    "required": ["tmdb_id"]
  }
}
```
Output: `{ seasons: Array<{ season_number, name, episode_count, air_date: string|null }> }`

### 4.6 `get_season_episodes`
```json
{
  "name": "get_season_episodes",
  "description": "List episodes for one season of a TV show, with TMDB community ratings.",
  "input_schema": {
    "type": "object",
    "properties": {
      "tmdb_id": { "type": "integer" },
      "season_number": { "type": "integer" }
    },
    "required": ["tmdb_id", "season_number"]
  }
}
```
Output: `{ season_number, episodes: Array<{ episode_number, name, air_date, vote_average, vote_count, overview }> }`

### 4.7 `get_best_episodes`
```json
{
  "name": "get_best_episodes",
  "description": "Return the highest-rated episodes of a TV show across all seasons (TMDB community vote_average). Filters out episodes with too few votes.",
  "input_schema": {
    "type": "object",
    "properties": {
      "tmdb_id": { "type": "integer" },
      "limit": { "type": "integer", "default": 10 },
      "min_votes": { "type": "integer", "default": 50 }
    },
    "required": ["tmdb_id"]
  }
}
```
Output: `{ episodes: Array<{ season_number, episode_number, name, vote_average, vote_count, air_date }> }`

Implementation: call `get_show_seasons`, then fan out `get_season_episodes` for each season with `Promise.all`, concat, filter by `min_votes`, sort by `vote_average` desc, slice to `limit`.

---

## 5. Tool-Use Loop + HTTP Wiring (Pseudocode)

The loop itself is unchanged from the CLI design; only its invocation moves from a REPL prompt to an HTTP request handler.

```ts
// src/chat.ts — the tool-use agent loop
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { TOOL_SCHEMAS, dispatch } from "./tools/registry.js";

const MODEL = "claude-sonnet-4-6"; // good tool-use cost/capability for a hobby project

export async function runTurn(
  client: Anthropic,
  conversation: Anthropic.MessageParam[],
  userInput: string,
): Promise<string> {
  conversation.push({ role: "user", content: userInput });
  let assistantText = "";

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOL_SCHEMAS,
      messages: conversation,
    });

    conversation.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text") assistantText += block.text;
    }

    if (response.stop_reason !== "tool_use") break;

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (b) => {
        try {
          const result = await dispatch(b.name, b.input as Record<string, unknown>);
          return { type: "tool_result" as const, tool_use_id: b.id, content: JSON.stringify(result) };
        } catch (err) {
          return { type: "tool_result" as const, tool_use_id: b.id, content: JSON.stringify({ error: String(err) }), is_error: true };
        }
      }),
    );

    conversation.push({ role: "user", content: toolResults });
  }

  return assistantText;
}
```

```ts
// src/index.ts — Express server
import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { runTurn } from "./chat.js";
import { anthropic } from "./anthropic.js";
import { getOrCreate, reset } from "./sessions.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/api/chat", async (req, res) => {
  const { sessionId: incoming, message } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  const sessionId = incoming ?? randomUUID();
  const conversation = getOrCreate(sessionId);
  try {
    const reply = await runTurn(anthropic, conversation, message);
    res.json({ sessionId, reply });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/reset", (req, res) => {
  reset(req.body?.sessionId);
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`CinemaDaddy http://localhost:${port}`));
```

**Frontend behavior** (vanilla JS in `public/chat.js`):
- On page load, read `sessionId` from `localStorage` (may be absent).
- On submit: append the user message to the visible chat, disable input, POST `/api/chat` with `{ sessionId, message }`.
- On response: store returned `sessionId` to `localStorage`, append the assistant reply, re-enable input.
- "Reset" button: POST `/api/reset` with current `sessionId`, then clear `localStorage` and the visible chat.
- On 5xx or 4xx: show the error inline and re-enable input.

---

## 6. System Prompt (Draft)

```
You are CinemaDaddy, an expert assistant for questions about movies and TV shows. You have tools that query TMDB (metadata, episodes, streaming providers) and OMDb (IMDB ratings).

WORKFLOW:
- When the user mentions a title and you don't already know its tmdb_id from this conversation, call search_title first.
- If the top result has clearly higher popularity than the rest and matches the user's clues (year, genre, plot), use it silently.
- If two or more results are plausible (e.g. "Dune" → 1984 and 2021), ask the user which they mean. Show top 3 with year and a one-line overview.
- For IMDB rating questions, prefer this chain: search_title → get_details (to get imdb_id) → get_imdb_rating with the imdb_id. Fall back to title+year if no imdb_id.
- For "best episodes" questions, use get_best_episodes. Note in your answer that ratings are from the TMDB community (similar to but not identical to IMDB).
- For "is the new season any good?" questions: get_details to find the latest season number, then get_season_episodes for that season; report the average vote_average and the highest/lowest episode. If asked about IMDB specifically, also call get_imdb_rating for the show overall.
- For streaming questions, default to US region. If the user lives elsewhere or asks about another country, use that region. If a title isn't available in the requested region, say so and offer to check another.

FORMATTING:
- Lead with the answer in one sentence. Then details.
- Always include the year for titles so the user knows which version (e.g. "Dune (2021)").
- Use short bulleted lists for rankings and provider lists.
- Don't dump raw tool output; synthesize.
- If a tool returns an error or empty result, say so plainly and suggest what to try next.

LIMITS:
- TMDB ratings are community votes, not professional reviews. Don't pretend they're authoritative.
- OMDb has a 1000/day free-tier limit; if get_imdb_rating returns a rate_limit error, tell the user and offer the TMDB vote_average as a substitute.
```

Keep this in `src/systemPrompt.ts` as a single exported string so it's easy to tweak.

---

## 7. Edge Cases

| Case | Handling |
|---|---|
| Ambiguous title | Tool returns top 5; system prompt tells Claude when to ask. |
| Title not found | `search_title` returns `{ results: [] }`. Claude says so and asks for clarification. |
| Title not on any streaming service in region | Empty arrays from `get_streaming_providers`. Claude offers to check another region. |
| Region not specified | Default `"US"`. |
| Show with hundreds of episodes | `get_best_episodes` parallelizes season fetches and filters by `min_votes`. |
| OMDb daily limit hit | Client returns `{ error: "rate_limit" }`; Claude falls back to TMDB `vote_average`. |
| TMDB has no imdb_id | `get_imdb_rating` falls back to OMDb title+year search. |
| Unaired show / null `last_episode_to_air` | Claude handles it ("hasn't aired yet"). |
| Vote_average of 0 from unrated episodes | `min_votes` filter drops them. |
| Transient network error or 5xx | Client returns `{ error: "fetch_failed", detail }`; Claude apologizes and suggests retry. |
| **Server restart (sessions lost)** | Frontend gets 200 with a new `sessionId` (server treats unknown id as new). Optional: server could 404 unknown ids; not worth the complexity in v1. |
| **Multiple browser tabs** | Both tabs read the same `sessionId` from `localStorage` and share the conversation. Fine for hobby use. |
| **User submits before previous reply returns** | Frontend disables the input until response arrives. |
| **Long agent loop (multi-tool, slow APIs)** | Browser waits for one HTTP response. Show a spinner client-side. No request timeout in v1. |

---

## 8. Build Order

Each step should be small enough to verify in the browser (or terminal) before moving on.

1. **Scaffolding.** _(Done.)_ `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `src/index.ts` placeholder. Dependencies installed.
2. **Express server + static chat page.** Add `express` + `@types/express`. Replace `src/index.ts` with an Express app that serves `public/` and exposes `POST /api/chat` that just echoes (`{ sessionId, reply: "echo: " + message }`). Build minimal `public/index.html`, `styles.css`, `chat.js`. Verify: open `http://localhost:3000`, send "hi", see "echo: hi".
3. **Bare tool-use loop wired to /api/chat.** Add `src/anthropic.ts`, `src/systemPrompt.ts` (placeholder), `src/chat.ts`, `src/sessions.ts`. `/api/chat` calls `runTurn` with empty `tools: []`. Verify session memory: tell it your name, then ask it back.
4. **TMDB client.** `src/clients/tmdb.ts` with bearer auth and a `Map<string, unknown>` URL cache.
5. **`search_title` tool.** Register in `src/tools/registry.ts`. Verify: "tell me about Severance".
6. **`get_details` + `get_streaming_providers`.** Verify: "Where can I stream Severance?".
7. **OMDb client + `get_imdb_rating`.** Verify: "What's The Bear rated on IMDB?".
8. **`get_show_seasons` + `get_season_episodes`.** Verify: "List the seasons of Breaking Bad".
9. **`get_best_episodes`.** Verify: "What are the best-rated episodes of Breaking Bad?".
10. **Tighten the system prompt.** Run all four example questions in the browser; adjust the prompt until Claude doesn't over- or under-ask.
11. **Error paths.** Force the OMDb rate-limit branch (fake key), force a not-found, force a network error. Confirm graceful recovery.
12. **README.** Setup steps (TMDB token, OMDb key, Anthropic key), `npm install`, `npm run start`, open browser.

---

## 9. Verification

End-to-end smoke test:

1. `cp .env.example .env` and fill in `ANTHROPIC_API_KEY`, `TMDB_BEARER_TOKEN`, `OMDB_API_KEY`.
2. `npm install` (already done) — re-run after adding `express`.
3. `npm run start` — terminal logs `CinemaDaddy http://localhost:3000`.
4. Open `http://localhost:3000` in a browser.
5. Ask each of the four example questions in sequence, in the same browser tab:
   - "Where can I stream Severance?" → streamer name + year, US region.
   - "What's The Bear rated on IMDB?" → numeric rating + vote count.
   - "What are the best-rated episodes of Breaking Bad?" → ranked list with S#E# and ratings; "Ozymandias" near the top.
   - "Is the new season of Andor any good?" → latest season's average rating + a sentence of synthesis.
6. Ask "Tell me about Dune" — Claude should ask which version.
7. Click "Reset" — confirm history clears and a new `sessionId` is issued on the next message.
8. `npm run typecheck` passes.

---

## 10. Critical Files (to be created)

All under `/Users/jakeparker/Desktop/CinemaDaddy/`:

- `src/index.ts` — Express entry: routes, static files, listen
- `src/chat.ts` — tool-use loop (the heart of the app; matches §5 pseudocode)
- `src/sessions.ts` — Map-backed session store
- `src/anthropic.ts` — SDK client instance + model id
- `src/systemPrompt.ts` — the §6 prompt as an exported string
- `src/tools/registry.ts` — schema array + dispatch switch
- `src/clients/tmdb.ts`, `src/clients/omdb.ts` — fetch wrappers
- One file per tool under `src/tools/` matching §4
- `public/index.html`, `public/styles.css`, `public/chat.js` — the chat UI
