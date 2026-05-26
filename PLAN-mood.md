# CinemaDaddy — Mood mode

## Context

CinemaDaddy currently answers questions about specific titles the user names (search → details → ratings → streaming → cast → trailer). It can't help when the user describes a *vibe* instead of a title ("something cozy under 90 minutes on Netflix"). This plan adds **Mood mode**: a discover tool plus system-prompt + UX wiring that lets Claude translate vibe-language into structured TMDB `/discover` filters and return 3–6 recommendations with posters and stream-on data.

The feature is **implicit** — Claude detects mood-style queries (no specific title, vibe/criteria language) and reaches for the new tool automatically. Discoverability comes from 3–4 example-prompt chips on the empty state.

The work is additive — no existing tool, prompt, frontend, or palette behavior changes. After approval, this plan will be copied to `/Users/jakeparker/Desktop/CinemaDaddy/PLAN-mood.md`.

---

## 1. File-by-file changes

| File | Type | What |
|---|---|---|
| `src/tools/discoverTitles.ts` | **new** | TMDB `/discover/movie` and `/discover/tv` wrapper, filter normalization, both-mode merge, vote-count floor enforcement |
| `src/tools/registry.ts` | edit | Import + register `discoverTitlesSchema` and dispatch case |
| `src/systemPrompt.ts` | edit | Add `discover_titles` line under WHEN TO CALL EACH TOOL; new MOOD → FILTERS block; new GENRE IDS block (movie + TV); new WATCH PROVIDERS block; tweak existing FORMATTING with a "Mood results" rule |
| `frontend/src/App.tsx` | edit | `friendlyToolPhrase` entry: `"Browsing the catalog…"`. New `MOOD_SUGGESTIONS` const + `.mood-suggestions` JSX in empty state (below composer). Reuse existing `sendDirect(text)` for click handler |
| `frontend/src/styles.css` | edit | New `.mood-suggestions` + `.mood-chip` rules (similar visual language to follow-up `.chip` but distinguished by position/spacing) |
| `README.md` | edit | New tool row in the table (10 tools total); new "Mood queries" bullet in *What you can ask*; brief note on `/discover` use in the architecture section |

No backend protocol changes — the existing NDJSON event stream already carries arbitrary `tool_use` events. No new env vars; same TMDB token used by all other tools.

---

## 2. Full discover tool definition

### Tool schema

```json
{
  "name": "discover_titles",
  "description": "Discover movies or TV shows by vibe/criteria when the user has NOT named a specific title. Use this for mood-based queries (\"something cozy\", \"mind-bending thriller\"), filter queries (\"sci-fi from the last 5 years\"), or \"similar but different\" queries (\"like Severance but a movie\" — note: this requires the user to have named the reference title, in which case still call search_title for the reference; use discover for what to recommend). For queries where the user names a single title they want info on, use search_title instead. ALWAYS pass min_vote_count to filter out obscure unrated titles.",
  "input_schema": {
    "type": "object",
    "properties": {
      "media_type": {
        "type": "string",
        "enum": ["movie", "tv", "both"],
        "description": "Use 'both' when the user is open to either; the tool fans out and merges results."
      },
      "genres": {
        "type": "array",
        "items": { "type": "integer" },
        "description": "TMDB genre IDs. Movie and TV use different ID sets — see GENRE IDS in the system prompt. Multiple IDs are OR'd."
      },
      "min_runtime": { "type": "integer", "description": "Minutes. For TV, filters per-episode runtime. For movies, total runtime." },
      "max_runtime": { "type": "integer" },
      "min_year": { "type": "integer", "description": "Inclusive. Maps to primary_release_date.gte (movies) or first_air_date.gte (TV)." },
      "max_year": { "type": "integer" },
      "min_rating": { "type": "number", "description": "TMDB vote_average floor, 0–10. Use 6.5 for casual, 7.0 for solid, 7.5+ for highly-acclaimed." },
      "min_vote_count": { "type": "integer", "description": "Floor on vote_count to exclude obscure titles. ALWAYS set this. Default 100; use 500 for 'popular'/'acclaimed' queries; use 50 only for 'underrated'/'hidden gem' queries." },
      "watch_providers": {
        "type": "array",
        "items": { "type": "integer" },
        "description": "TMDB provider IDs (see WATCH PROVIDERS in the system prompt). Multiple are OR'd. Requires watch_region."
      },
      "watch_region": { "type": "string", "description": "ISO 3166-1 alpha-2 country code. Defaults to 'US'." },
      "original_language": { "type": "string", "description": "ISO 639-1 code (e.g. 'en', 'ja', 'ko')." },
      "sort_by": {
        "type": "string",
        "enum": ["popularity.desc", "vote_average.desc", "primary_release_date.desc", "revenue.desc"],
        "description": "Default popularity.desc. Use vote_average.desc for 'best'/'underrated'. Use primary_release_date.desc for 'recent'."
      },
      "page": { "type": "integer", "description": "1-indexed pagination. Default 1." }
    },
    "required": ["media_type"]
  }
}
```

