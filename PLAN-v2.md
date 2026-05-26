# CinemaDaddy v2 — Posters, Cast & Crew, Follow-up Chips

## Context

Three additive features on top of the existing CinemaDaddy. All three preserve the streaming NDJSON protocol, dark theater theme, existing 7 tools, and tool-call breadcrumbs.

1. **Poster art** — render TMDB poster images inline in assistant replies.
2. **Cast & crew tool** — a new tool answering cast/director/creator questions.
3. **Follow-up chips** — 2–4 clickable suggested next-questions under every reply.

## Top-level recommendations

- **Posters**: extend `search_title` and `get_details` to return a pre-built `poster_url` (no new tool — Claude is already calling these, this rides along for free). Render with `react-markdown` `![alt](url)`. A custom `<p>` renderer detects all-image paragraphs and swaps to a flex grid.
- **Cast & crew**: new tool `get_cast_and_crew` hitting `/{movie|tv}/{id}/credits`. For TV, also fetch `/tv/{id}` in parallel to surface `created_by` as `creators`.
- **Chips**: **approach (b) — secondary Haiku call**. Reasoning in §3 below.
- **Single-poster layout**: standalone block above the response (~220px), amber drop-shadow. Recommended over float-left-with-text-wrap because react-markdown renders `<p><img/></p>` and floating inside an inline-rendered paragraph wraps inconsistently across browsers.
- **Cast headshots**: returned by the tool but **not** rendered in replies — too cluttered. The system prompt forbids them.

---

## 1. Poster art

### Approach

Extend `search_title` and `get_details` to include `poster_url: string | null` built from TMDB's image CDN. Claude already calls these tools for any title, so adding the field is free of round-trips.

- `search_title` results: `poster_url` on each hit (enables grid of recommendations).
- `get_details`: `poster_url` on the single result (enables hero poster).

### TMDB endpoints + image conventions

- `poster_path` exists on `/search/multi`, `/search/movie`, `/search/tv` hits, and on `/movie/{id}` and `/tv/{id}` root objects.
- URL format: `https://image.tmdb.org/t/p/{size}{poster_path}` where size is `w92` `w154` `w185` `w342` `w500` `w780` `original`.
- Use `w342` for posters (~220px at 2x retina). `w185` for cast headshots.

### Code touches

| File | Change |
|---|---|
| `src/clients/tmdb.ts` | Export `TMDB_IMAGE_BASE`, `POSTER_SIZE = "w342"`, `PROFILE_SIZE = "w185"`, and helpers `posterUrl(path)` / `profileUrl(path)` that return `string \| null` |
| `src/tools/searchTitle.ts` | Add `poster_url` to `SearchHit`, populate via `posterUrl(r.poster_path)` |
| `src/tools/getDetails.ts` | Add `poster_url` to `DetailsOutput`, populate the same way |
| `frontend/src/App.tsx` | Add `components={{ img, p }}` to `<ReactMarkdown>` — custom `img` gets a `.poster` class; custom `p` detects all-image paragraphs (via `node.children` mdast inspection — whitespace text nodes between images are tolerated) and renders as `.poster-grid` |
| `frontend/src/styles.css` | `.poster` (block, max-width 220px, rounded 10px, amber glow shadow); `.poster-grid` (flex, wrap, gap 0.75em) with smaller `.poster` inside it (max-width 130px) |
| `src/systemPrompt.ts` | New `POSTERS` block (see §System prompt) |

### Gotchas

- **`poster_path` is sometimes `null`** for unreleased / dropped / region-restricted titles. `posterUrl(null)` returns `null`. Claude sees `poster_url: null` and omits the image markdown.
- **Image CDN URL drift**: canonical method is `/3/configuration`; URL has been stable since 2014. Hobby-app trade-off — hardcoded with a comment.
- **Broken image loads**: react-markdown renders the alt text in browser default style, fine fallback.

---

## 2. Cast & crew tool

### Tool schema

