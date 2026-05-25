# CinemaDaddy

A small chatbot that answers questions about movies and TV shows by driving Claude's tool-use loop against TMDB and OMDb. Built as a practice project for the Anthropic tool-use pattern — no database, no auth, in-memory session state, plain HTML chat UI.

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
- *Tell me about Dune* — ambiguous; Claude lists the matches with year and asks which one you mean

## Architecture

```
src/
├── index.ts                 # Express server: POST /api/chat, POST /api/reset
├── chat.ts                  # Tool-use loop (runTurn)
├── sessions.ts              # In-memory Map<sessionId, conversation>
├── anthropic.ts             # SDK client + MODEL = claude-sonnet-4-6
├── systemPrompt.ts          # Behavior rules
├── clients/
│   ├── tmdb.ts              # Bearer auth + per-URL cache
│   └── omdb.ts              # apikey + error classification (rate_limit / not_found / auth)
└── tools/
    ├── registry.ts          # TOOL_SCHEMAS + dispatch()
    ├── searchTitle.ts
    ├── getDetails.ts
    ├── getStreamingProviders.ts
    ├── getImdbRating.ts
    ├── getShowSeasons.ts
    ├── getSeasonEpisodes.ts
    └── getBestEpisodes.ts

public/
├── index.html
├── styles.css
└── chat.js                  # vanilla JS, sessionId persisted in localStorage
```

Full design and per-tool schemas: [`PLAN.md`](./PLAN.md).

## Scripts

- `npm run start` — one-shot run
- `npm run dev` — `tsx watch`, auto-restarts on save
- `npm run typecheck` — strict TS check (no emit)

## Notes

- **Default port is 3100** because the dev box I built this on had something else on 3000. Change `PORT` in `.env` if you want.
- **OMDb daily limit**: when the free-tier 1000-request limit hits, the tool returns `error: "rate_limit"`. Claude automatically falls back to TMDB's `vote_average` and tells the user. Same fallback fires if `OMDB_API_KEY` is unset — the tool returns `error: "unavailable"`.
- **No persistence**: restart the server and all conversations reset. Sessions live in a `Map` keyed by sessionId; the frontend stores the sessionId in `localStorage`, so refreshing the page keeps the conversation as long as the server hasn't restarted.
- **TMDB season counts** can include announced-but-unaired seasons. The system prompt instructs Claude to cross-check `last_air_date` / `next_episode_to_air` before claiming N seasons "exist".
