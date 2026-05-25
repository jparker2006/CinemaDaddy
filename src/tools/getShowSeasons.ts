import type Anthropic from "@anthropic-ai/sdk";
import { tmdbGet } from "../clients/tmdb.js";

export const getShowSeasonsSchema: Anthropic.Tool = {
  name: "get_show_seasons",
  description:
    "List the seasons of a TV show by tmdb_id. Excludes Season 0 (specials/extras). Returns season_number, name, episode_count, and air_date for each season — useful when the user wants an overview before drilling into a specific season.",
  input_schema: {
    type: "object",
    properties: {
      tmdb_id: { type: "integer" },
    },
    required: ["tmdb_id"],
  },
};

interface SeasonSummary {
  season_number: number;
  name: string;
  episode_count: number;
  air_date: string | null;
}

interface TvSeasonsResponse {
  id: number;
  name: string;
  seasons?: Array<{
    season_number: number;
    name: string;
    episode_count: number;
    air_date: string | null;
  }>;
}

export interface GetShowSeasonsInput {
  tmdb_id: number;
}

export async function getShowSeasons(
  input: GetShowSeasonsInput,
): Promise<{ seasons: SeasonSummary[] }> {
  const data = await tmdbGet<TvSeasonsResponse>(`/tv/${input.tmdb_id}`);
  const seasons = (data.seasons ?? [])
    .filter((s) => s.season_number !== 0)
    .map((s) => ({
      season_number: s.season_number,
      name: s.name,
      episode_count: s.episode_count,
      air_date: s.air_date ?? null,
    }));
  return { seasons };
}
