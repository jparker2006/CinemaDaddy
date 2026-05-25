import type Anthropic from "@anthropic-ai/sdk";
import { tmdbGet } from "../clients/tmdb.js";

export const getSeasonEpisodesSchema: Anthropic.Tool = {
  name: "get_season_episodes",
  description:
    "List episodes for one season of a TV show with TMDB community ratings (vote_average and vote_count) and air_dates. Use when the user asks about a specific season or a specific episode by S#E# / by name. tmdb_id comes from search_title.",
  input_schema: {
    type: "object",
    properties: {
      tmdb_id: { type: "integer" },
      season_number: { type: "integer" },
    },
    required: ["tmdb_id", "season_number"],
  },
};

interface EpisodeOut {
  episode_number: number;
  name: string;
  air_date: string | null;
  vote_average: number;
  vote_count: number;
  overview: string;
}

interface SeasonResponse {
  season_number: number;
  episodes?: Array<{
    episode_number: number;
    name: string;
    air_date: string | null;
    vote_average: number;
    vote_count: number;
    overview?: string;
  }>;
}

export interface GetSeasonEpisodesInput {
  tmdb_id: number;
  season_number: number;
}

export async function getSeasonEpisodes(
  input: GetSeasonEpisodesInput,
): Promise<{ season_number: number; episodes: EpisodeOut[] }> {
  const { tmdb_id, season_number } = input;
  const data = await tmdbGet<SeasonResponse>(
    `/tv/${tmdb_id}/season/${season_number}`,
  );
  return {
    season_number,
    episodes: (data.episodes ?? []).map((e) => ({
      episode_number: e.episode_number,
      name: e.name,
      air_date: e.air_date ?? null,
      vote_average: e.vote_average,
      vote_count: e.vote_count,
      overview: e.overview ?? "",
    })),
  };
}