### Return shape

```ts
{
  results: Array<{
    tmdb_id: number;
    title: string;                       // movies: title; TV: name
    media_type: "movie" | "tv";
    release_year: number | null;         // from release_date / first_air_date
    vote_average: number;
    vote_count: number;
    overview: string;
    poster_url: string | null;           // built via existing posterUrl()
    runtime: number | null;              // movies only — /discover/tv doesn't return it
  }>;
  total_results: number;                 // from TMDB envelope
  applied_filters: Record<string, unknown>; // echo of what was actually sent, so Claude can explain "broadened the search" on retry
}
```

### TMDB endpoint mapping

`/discover/movie` and `/discover/tv` accept different param names for date filters:

| Input | `/discover/movie` param | `/discover/tv` param |
|---|---|---|
| `min_year` → Jan 1 of year | `primary_release_date.gte` | `first_air_date.gte` |
| `max_year` → Dec 31 of year | `primary_release_date.lte` | `first_air_date.lte` |
| `min_rating` | `vote_average.gte` | `vote_average.gte` |
| `min_vote_count` | `vote_count.gte` | `vote_count.gte` |
| `min_runtime` | `with_runtime.gte` | `with_runtime.gte` (per-episode) |
| `max_runtime` | `with_runtime.lte` | `with_runtime.lte` (per-episode) |
| `genres` | `with_genres` (comma = OR) | `with_genres` (comma = OR) |
| `watch_providers` | `with_watch_providers` (comma = OR) | `with_watch_providers` (comma = OR) |
| `watch_region` | `watch_region` | `watch_region` |
| `original_language` | `with_original_language` | `with_original_language` |
| `sort_by` | `sort_by` | `sort_by` |
| `page` | `page` | `page` |

Per TMDB docs: comma = OR, pipe = AND for multi-value filters. We use commas everywhere (OR semantics — "comedy OR family OR romance").

### `media_type === "both"` behavior

`Promise.all([discoverMovie, discoverTv])`. Merge result arrays. Sort by:
- If `sort_by === "vote_average.desc"`: by `vote_average` desc with `min_vote_count` already applied
- Otherwise: interleave (alternate movie/TV) to keep both visible, capped at 10 total

Each merged result keeps its `media_type` field so the assistant can suffix `(Movie)` / `(Series)` in the reply.

### Vote-count floor — non-negotiable

Without `vote_count.gte`, `/discover` returns obscure films with a single 10/10 vote. The wrapper **always** passes `vote_count.gte`. If the input omits it, default to **100**. If `sort_by === "vote_average.desc"` and the caller forgot, force minimum **300** (to prevent rating-sort returning ultra-niche festival films).

### Caching

Use the existing `tmdbGet<T>()` cache (key includes full URL with params). Same-shape queries within a session are free.

---

## 3. TMDB reference data

### Movie genres (`/discover/movie?with_genres=…`)