```json
{
  "name": "get_cast_and_crew",
  "description": "Fetch principal cast and key crew for a movie or TV show. For movies, returns the director(s) plus top 10 cast. For TV, returns the creators (from TMDB's created_by) plus top 10 cast. Use for who-stars-in, who-directed, who-created, or 'who plays X' questions. tmdb_id comes from search_title.",
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

### Output

```ts
{
  cast: Array<{
    name: string;
    character: string;
    profile_url: string | null;
  }>;                                              // top 10 by `order`
  crew: Array<{
    name: string;
    job: string;
    profile_url: string | null;
  }>;                                              // movie: Director/Writer/Screenplay/Story
                                                   // tv: omitted (creators field instead)
  creators?: Array<{
    name: string;
    profile_url: string | null;
  }>;                                              // TV only — from /tv/{id}.created_by
}
```

### Implementation (`src/tools/getCastAndCrew.ts` — new)

- **Movies**: single call `GET /movie/{id}/credits`. Map cast → top 10 by `order`. Filter crew to `job ∈ ["Director", "Writer", "Screenplay", "Story"]`, preserve that priority.
- **TV**: `Promise.all([GET /tv/{id}/credits, GET /tv/{id}])`. Cast from credits, top 10 by `order`. Map `tv.created_by[]` → `creators` with `profile_url`. Omit `crew` field (per-episode jobs aren't useful as a single director answer).
- Use existing `tmdbGet` (cached), `profileUrl` from `tmdb.ts`.

### Code touches

| File | Change |
|---|---|
| `src/tools/getCastAndCrew.ts` | **new** — schema + implementation |
| `src/tools/registry.ts` | Register schema + dispatch case |
| `src/systemPrompt.ts` | Add one line under `WHEN TO CALL EACH TOOL` (see §System prompt) |
| `frontend/src/App.tsx` | Add `case "get_cast_and_crew": return "Looking up cast & crew…";` to `friendlyToolPhrase` |
| `README.md` | Add to the tool list and example questions |

### Gotchas

- **TV `/credits` returns aggregate cast** across all episodes; sorted by `order`, recurring leads come first. We slice top 10.
- **TV creators are NOT in `/credits`** — they live on the show object under `created_by`. Parallel-fetch handles this.
- **`profile_path` is nullable** for many cast/crew entries. Handle via `profileUrl(null) → null`.
- **Multiple directors** (Coens, Wachowskis) are normal — return all `job === "Director"` entries in order.
- **Writing credits** appear under `Writer`, `Screenplay`, or `Story`, often all three on one film. Filter keeps all three in that priority order.

---

## 3. Follow-up chips

### Approach decision — recommended: (b) secondary Haiku call

| Concern | (a) Structured output in main reply | (b) Secondary Haiku call |
|---|---|---|
| Streaming UX | User briefly sees `<followups>[...]` at end until parsed out | Clean — main response untouched |
| Parsing reliability | Fragile mid-stream — needs char-by-char buffer state machine to hide partial tags | Robust — `JSON.parse` on a complete short response |
| Latency | Zero extra | +400–900ms (Haiku is fast); chips fade in after main response settles |
| Cost | Zero extra | ~$0.001–0.003/turn (Haiku, short prompt) — trivial |
| Code complexity | Stream sentinel buffer, mid-stream display gating | One extra function, one extra event type |
| Failure mode | Bad parse leaks raw XML into reply | Empty chip array — silent, no visual artifact |

The cost and latency hits are immaterial; the stream-parsing complexity in (a) is real and tedious to test. **Recommend (b).**

### Backend flow

In `runTurn` (`src/chat.ts`), after the main tool-use loop finishes and before returning:

```ts
const chips = await generateFollowups(client, conversation);
emit({ type: "followups", chips });
// `done` is emitted by the route handler in src/index.ts after runTurn returns
```

`generateFollowups`:
- Model: `claude-haiku-4-5`
- `max_tokens: 200`
- `system`: the prompt below (§Haiku prompt)
- `messages`: pass the recent conversation, trimmed to the last ~6 turns to keep input cost down
- Parse: try `JSON.parse(text.trim())`. On failure, strip ` ```json ` / ` ``` ` fences and retry. On failure again, regex-extract `\[[\s\S]*?\]`. If all fail: return `[]` (chips silently don't render).
- Return: `string[]` — 0–4 chips, sliced to max 4 even if Haiku returns more.

### Frontend flow

| Change |
|---|
| Add `Message.chips?: string[]` |
| In `handleStreamEvent`: on `followups`, attach `chips` to the last assistant message |
| Render chip row below the assistant message **only when** `i === messages.length - 1` **AND** `!m.streaming` **AND** `m.chips && m.chips.length > 0` |
| Add `sendDirect(text: string)` — refactor of `send()` that takes message text as a parameter; existing `send()` becomes `const t = input.trim(); setInput(""); await sendDirect(t);` |
| Chip `onClick` → `sendDirect(chipText)` |

When a chip is clicked, a new user message + new assistant message appear. The previous assistant message is no longer last in the array, so its chips stop rendering — no explicit clearing needed.

### Haiku prompt

```
You are generating follow-up question suggestions for a movie/TV chatbot called CinemaDaddy. The user has just received a response. Suggest 3 brief follow-up questions they might naturally want to ask next.

