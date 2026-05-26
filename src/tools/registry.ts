import type Anthropic from "@anthropic-ai/sdk";
import {
  searchTitle,
  searchTitleSchema,
  type SearchTitleInput,
} from "./searchTitle.js";
import {
  getDetails,
  getDetailsSchema,
  type GetDetailsInput,
} from "./getDetails.js";
import {
  getStreamingProviders,
  getStreamingProvidersSchema,
  type GetStreamingProvidersInput,
} from "./getStreamingProviders.js";
import {
  getImdbRating,
  getImdbRatingSchema,
  type GetImdbRatingInput,
} from "./getImdbRating.js";
import {
  getShowSeasons,
  getShowSeasonsSchema,
  type GetShowSeasonsInput,
} from "./getShowSeasons.js";
import {
  getSeasonEpisodes,
  getSeasonEpisodesSchema,
  type GetSeasonEpisodesInput,
} from "./getSeasonEpisodes.js";
import {
  getBestEpisodes,
  getBestEpisodesSchema,
  type GetBestEpisodesInput,
} from "./getBestEpisodes.js";
import {
  getCastAndCrew,
  getCastAndCrewSchema,
  type GetCastAndCrewInput,
} from "./getCastAndCrew.js";
import {
  getTrailer,
  getTrailerSchema,
  type GetTrailerInput,
} from "./getTrailer.js";
import {
  discoverTitles,
  discoverTitlesSchema,
  type DiscoverTitlesInput,
} from "./discoverTitles.js";

export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  searchTitleSchema,
  getDetailsSchema,
  getStreamingProvidersSchema,
  getImdbRatingSchema,
  getShowSeasonsSchema,
  getSeasonEpisodesSchema,
  getBestEpisodesSchema,
  getCastAndCrewSchema,
  getTrailerSchema,
  discoverTitlesSchema,
];

export async function dispatch(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_title":
      return searchTitle(input as unknown as SearchTitleInput);
    case "get_details":
      return getDetails(input as unknown as GetDetailsInput);
    case "get_streaming_providers":
      return getStreamingProviders(
        input as unknown as GetStreamingProvidersInput,
      );
    case "get_imdb_rating":
      return getImdbRating(input as unknown as GetImdbRatingInput);
    case "get_show_seasons":
      return getShowSeasons(input as unknown as GetShowSeasonsInput);
    case "get_season_episodes":
      return getSeasonEpisodes(input as unknown as GetSeasonEpisodesInput);
    case "get_best_episodes":
      return getBestEpisodes(input as unknown as GetBestEpisodesInput);
    case "get_cast_and_crew":
      return getCastAndCrew(input as unknown as GetCastAndCrewInput);
    case "get_trailer":
      return getTrailer(input as unknown as GetTrailerInput);
    case "discover_titles":
      return discoverTitles(input as unknown as DiscoverTitlesInput);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