| ID | Genre |
|---|---|
| 28 | Action |
| 12 | Adventure |
| 16 | Animation |
| 35 | Comedy |
| 80 | Crime |
| 99 | Documentary |
| 18 | Drama |
| 10751 | Family |
| 14 | Fantasy |
| 36 | History |
| 27 | Horror |
| 10402 | Music |
| 9648 | Mystery |
| 10749 | Romance |
| 878 | Science Fiction |
| 10770 | TV Movie |
| 53 | Thriller |
| 10752 | War |
| 37 | Western |

### TV genres (`/discover/tv?with_genres=…`) — **different IDs from movies**

| ID | Genre |
|---|---|
| 10759 | Action & Adventure |
| 16 | Animation |
| 35 | Comedy |
| 80 | Crime |
| 99 | Documentary |
| 18 | Drama |
| 10751 | Family |
| 10762 | Kids |
| 9648 | Mystery |
| 10763 | News |
| 10764 | Reality |
| 10765 | Sci-Fi & Fantasy |
| 10766 | Soap |
| 10767 | Talk |
| 10768 | War & Politics |
| 37 | Western |

Key collisions to keep in mind in the system prompt: **Sci-Fi** is `878` for movies but `10765` for TV. **Action/Adventure** is two genres for movies (`28` + `12`) but one merged genre for TV (`10759`).

### Watch provider IDs (US, `watch_region=US`)

| ID | Provider |
|---|---|
| 8 | Netflix |
| 1899 | Max |
| 15 | Hulu |
| 337 | Disney+ |
| 9 | Amazon Prime Video |
| 350 | Apple TV+ |
| 386 | Peacock |
| 531 | Paramount+ |

Note: provider IDs are *almost* region-stable but technically per-region — Netflix is `8` globally, Max is `1899` in US/Latin America but uses different IDs in some markets. For non-US, the right move is to call `/watch/providers/movie?watch_region={code}` once and cache, but for now we hardcode US-only and surface `watch_region` as an input so the wiring is in place for later.

### Region default

Default `watch_region = "US"` (matches existing `STREAMING_REGION=US` from `.env`). Future: read from `process.env.STREAMING_REGION` so the user can swap globally.

---

## 4. System prompt additions (exact text)

Insert these blocks into `src/systemPrompt.ts`. Anchor by inserting before the existing `POSTERS` block.

### Add under `WHEN TO CALL EACH TOOL` (between `get_trailer` and the "Is the new season any good?" line)

```
- discover_titles: when the user describes a VIBE or CRITERIA without naming a specific title (e.g. "something cozy", "mind-bending thriller", "best-reviewed sci-fi from the last 5 years", "funny movie under 2 hours on Netflix"). Use INSTEAD of search_title when no title is named. ALWAYS pass min_vote_count to filter out obscure titles: default 100; use 500 for "popular"/"acclaimed"; use 50 only for "underrated"/"hidden gem". Pre-filter by watch_providers when the user names a service — don't fetch results and then check streaming separately.
```

### New block — `MOOD → FILTERS` (insert before POSTERS)

```
MOOD → FILTERS (when calling discover_titles)
Translate vibe words into filter combinations. Default media_type to "movie" unless the user implies a series, then "tv", or "both" if open.

- "Cozy" / "comfort watch": genres comedy/family/romance, min_rating 6.5, max_runtime 120
- "Mind-bending" / "twisty": genres sci-fi/mystery/thriller, min_rating 7.0, sort vote_average.desc, min_vote_count 500
- "Date night": genres romance/comedy, max_runtime 130, min_rating 6.5
- "Cerebral" / "thoughtful": genres drama/mystery, min_rating 7.5, sort vote_average.desc, min_vote_count 500
- "Underrated" / "hidden gem" / "haven't heard of": min_rating 7.5, min_vote_count 50 (LOWER), sort vote_average.desc — these queries SPECIFICALLY want obscure picks
- "Popular right now": sort popularity.desc, min_year (current year - 2)
- "Recent": min_year (current year - 5 to -10 depending on phrasing)
- "Action-packed": genres action/adventure/thriller, min_rating 6.5
- "Scary" / "horror": genres horror, min_rating 6.5
- "Tear-jerker": genres drama/romance, min_rating 7.0
- "Funny" / "lighthearted": genres comedy, min_rating 6.5
- "Feel-good": genres comedy/family/music, min_rating 7.0
- "Dark" / "gritty": genres crime/drama/thriller, min_rating 7.0
- "Like X but different": still call search_title for X first to get its genres, then discover with those genres + offset filters
```

