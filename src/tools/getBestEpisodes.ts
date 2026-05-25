import type Anthropic from "@anthropic-ai/sdk";
import { getShowSeasons } from "./getShowSeasons.js";
import { getSeasonEpisodes } from "./getSeasonEpisodes.js";

export const getBestEpisodesSchema: Anthropic.Tool = {
  name: "get_best_episodes",
  description:
    "Return the highest-rated episodes of a TV show across all seasons, by TMDB community vote_average. Excludes Season 0 and filters out episodes below min_votes (default 50). Use this for 'best of', 'top episodes', or 'highest rated' questions. tmdb_id comes from search_title.",
  input_schema: {
    type: "object",
    properties: {
      tmdb_id: { type: "integer" },
      limit: {
        type: "integer",
        description: "How many top episodes to return. Defaults to 10.",
      },
      min_votes: {
        type: "integer",
        description:
          "Minimum vote_count required to include an episode. Defaults to 50 — lower this for cult / niche shows with sparse ratings, raise it to be stricter.",
      },
    },
    required: ["tmdb_id"],
  },
};

interface BestEpisode {
  season_number: number;
  episode_number: number;
  name: string;
  vote_average: number;
  vote_count: number;
  air_date: string | null;
}

export interface GetBestEpisodesInput {
  tmdb_id: number;
  limit?: number;
  min_votes?: number;
}

export async function getBestEpisodes(
  input: GetBestEpisodesInput,
): Promise<{ episodes: BestEpisode[] }> {
  const { tmdb_id, limit = 10, min_votes = 50 } = input;

  const { seasons } = await getShowSeasons({ tmdb_id });

  const seasonResults = await Promise.all(
    seasons.map((s) =>
      getSeasonEpisodes({ tmdb_id, season_number: s.season_number }),
    ),
  );

  const all: BestEpisode[] = [];
  for (const sr of seasonResults) {
    for (const e of sr.episodes) {
      if (e.vote_count < min_votes) continue;
      all.push({
        season_number: sr.season_number,
        episode_number: e.episode_number,
        name: e.name,
        vote_average: e.vote_average,
        vote_count: e.vote_count,
        air_date: e.air_date,
      });
    }
  }

  all.sort(
    (a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count,
  );
  return { episodes: all.slice(0, limit) };
}