Each suggestion should:
- Be specific to the movie or TV show currently being discussed
- Cover a different angle than what was already answered
- Sound like how a person would actually ask (casual, 4–10 words)
- Be answerable by the assistant's available tools (streaming providers, IMDB rating, seasons, episodes, best-of, cast & crew, details)

Return ONLY a JSON array of strings. No surrounding text, no markdown fences, no explanation.

Example output:
["Where can I stream it?", "Top episodes of season 1?", "Who's in the cast?"]
```

### Gotchas

- **Empty chips array**: render nothing — don't show an empty container.
- **Haiku call failure** (network, rate limit, parse fail): catch, emit `chips: []`, never propagate the error to the main response (which already streamed cleanly).
- **Chip flicker on streaming**: render gate includes `!m.streaming`, so chips only appear once the message fully streams.
- **Reset clears chips**: `handleReset` clears all messages, so chips disappear naturally.
- **Long Haiku turnaround leaves a 1s gap of no chips**: acceptable — better than the streaming-text leak from approach (a).

---

## System prompt — exact additions

Insert into the existing `WHEN TO CALL EACH TOOL` block (between `get_best_episodes` and the "Is the new season any good?" line):

```
- get_cast_and_crew: for questions about who stars in something, who directed it, who created/showran a TV series, or "who plays X" questions. tmdb_id from search_title.
```

Add a new `POSTERS` block immediately before `FORMATTING`:

```
POSTERS
- search_title and get_details return a poster_url for each title. When the response is about a specific title, render its poster as a markdown image at the very top of your reply: ![Title (Year)](poster_url)
- For recommendations or multi-title lists (e.g. "shows like X", "movies in the same genre"), put all the posters together in ONE paragraph with no surrounding text — the frontend renders all-image paragraphs as a grid.
- If poster_url is null, omit the image — never write ![...](null).
- Don't render cast headshots; they clutter the reply. Plain-text cast lists only.
```

No system-prompt change is needed for chips — the Haiku call is independent.

---

## Component structure

### Posters in ReactMarkdown

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{
    img: ({ src, alt }) => (
      <img className="poster" src={src ?? ""} alt={alt ?? ""} loading="lazy" />
    ),
    p: ({ children, node }) => {
      // mdast inspection — children are AST nodes, types: 'image' | 'text' | 'link' | …
      const kids = (node as any)?.children ?? [];
      const onlyImages =
        kids.length >= 2 &&
        kids.every(
          (c: any) =>
            c.type === "image" || (c.type === "text" && !c.value.trim()),
        );
      if (onlyImages) return <div className="poster-grid">{children}</div>;
      return <p>{children}</p>;
    },
  }}
>
  {text}
</ReactMarkdown>
```

### Chips render block

```tsx
{isLast && m.role === "assistant" && !m.streaming && m.chips && m.chips.length > 0 && (
  <div className="chips">
    {m.chips.map((c, k) => (
      <button
        key={k}
        type="button"
        className="chip"
        onClick={() => void sendDirect(c)}
      >
        {c}
      </button>
    ))}
  </div>
)}
```

### CSS sketch

```css
.poster {
  display: block;
  max-width: 220px;
  width: 100%;
  height: auto;
  border-radius: 10px;
  box-shadow:
    0 0 26px rgba(212, 162, 76, 0.18),
    0 8px 24px rgba(0, 0, 0, 0.45);
  margin: 0.8em 0;
}
.poster-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75em;
  margin: 0.9em 0;
}
.poster-grid .poster {
  max-width: 130px;
  margin: 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
  margin: 0.9em 0 0.2em;
}
.chip {
  font-family: inherit;
  font-size: 0.82rem;
  padding: 0.42rem 0.9rem;
  background: var(--bg-elev);
  border: 1px solid var(--amber-low);
  color: var(--amber);
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s, transform 0.05s;
}
.chip:hover {
  border-color: var(--amber);
  background: var(--amber-low);
  color: var(--amber-hi);
}
.chip:active {
  transform: translateY(1px);
}
```

---

## File-by-file change summary

| File | Type | What |
|---|---|---|
| `src/clients/tmdb.ts` | edit | Add image base + size constants + `posterUrl` / `profileUrl` helpers |
| `src/tools/searchTitle.ts` | edit | Add `poster_url` to each hit |
| `src/tools/getDetails.ts` | edit | Add `poster_url` to output |
| `src/tools/getCastAndCrew.ts` | **new** | Tool implementation |
| `src/tools/registry.ts` | edit | Register `getCastAndCrewSchema` + dispatch case |
| `src/chat.ts` | edit | Add `followups` event variant; add `generateFollowups()`; emit after main loop |
| `src/systemPrompt.ts` | edit | Add cast/crew line and POSTERS block |
| `frontend/src/App.tsx` | edit | Custom `img` / `p` markdown components; `Message.chips`; `sendDirect()`; chip rendering; `friendlyToolPhrase` for new tool |
| `frontend/src/styles.css` | edit | `.poster`, `.poster-grid`, `.chips`, `.chip` |
| `README.md` | edit | Add `get_cast_and_crew` to tool list + example questions |