### New block — `GENRE IDS` (insert before POSTERS)

```
GENRE IDS — MOVIES (use with media_type: "movie")
Action 28, Adventure 12, Animation 16, Comedy 35, Crime 80, Documentary 99, Drama 18, Family 10751, Fantasy 14, History 36, Horror 27, Music 10402, Mystery 9648, Romance 10749, Sci-Fi 878, Thriller 53, War 10752, Western 37

GENRE IDS — TV (use with media_type: "tv") — DIFFERENT from movie IDs
Action & Adventure 10759, Animation 16, Comedy 35, Crime 80, Documentary 99, Drama 18, Family 10751, Kids 10762, Mystery 9648, News 10763, Reality 10764, Sci-Fi & Fantasy 10765, Soap 10766, Talk 10767, War & Politics 10768, Western 37

Note the differences: Sci-Fi is 878 (movie) vs 10765 (TV); Action splits into 28+12 (movie) but merges to 10759 (TV).
```

### New block — `WATCH PROVIDERS`

```
WATCH PROVIDERS (use with watch_providers + watch_region "US")
Netflix 8, Max 1899, Hulu 15, Disney+ 337, Amazon Prime Video 9, Apple TV+ 350, Peacock 386, Paramount+ 531
Pass multiple IDs to OR them (e.g. "Netflix or Max" → [8, 1899]). If the user doesn't name a service, OMIT watch_providers entirely (don't pre-filter).
```

### Add to `FORMATTING`

```
- For discover_titles results, lead with one short framing sentence ("Here are some cozy comfort watches under 90 minutes on Netflix:"), then 3–6 results. Each result: bold title (year), one-sentence pitch in YOUR voice (not the TMDB synopsis verbatim), and "★ 7.8 · 102 min · Netflix" style metadata line. Put all posters in ONE paragraph at the top (rendered as a grid). For "both" results, suffix the title with "(Movie)" or "(Series)" to distinguish.
- After mood results, suggest the user can refine ("want it shorter?", "less mainstream?") or ask for more like one of them.
```

### Add to existing edge-case section (or append at end)

```
DISCOVER EDGE CASES
- If discover_titles returns no results, loosen the most restrictive filter and retry. Order to relax: watch_providers (drop entirely) → min_rating (drop by 0.5) → min_vote_count (cut in half) → max_runtime (drop entirely). Tell the user what you broadened.
- If the user says "I've seen that one already": acknowledge, note that you don't yet track watch history, and call discover again with the seen title implicitly excluded from the conversation (TMDB has no exclude-by-id param — just don't surface it again).
- If the user names a streaming service you don't have a provider ID for, ask them which they mean OR call discover without watch_providers and mention which results stream on what.
```

---

## 5. Empty-state suggestion chips

### Where they live in the layout

Empty state currently:
```
<div className="app__inner">
  <main className="messages">{greeting}</main>
  <footer className="composer">…</footer>
</div>
```

Add chips as a sibling **after** the composer, only rendered when `messages.length === 0`:

```tsx
<div className="app__inner">
  <main className="messages">{greeting}</main>
  <footer className="composer">…</footer>
  {messages.length === 0 && (
    <div className="mood-suggestions">
      {MOOD_SUGGESTIONS.map((s) => (
        <button
          key={s}
          type="button"
          className="mood-chip"
          onClick={() => void sendDirect(s)}
        >
          {s}
        </button>
      ))}
    </div>
  )}
</div>
```

