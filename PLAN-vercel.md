# CinemaDaddy — Single Vercel Deploy + Stateless Server

## Context

The current backend is an Express server (`src/index.ts`) holding conversation state in an in-memory `Map<sessionId, MessageParam[]>` (`src/sessions.ts`). That model can't run on Vercel: serverless functions are stateless across invocations and don't share memory.

This plan migrates CinemaDaddy to a **single Vercel deploy** — static frontend in `dist/` (already configured), Node serverless function at `api/chat.ts`. To make the server fully stateless, the **canonical conversation** (`Anthropic.MessageParam[]`) moves to the client and is persisted in localStorage. Each turn, the client posts the full conversation up; the server runs `runTurn`, streams NDJSON, and sends the updated conversation back in the final event.

After this lands: one host, one URL, free tier friendly, no second backend to maintain. The 10 existing tools and `runTurn` semantics are preserved untouched.

This plan replaces the completed Mood mode plan in this file. After approval, it will be copied to `/Users/jakeparker/Desktop/CinemaDaddy/PLAN-vercel.md`.

---

## 1. File-by-file changes

| File | Type | What |
|---|---|---|
| `api/chat.ts` | **new** | Vercel Node function. Web API style: `export default async function handler(req: Request): Promise<Response>` with a `ReadableStream` body for NDJSON. Imports `runTurn` from `../src/chat.js` and `anthropic` from `../src/anthropic.js`. `export const config = { maxDuration: 60 }`. |
| `vercel.json` | **new** *(minimal)* | Optional — needed only if a setting isn't expressible via `export const config`. Likely no file needed at all. Document either way in the plan. |
| `src/index.ts` | **delete** | Express is gone. |
| `src/sessions.ts` | **delete** | No more server-side session store. |
| `src/chat.ts` | unchanged | `runTurn` signature and event semantics preserved. One minor addition: the `done` event needs the full `conversation` payload — handled in the function wrapper, not in `runTurn` itself (it already mutates the conversation array in place). |
| `src/anthropic.ts`, `src/systemPrompt.ts`, `src/clients/*`, `src/tools/*` | unchanged | Module structure preserved. Imports from `api/` reach in via `../src/...`. |
| `frontend/src/App.tsx` | edit | Replace the `sessionId` flow with a canonical `conversation: MessageParam[]` state. New localStorage key `cinema-daddy-conversation`. UI render derives from conversation. Reset clears the new key. Drop the `cinema-daddy-session` key (no longer used). |
| `package.json` | edit | Drop `start` script. Change `dev` to `vercel dev`. Keep `build` and `typecheck`. Drop `express` and `@types/express` from deps (still used by deleted file). Vercel CLI is a dev dep (`vercel`). |
| `tsconfig.json` | edit | Drop `"rootDir": "src"`. Include both `src/**/*` and `api/**/*`. |
| `README.md` | edit | New deployment section (Vercel). Scripts table updated. Local dev section updated. Architecture diagram updated. "No persistence" note replaced with "conversation persists in localStorage". |

---

## 2. New wire protocol

### Request

```http
POST /api/chat
Content-Type: application/json

{
  "message": "show me the Severance trailer",
  "conversation": [
    { "role": "user", "content": "What's The Bear about?" },
    { "role": "assistant", "content": [ { "type": "text", "text": "..." }, { "type": "tool_use", ... } ] },
    { "role": "user", "content": [ { "type": "tool_result", ... } ] },
    { "role": "assistant", "content": [ { "type": "text", "text": "..." } ] }
  ]
}
```

The client sends:
- `message: string` — the new user turn
- `conversation: MessageParam[]` — the full history *before* this new turn

The server appends `{ role: "user", content: message }` to the array (inside `runTurn`, as today), runs the tool-use loop, and emits events as the loop progresses.

### Response stream (NDJSON, `Content-Type: application/x-ndjson`)

Event types — **only `done` changes**; everything else stays identical to the current Express protocol:

| Event | Payload | Notes |
|---|---|---|
| `text_delta` | `{ type, text }` | Per-token assistant text |
| `tool_use` | `{ type, id, name, input }` | Emitted when Claude invokes a tool |
| `followups` | `{ type, chips: string[] }` | Haiku-generated chips, post-turn |
| `error` | `{ type, message }` | Caught exception during the turn |
| `done` | `{ type, conversation: MessageParam[] }` | **CHANGED** — now carries the full updated conversation so the client can persist it |

The `session` event is **removed** (no server-side session to advertise).

### Why include conversation in `done` rather than streaming partial state

Reconstructing the canonical `MessageParam[]` purely from streamed events on the client is impossible — `tool_result` blocks (the `user`-role tool responses) never reach the client as events; they're internal to the server's loop. So the server must send the complete updated array at the end. Sending once at `done` is the simplest correct option.

---

## 3. Vercel function specifics

### Runtime: **Node** (not Edge)

Recommend Node runtime for `api/chat.ts`:
- Full `@anthropic-ai/sdk` compatibility (uses Node's `fetch`/`stream` semantics)
- Existing TMDB/OMDb fetches with `process.env` access work unchanged
- Edge has stricter memory + module limits and slightly different stream semantics; not worth the complication for this app
- Node cold starts (~500ms–1s) are acceptable for a chatbot

### Function shape

```ts
// api/chat.ts
import { runTurn, type ChatEvent } from "../src/chat.js";
import { anthropic } from "../src/anthropic.js";

export const config = { maxDuration: 60 };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const body = await req.json();
  // ... validate, then stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        await runTurn(anthropic, conversation, message, (e: ChatEvent) => write(e));
        write({ type: "done", conversation });
      } catch (err) {
        write({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
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
```

### `vercel.json`

Likely **not needed**. The Vite preset auto-detects from `vite.config.ts` + project structure. `maxDuration` set via in-file `export const config` colocates with the function.

If a `vercel.json` is needed later (for rewrites, headers, etc.), the minimum schema is:
```json
{ "functions": { "api/chat.ts": { "maxDuration": 60 } } }
```

Add it only if the in-file config doesn't take effect on deploy.

### Env vars (already set in Vercel UI per user)

- `ANTHROPIC_API_KEY` — read by `src/anthropic.ts` via SDK auto-detection
- `TMDB_BEARER_TOKEN` — read by `src/clients/tmdb.ts`
- `OMDB_API_KEY` — read by `src/clients/omdb.ts`
- `STREAMING_REGION` — read by `src/tools/getStreamingProviders.ts`

No `VITE_*` vars — confirmed earlier no client-bundle secret exposure.

### Streaming + Fluid Compute

Vercel's Node runtime supports the Web Streams API (`ReadableStream` + `Response`). Fluid Compute (Vercel's default execution model now) extends per-invocation max-duration to 60s on Hobby (was 10s pre-Fluid) and 300s on Pro — comfortably above the typical 5–25s for a tool-heavy mood query with follow-up chip generation.

Risk: a query that triggers `media_type: both` discover (2 parallel TMDB calls) plus multiple chained tool calls plus the Haiku follow-up could push 30–45s. Set `maxDuration: 60` and surface a clean timeout error if it ever hits the ceiling.

---

## 4. Conversation state on the client

### Single canonical state: `conversation: MessageParam[]`

The frontend treats `MessageParam[]` as the source of truth and persists it to `cinema-daddy-conversation` in localStorage. The UI's render-time `Message[]` becomes a **derived view** of the conversation (plus an ephemeral `streamingTurn` while the current assistant turn is in flight).

The current `messages: Message[]` state in `App.tsx` becomes derived data:
```
displayed = derive(conversation) + (streamingTurn ? renderInProgress(streamingTurn) : [])
```

Where `derive`:
- Maps user-text messages → `{ role: "user", text }`
- Maps assistant messages with text+tool_use blocks → `{ role: "assistant", parts: [...] }`
- Skips user-role messages whose content is `tool_result` blocks (internal plumbing — not surfaced in UI)
- Reuses the existing `AssistantPart` shape

