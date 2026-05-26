# CinemaDaddy

A small chatbot that answers questions about movies and TV shows by driving Claude's tool-use loop against TMDB and OMDb. Streams responses token-by-token, renders posters and markdown inline, surfaces tool calls as breadcrumbs, and suggests follow-up questions after every reply. Built as a practice project for the Anthropic tool-use pattern — no database, no auth, in-memory session state.

## Setup

You need three credentials:

1. **Anthropic API key** — sign up at [console.anthropic.com](https://console.anthropic.com), starts with `sk-ant-…`.
2. **TMDB v4 Read Access Token** — at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api), copy the **Read Access Token** (the long `eyJ…` JWT, NOT the v3 API key).
3. **OMDb API key** — request a free key at [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx). They email you the key. Free tier is 1000 requests/day.

Then:

```bash
cp .env.example .env
# edit .env and fill in ANTHROPIC_API_KEY, TMDB_BEARER_TOKEN, OMDB_API_KEY
npm install
npm run start
```

Open [http://localhost:3100](http://localhost:3100).

## What you can ask

- *Where can I stream Severance?* — streaming providers in your region (defaults to US)
- *What's The Bear rated on IMDB?* — OMDb rating, with TMDB's `vote_average` as fallback if OMDb is unavailable
- *List the seasons of Breaking Bad* — full season breakdown with episode counts and air dates
- *What are the best-rated episodes of Breaking Bad?* — top 10 by TMDB community vote_average, fans out across seasons in parallel
- *Is the new season of Andor any good?* — finds the latest aired season and reports the average rating plus best/worst episode
- *Who's in The Bear?* — top cast with character names
- *Who directed Oppenheimer?* — director + writing credits + ensemble cast
- *Who created Severance?* — creators from TMDB's `created_by` (the right field for TV)
- *Show me the Severance trailer* — embedded YouTube trailer right in the conversation
- *Something cozy under 90 minutes on Netflix* — vibe-based recommendations via TMDB `/discover` (no title needed)
- *Best sci-fi I haven't heard of* — high-rated picks with a lower vote-count floor so hidden gems surface
- *A mind-bending thriller from the last 5 years* — Claude translates the vibe into genre + rating + year filters
- *Tell me about Dune* — ambiguous; Claude lists the matches with year and asks which one you mean
- *Recommend four shows similar to Breaking Bad* — multi-title grid of posters

After every response, 2–4 amber chips appear with suggested follow-ups. Clicking a chip sends it as the next message — no editing step.

## How it feels

- **Streaming**: assistant replies stream token-by-token, with an amber blinking cursor trailing the last paragraph.
- **Tool breadcrumbs**: each tool call shows up as a small italic line above the eventual answer, e.g. `→ Searching for "The Bear"…`, `→ Looking up cast & crew…`.
- **Posters**: when the answer is about a specific title, its TMDB poster appears at the top of the reply (rounded corners, warm amber glow). Multi-title recommendations render as a grid of smaller posters.
- **Trailers**: when a trailer would help (or you ask for one), Claude calls `get_trailer` and the YouTube embed appears inline (16:9, lazy-loaded, fullscreen-allowed, amber glow on hover).
- **Mood mode**: describe a *vibe* instead of a title ("something cozy", "underrated sci-fi", "funny movie under 2 hours on Netflix") and Claude translates the request into structured `/discover` filters — genre + rating floor + runtime + streaming service. Four example chips on the empty state make it discoverable; they disappear once a conversation starts.
- **Markdown**: bold/italics/lists/tables/code all render properly. Tables get amber uppercase headers; links get amber underlines on hover.

## Architecture

```
src/
├── index.ts                 # Express server: POST /api/chat (NDJSON stream), POST /api/reset
├── chat.ts                  # Tool-use loop + Haiku follow-ups (runTurn)
├── sessions.ts              # In-memory Map<sessionId, conversation>
├── anthropic.ts             # SDK client + MODEL (Sonnet) + HAIKU_MODEL
├── systemPrompt.ts          # Behavior rules incl. posters and disambiguation
├── clients/
│   ├── tmdb.ts              # Bearer auth + URL cache + posterUrl/profileUrl helpers
│   └── omdb.ts              # apikey + error classification (rate_limit / not_found / auth)
└── tools/
    ├── registry.ts          # TOOL_SCHEMAS + dispatch()
    ├── searchTitle.ts
    ├── getDetails.ts
    ├── getStreamingProviders.ts
    ├── getImdbRating.ts
    ├── getShowSeasons.ts
    ├── getSeasonEpisodes.ts
    ├── getBestEpisodes.ts
    ├── getCastAndCrew.ts
    ├── getTrailer.ts
    └── discoverTitles.ts

frontend/                    # React + Vite source (built to public/ by `npm run build`)
├── index.html
├── tsconfig.json
└── src/
    ├── main.tsx             # React entry
    ├── App.tsx              # Chat UI: streaming NDJSON, markdown, posters, chips
    ├── styles.css           # Dark theater theme
    └── vite-env.d.ts
```

`public/` contains the built React bundle and is regenerated by every `npm run build`; it's `.gitignore`d.

Full design notes:
- v1 (initial implementation): [`PLAN.md`](./PLAN.md)
- v2 (posters, cast & crew tool, follow-up chips): [`PLAN-v2.md`](./PLAN-v2.md)

## Scripts

- `npm run start` — runs `vite build` then starts the Express server on `:3100`
- `npm run build` — just rebuild the frontend bundle to `public/`
- `npm run dev` — backend with `tsx watch` (auto-restarts on save); pair with `npm run dev:frontend`
- `npm run dev:frontend` — Vite dev server on `:5173` with HMR, proxies `/api/*` to `:3100`. Use this two-terminal flow for frontend iteration.
- `npm run typecheck` — strict TS check for both the Node backend and the React frontend

## Tools (10 total)

| Tool | Purpose |
|---|---|
| `search_title` | TMDB title search; returns `tmdb_id`, year, overview, `poster_url` per hit |
| `get_details` | Full metadata for a title: `imdb_id`, status, seasons/episodes counts, last/next episode, `poster_url` |
| `get_streaming_providers` | Flatrate/rent/buy/ads providers in a given region (default US) |
| `get_imdb_rating` | IMDB rating + vote count via OMDb; graceful fallback when unavailable |
| `get_show_seasons` | List of seasons (excluding "Season 0" specials) |
| `get_season_episodes` | One season's episodes with TMDB community ratings |
| `get_best_episodes` | Top episodes across all seasons (parallel season fan-out, min_votes filter) |
| `get_cast_and_crew` | Top 10 cast + director(s) for movies, top 10 cast + creators for TV |
| `get_trailer` | Official YouTube trailer (`/{movie,tv}/{id}/videos`); prefers official, falls back to any |
| `discover_titles` | Vibe-based recommendations via TMDB `/discover`; genre + rating + year + runtime + streaming filters; enforces `vote_count.gte` floor (100 default, 300 when sort-by-rating) to filter out obscurities |

## Notes

- **Default port is 3100** because the dev box I built this on had something else on 3000. Change `PORT` in `.env` if you want.
- **OMDb daily limit**: when the free-tier 1000-request limit hits, the tool returns `error: "rate_limit"`. Claude automatically falls back to TMDB's `vote_average` and tells the user. Same fallback fires if `OMDB_API_KEY` is unset — the tool returns `error: "unavailable"`.
- **TMDB image CDN**: poster URLs are built against `https://image.tmdb.org/t/p/w342{path}`. The canonical lookup is `/3/configuration`; the URL has been stable since 2014 so we hardcode it.
- **No persistence**: restart the server and all conversations reset. Sessions live in a `Map` keyed by sessionId; the frontend stores the sessionId in `localStorage`, so refreshing the page keeps the conversation as long as the server hasn't restarted.
- **TMDB season counts** can include announced-but-unaired seasons. The system prompt instructs Claude to cross-check `last_air_date` / `next_episode_to_air` before claiming N seasons "exist".
- **Follow-up chips** are generated by a short Haiku call right after the main response finishes; on rate-limit or parse failure the chip array is empty and nothing renders. The main response is never blocked.