### `MOOD_SUGGESTIONS` constant (hoisted outside the component)

```ts
const MOOD_SUGGESTIONS = [
  "Something cozy under 90 minutes on Netflix",
  "Best sci-fi I haven't heard of",
  "A thriller from the last 5 years",
  "Funny movie for tonight, under 2 hours",
];
```

### Reuses existing pattern

`sendDirect(text)` is already defined in `App.tsx` and used by the follow-up `.chip` buttons. No new state, no new handler — just a new render block gated on `messages.length === 0`.

### Styling

A separate class from the existing follow-up `.chip` so the visual hierarchy is clear:

```css
.mood-suggestions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.6rem;
  margin: 1.25rem auto 0;
  max-width: 620px;
  padding: 0 1rem 1rem;
}

.mood-chip {
  font-family: inherit;
  font-size: 0.82rem;
  padding: 0.5rem 0.95rem;
  background: transparent;
  border: 1px solid var(--divider);          /* neutral, NOT amber — chips are passive suggestions */
  color: var(--text-muted);
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}

.mood-chip:hover {
  border-color: var(--amber-muted);
  color: var(--text);
  background: rgba(255, 255, 255, 0.02);
}
```

Why neutral (not amber) borders: the follow-up `.chip` is amber because it's a contextual continuation of an answer. These empty-state chips are passive starter suggestions — they should fade into the background, not compete with the input bar's amber border.

### Disappearance behavior

The `{messages.length === 0 && …}` gate handles it automatically. When the first message is sent, `messages.length` becomes 1, the suggestions unmount. They never return (Reset / New Chat → empty → suggestions back).

---

## 6. Edge cases (consolidated)

| Case | Handling | Where it's enforced |
|---|---|---|
| **No results returned** (filters too tight) | Claude loosens the most restrictive filter (drop watch_providers → drop min_rating → drop max_runtime) and retries. Tells the user what got broadened. | System prompt `DISCOVER EDGE CASES` block |
| **User didn't name a service** | Don't include `watch_providers` in the call — show results regardless of where they stream, mention streaming per-result if available via a follow-up `get_streaming_providers` call (only for the top 1–2 results to avoid N+1) | System prompt; also `get_streaming_providers` is already in the toolset |
| **User specifies a service not in the provider table** | Ask which provider they mean (e.g. "Tubi"), or call discover without `watch_providers` and mention streaming inline | System prompt |
| **"I've seen that already"** | Acknowledge, mention history isn't tracked yet, call discover again. Claude soft-excludes the named title (TMDB has no exclude-by-tmdb_id param — just doesn't surface it again from memory of conversation) | System prompt — note this becomes cleaner once a watch-history feature lands |
| **`media_type: "both"`** | Tool fans out to `/discover/movie` + `/discover/tv` in parallel, merges and sorts. Each result keeps its `media_type` so Claude can suffix `(Movie)` / `(Series)` | `discoverTitles.ts` + system prompt FORMATTING line |
| **TV runtime semantics** | `with_runtime.gte/lte` on `/discover/tv` filters PER-EPISODE runtime, not total. If the user says "under 2 hours" they almost certainly mean a movie. System prompt should bias to `media_type: "movie"` when runtime caps are mentioned. | System prompt |
| **Obscure-pick poisoning** | Always pass `min_vote_count`. Tool wrapper forces a minimum of 100 (or 300 when sort_by=vote_average.desc) if Claude omits it. | `discoverTitles.ts` wrapper logic |
| **Genre ID collision (Sci-Fi)** | Movie sci-fi is `878`, TV sci-fi is `10765`. System prompt makes this explicit. Tool wrapper doesn't auto-translate — it trusts the input IDs match the `media_type`. For `media_type: "both"`, Claude must pass the right ID per fan-out (but in practice the merge usually wants to be filter-light, so this is rarely an issue). | System prompt callout |
| **Streaming pre-filter vs N+1** | Recommend **pre-filtering** with `watch_providers` in the discover call (one tool call). Avoid the N+1 pattern of "discover, then call `get_streaming_providers` for each result". The exception: if Claude wants to enrich the top 1–2 results with full provider info (e.g. "Netflix + rentable on Apple"), one extra call is fine. | System prompt |