While streaming, the in-progress assistant turn is held in `streamingTurn` (the existing `parts` building logic). When `done` arrives:
1. `conversation = done.conversation` (replaces local with server's full state)
2. `streamingTurn = null`
3. `persistConversation(conversation)` → localStorage write

### On mount / hydration

```ts
const initialConversation: MessageParam[] = (() => {
  try {
    const raw = localStorage.getItem("cinema-daddy-conversation");
    return raw ? (JSON.parse(raw) as MessageParam[]) : [];
  } catch {
    return [];
  }
})();
```

`isEmpty = conversation.length === 0` (drives empty-state UI — greeting, mood chips, etc.).

### Soft cap (4 MB)

Browsers cap localStorage at 5 MB per origin. A heavy session can grow:
- `discover_titles` returns up to 10 results × ~3 KB each = ~30 KB per call
- `get_cast_and_crew` returns up to ~5 KB
- 30+ tool-heavy turns could approach 1 MB; 100+ approaches 4 MB

Implementation:

```ts
const MAX_BYTES = 4 * 1024 * 1024;

function trim(conv: MessageParam[]): MessageParam[] {
  let out = conv;
  while (out.length > 4 && JSON.stringify(out).length > MAX_BYTES) {
    out = out.slice(2);  // drop oldest user+assistant pair
  }
  return out;
}

function persistConversation(conv: MessageParam[]) {
  try {
    localStorage.setItem("cinema-daddy-conversation", JSON.stringify(trim(conv)));
  } catch {
    // QuotaExceededError fallback: trim aggressively and retry
    localStorage.setItem("cinema-daddy-conversation", JSON.stringify(trim(conv).slice(-10)));
  }
}
```

Trimming the oldest user+assistant pair at a time (slice by 2) keeps the conversation structurally valid (turns paired). The fallback (last 10 entries) is a hard cliff if even trimming fails — extremely rare.

### Reset / New Chat

`handleReset` (and `handleNewChat` on mobile) clears the conversation:
```ts
setConversation([]);
localStorage.removeItem("cinema-daddy-conversation");
```

---

## 5. tsconfig + imports

### Current `tsconfig.json`

```json
{
  "compilerOptions": {
    ...
    "rootDir": "src",
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

`rootDir` and `include` both constrain to `src/`. Need to relax for `api/`.

### Updated `tsconfig.json`

```json
{
  "compilerOptions": {
    ...
    /* rootDir removed — both src and api type-checked from project root */
    "noEmit": true
  },
  "include": ["src/**/*", "api/**/*"]
}
```

### Import style

ESM `.js` extensions in import paths (NodeNext convention) are already the project standard. The function imports:

```ts
import { runTurn, type ChatEvent } from "../src/chat.js";
import { anthropic } from "../src/anthropic.js";
```

Vercel's internal bundler resolves these correctly. `src/chat.ts`'s own imports (`./anthropic.js`, `./tools/registry.js`, etc.) work because they're relative to the source file's location, not the function entry point.

### Frontend tsconfig

`frontend/tsconfig.json` is untouched. The frontend stays isolated from the backend type-check pass; `npm run typecheck` already runs both tscs in sequence.

---

## 6. Local dev workflow

| Command | What it does |
|---|---|
| `npm run dev` | `vercel dev` — runs the full stack (frontend + api functions) locally on the Vercel emulator. Default port 3000. Replaces both `npm run start` and `npm run dev:frontend`. |
| `npm run build` | `vite build` (unchanged) — produces `dist/` for verifying the prod bundle |
| `npm run typecheck` | `tsc --noEmit && tsc --noEmit -p frontend` (unchanged) |
| ~~`npm run start`~~ | Removed |
| ~~`npm run dev:frontend`~~ | Removed (subsumed by `vercel dev`) |

`vercel dev` requires the Vercel CLI. Install instruction in the README:
```bash
npm i -g vercel
vercel login
vercel link  # link to the deployment
npm run dev
```

If the user prefers not to install the CLI globally, `npx vercel dev` works too. README will mention both.

---

## 7. Build order (4 steps, each independently testable)

### Step 1 — Wire protocol switch (frontend + Express together)

This step is **coordinated** because frontend and backend are exchanging a new shape; they have to change in lockstep.

Files touched: `frontend/src/App.tsx`, `src/index.ts` (Express still), `src/sessions.ts` (deleted)

- **Frontend**: refactor state to `conversation: MessageParam[]` + ephemeral `streamingTurn`. Render derives from conversation. Send `{ message, conversation }`. Persist conversation to localStorage. Reset clears the new key.
- **Express**: read `conversation` from body (drop sessionId). Run `runTurn(anthropic, conversation, message, emit)`. After loop, emit `{ type: "done", conversation }`. Drop `/api/reset` route entirely (client clears its own localStorage).
- **Delete** `src/sessions.ts` and its imports from `src/index.ts`.

**Test:** `npm run start` (which still works because Express is still there). Send a message via the UI. Verify:
- Tool breadcrumbs render
- Streaming works
- Refresh page → conversation persists (rendered from localStorage)
- Reset clears it
- A multi-turn conversation with follow-up tool calls works (proves tool_result blocks round-trip via the conversation array)

### Step 2 — Add `api/chat.ts` (Vercel function alongside Express)

Files touched: `api/chat.ts` (new), `tsconfig.json` (include api)

- Port Express handler to Vercel Web API style: `Request` → `Response` with `ReadableStream` body
- Same handler logic as the now-updated Express route; just a different I/O envelope
- Add `export const config = { maxDuration: 60 }`

**Test:** install Vercel CLI if not already (`npm i -g vercel`, `vercel link`). Run `vercel dev`. Same UI behavior as step 1. Confirm the function runs locally (check `vercel dev` console for the function invocation log).

If maxDuration via in-file config doesn't honor on `vercel dev`, fall back to creating `vercel.json` with `{ "functions": { "api/chat.ts": { "maxDuration": 60 } } }`.

### Step 3 — Delete Express, update scripts

Files touched: `src/index.ts` (deleted), `package.json` (scripts + deps)

- `rm src/index.ts`
- `package.json`: drop `start`, change `dev: "vercel dev"`, drop `express` + `@types/express` from deps. Move `vercel` to devDeps.
- Verify `npm run typecheck` still passes (tsc shouldn't complain — the only file that imported express was `src/index.ts` which is now gone)

**Test:** `vercel dev` still serves the app. `npm run dev` runs the same thing. Push to a feature branch; Vercel preview deploy goes green. Open the preview URL and verify a full mood query works end-to-end.

### Step 4 — Cleanup + README

Files touched: `README.md`, possibly `frontend/src/App.tsx` (drop stale code)

- Remove the old `cinema-daddy-session` localStorage key handling from App.tsx (vestigial; not used after Step 1 — confirm no references)
- README updates:
  - New "Deploy to Vercel" section
  - Scripts table reflects 3 scripts (`dev`, `build`, `typecheck`)
  - Architecture diagram: remove Express + Sessions; add `api/chat.ts` Vercel function
  - "No persistence" note → "Conversation persists in your browser's localStorage. Refresh keeps your chat; click New Chat to clear."

Push final commit, watch Vercel main deploy go green, verify production URL.

---

## 8. Risks + edge cases

| Risk | Mitigation |
|---|---|
| `vercel dev` doesn't honor in-file `export const config` | Fall back to `vercel.json` (documented in §3) |
| Cold start adds ~1s on first request | Acceptable for a chatbot; not addressing |
| Function hits 60s maxDuration on heavy tool chains | Stream visible progress (already do via `tool_use` events); if a query genuinely takes >60s the user sees an `error` event. Plan doesn't address >60s execution — it would require a deeper redesign (background jobs, polling) |
| Tool-result payload bloat fills localStorage | Soft cap (§4) trims oldest turns automatically |
| Conversation JSON in localStorage gets corrupted | Hydration wrapped in try/catch → start empty if parsing fails. User loses history but app keeps working |
| Streaming buffered by an intermediate proxy on Vercel | `X-Accel-Buffering: no` header set in the response; Vercel respects this. NDJSON should stream as expected |
| Anthropic SDK behavior on Vercel Node runtime differs | SDK uses Web Fetch; well-tested on Vercel. No known issues |
| User on slow connection — conversation upload size on each turn | Conversation is bytes (JSON), not megabytes typically. A 50-turn session with rich tool data is ~500 KB upload. Acceptable on any reasonable connection |
| Two browser tabs share localStorage | Not addressed in this plan. Both tabs would write to the same key; last-writer-wins. Edge case for a hobby project |

---

## 9. Critical files (paths for execution)

- New: `/Users/jakeparker/Desktop/CinemaDaddy/api/chat.ts`
- Delete: `/Users/jakeparker/Desktop/CinemaDaddy/src/index.ts`
- Delete: `/Users/jakeparker/Desktop/CinemaDaddy/src/sessions.ts`
- Edit: `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/App.tsx`
- Edit: `/Users/jakeparker/Desktop/CinemaDaddy/package.json`
- Edit: `/Users/jakeparker/Desktop/CinemaDaddy/tsconfig.json`
- Edit: `/Users/jakeparker/Desktop/CinemaDaddy/README.md`
- Unchanged: `src/chat.ts`, `src/anthropic.ts`, `src/systemPrompt.ts`, `src/clients/*`, `src/tools/*`, `frontend/src/styles.css`, `vite.config.ts`

Reused existing utilities:
- `runTurn` in `src/chat.ts` — exported function, signature unchanged (`(client, conversation, userInput, emit) => Promise<void>`). Already mutates conversation in place, so the function wrapper just reads `conversation` after `runTurn` resolves to emit it in `done`.
- `anthropic` singleton in `src/anthropic.ts` — exported instance; reused as-is.
- `MODEL`, `HAIKU_MODEL`, `SYSTEM_PROMPT`, `TOOL_SCHEMAS`, `dispatch` — all reused via `src/chat.ts`, no change.

---

## 10. Don't change (verbatim from request)

- The 10 existing tools (`src/tools/*`) — same code, just imported from a different entry point
- System prompt (`src/systemPrompt.ts`)
- `runTurn` tool-use loop semantics: streaming, parallel tool calls, Haiku follow-up chip generation
- Frontend UI: sidebar/mini-rail, greeting, composer, mood chips, posters, trailers, follow-up chips, credits-roll animation
- Dark theater palette
- `cinema-daddy-sidebar-open` localStorage key
- Tool breadcrumb behavior
- Vite config (`vite.config.ts` was just fixed in commit 945bab3 — leave alone)

---

## 11. Verification

After Step 4:

1. `npm run typecheck` passes both projects.
2. `npm run build` writes to `dist/` (unchanged behavior).
3. `npm run dev` (= `vercel dev`) starts a local emulator. Browser loads CinemaDaddy on the printed URL.
4. Send a single-tool query ("Where can I stream Severance?") — verify tool breadcrumb, response streams, conversation persists on refresh.
5. Send a multi-tool query ("Best sci-fi I haven't heard of") — verify multiple tool calls, posters render, follow-up chips appear, refresh shows the conversation intact.
6. Send a follow-up ("anything more like the first one?") — verify the server can see prior turns (proves the conversation round-trip is correct).
7. Click "+ New Chat" — empty state returns, localStorage `cinema-daddy-conversation` is gone.
8. `git push` triggers a Vercel preview deploy. Open the preview URL, repeat steps 4–7 against production.
9. Inspect the Vercel function logs for any cold-start or maxDuration warnings on the heaviest test query.
10. Once production deploy is green, the architecture diagram in the README matches reality and the live URL works end-to-end.