No backend changes touch `src/index.ts` (the NDJSON protocol already accepts arbitrary event types) or `src/anthropic.ts` (the same client instance handles the Haiku call — just pass the model id directly).

---

## Build order

Seven steps, each independently testable. After each, `npm run typecheck` then `npm run start` and verify in the browser.

1. **TMDB image helpers** — add base/size constants and `posterUrl`/`profileUrl` in `tmdb.ts`. Foundation only; no tool surface change. Typecheck.

2. **`poster_url` on `search_title` + `get_details`** — populate from existing `poster_path`. No frontend rendering yet; Claude will see the field in tool results but won't render images (no system prompt rule). Test by curling `/api/chat` and inspecting the tool_use response is unchanged-shaped (poster URLs are inside tool_result JSON, not in the NDJSON wire envelope).

3. **Frontend poster rendering + POSTERS system prompt** — custom `img` / `p` markdown components + CSS. Update system prompt. Test:
   - "Tell me about Severance" → single poster at top of reply.
   - "Recommend 4 shows like Breaking Bad" → poster grid (small thumbnails).

4. **`get_cast_and_crew` tool** — new file, register, friendlyToolPhrase mapping, system-prompt line. Test:
   - "Who's in The Bear?" → cast list with characters.
   - "Who directed Oppenheimer?" → Christopher Nolan called out.
   - "Who created Severance?" → Dan Erickson from `created_by`.

5. **`generateFollowups` in chat.ts** — Haiku call after main loop, emit `followups` event with chips array. Test via curl:
   ```
   curl -N -X POST localhost:3100/api/chat -H "Content-Type: application/json" -d '{...}' | grep followups
   ```
   should show one `{"type":"followups","chips":[...]}` line near the end.

6. **Frontend chip rendering** — `Message.chips`, handler, conditional render, CSS, `sendDirect()` refactor. Test:
   - 2–4 chips appear under each completed assistant message.
   - Clicking a chip immediately fires the question.
   - Previous chips disappear when a new reply streams.
   - Reset clears chips along with messages.

7. **Polish + README** — README entry for `get_cast_and_crew`, example questions, note the new chip behavior.

---

## TMDB gotchas (consolidated)

- **Image base URL** hardcoded to `https://image.tmdb.org/t/p`; technically `/3/configuration` is canonical but URL has been stable for a decade.
- **`poster_path` / `profile_path` are nullable** — helpers return `null`, downstream renders nothing.
- **TV cast is aggregate** across all episodes; `order` keeps main cast first.
- **TV creators live at `/tv/{id}.created_by`**, NOT in `/tv/{id}/credits`. Parallel-fetch in the tool.
- **Multiple directors** (Coens, Wachowskis) are normal — return all `Director`-job entries.
- **Writing credits** span `Writer` / `Screenplay` / `Story` — preserve all three filtered in that priority order.
- **Image sizes** — `w342` posters, `w185` headshots. `original` is uncached and huge; avoid.

---

## Verification

After all 7 build-order steps:

1. **Poster (single)** — "Tell me about Severance" → poster at top, ~220px, amber glow.
2. **Poster (grid)** — "Recommend 4 shows like Breaking Bad" → row of 4 smaller posters, then prose.
3. **Cast (movie)** — "Who directed Oppenheimer?" → Christopher Nolan; top cast with characters.
4. **Cast (TV)** — "Who created Severance?" → Dan Erickson (from `created_by`); cast like "Adam Scott (Mark Scout)".
5. **Tool breadcrumb intact** — "→ Looking up cast & crew…" appears above the cast reply.
6. **Chips** — every reply shows 2–4 chips; clicking fires the question; previous chips disappear when a new reply streams.
7. **Reset** — clears messages and chips.
8. **Streaming intact** — text streams token-by-token; blinking cursor follows the last paragraph.
9. **All 8 tools** (the 7 existing + `get_cast_and_crew`) emit breadcrumbs.
10. `npm run typecheck` passes both projects; `npm run build` produces the new bundle.

After approval, this plan will be copied to `/Users/jakeparker/Desktop/CinemaDaddy/PLAN-v2.md`.