---

## 7. Build order

Five steps. Each independently testable.

### Step 1 — `discover_titles` tool (backend only)

- Create `src/tools/discoverTitles.ts` with schema, input type, fetch wrapper, both-mode merge, vote_count floor enforcement.
- Register in `src/tools/registry.ts`.
- Add `friendlyToolPhrase` case in `App.tsx` returning `"Browsing the catalog…"`.
- **Test:** `npm run start`, then curl `/api/chat` with a mood query like `"something cozy"`. Claude won't yet know it should call this tool (system prompt unchanged) — expect it to fall back to `search_title`. So this step is really about: tool dispatch works without errors when invoked manually. Forced test: temporarily prepend a system prompt directive to the test message, or eyeball via tool inspection.

### Step 2 — System prompt updates

- Insert all blocks per §4 above.
- **Test:** Mood queries via the UI:
  - `"something cozy under 90 minutes on Netflix"` → expect `→ Browsing the catalog…` with `media_type: movie, genres: [35, 10751, 10749], max_runtime: 90, watch_providers: [8], watch_region: "US"`
  - `"best sci-fi I haven't heard of"` → expect `genres: [878], min_rating: 7.5, min_vote_count: 50, sort_by: vote_average.desc`
  - `"a thriller from the last 5 years"` → expect `genres: [53], min_year: (currentYear - 5), sort_by: popularity.desc`
  - `"funny movie for tonight, under 2 hours"` → expect `genres: [35], max_runtime: 120`

### Step 3 — Empty-state suggestion chips

- Add `MOOD_SUGGESTIONS` const + `.mood-suggestions` JSX in `App.tsx`.
- Add `.mood-suggestions` + `.mood-chip` CSS.
- **Test:** Empty state shows 4 chips below the composer. Click one → message fires, chips disappear, conversation begins. Reset → chips return.

### Step 4 — Edge case polish

- Verify the "no results" retry behavior works by triggering it deliberately (e.g. `"a 7+ rated Western from Albania on Netflix"`). Claude should loosen and explain.
- Verify the "both" flow with `"something cozy — movie or show"` returns mixed results with `(Movie)` / `(Series)` suffixes.
- Verify a follow-up like `"shorter than that, please"` after results re-queries with tighter `max_runtime`.

### Step 5 — README

- New row in the tools table (`discover_titles` — vibe-based recommendations via /discover with vote-count floor).
- New bullet under *What you can ask*: `Something cozy under 90 minutes on Netflix — vibe-based recommendations via TMDB /discover.`
- Tools-total updated from 9 to 10.

---

## Verification

After all 5 steps:

1. `npm run typecheck` passes both projects.
2. `npm run build` produces a fresh bundle.
3. Empty state: 4 mood chips render below the composer, centered, with neutral borders.
4. Click chip → sends as a message → chips unmount → conversation begins streaming.
5. Tool breadcrumb shows `→ Browsing the catalog…` during discover calls.
6. Results render as a poster grid + per-title pitch + rating/runtime/provider line in Claude's voice.
7. Reset → empty state returns with chips intact.
8. Mood queries explicitly naming services (Netflix, Max, etc.) pre-filter via `watch_providers` (verify in `applied_filters` echoed in tool result if needed during debugging — or by checking that all results are on the named service).
9. "Underrated" / "hidden gem" queries use `min_vote_count: 50` and `vote_average.desc` (results should be lesser-known, high-rated).
10. After approval, this plan is copied to `/Users/jakeparker/Desktop/CinemaDaddy/PLAN-mood.md` so the build can be referenced during execution.
