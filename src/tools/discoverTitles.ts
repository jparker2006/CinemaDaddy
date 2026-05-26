import type Anthropic from "@anthropic-ai/sdk";
import { tmdbGet, posterUrl } from "../clients/tmdb.js";

export const discoverTitlesSchema: Anthropic.Tool = {
  name: "discover_titles",
  description:
    "Discover movies or TV shows by vibe/criteria when the user has NOT named a specific title. Use this for mood-based queries (\"something cozy\", \"mind-bending thriller\"), filter queries (\"sci-fi from the last 5 years\"), or \"similar but different\" queries (\"like Severance but a movie\" — still call search_title for the reference, then use discover for the recommendations). For queries naming a single title the user wants info on, use search_title instead. ALWAYS pass min_vote_count to filter out obscure unrated titles.",
  input_schema: {
    type: "object",
    properties: {
      media_type: {
        type: "string",
        enum: ["movie", "tv", "both"],
        description:
          "Use 'both' when the user is open to either; the tool fans out and merges results.",
      },
      genres: {
        type: "array",
        items: { type: "integer" },
        description:
          "TMDB genre IDs. Movie and TV use DIFFERENT ID sets — see GENRE IDS in the system prompt. Multiple IDs are OR'd.",
      },
      min_runtime: {
        type: "integer",
        description:
          "Minutes. For TV, filters per-episode runtime; for movies, total runtime.",
      },
      max_runtime: { type: "integer" },
      min_year: {
        type: "integer",
        description:
          "Inclusive. Maps to primary_release_date.gte (movies) or first_air_date.gte (TV).",
      },
      max_year: { type: "integer" },
      min_rating: {
        type: "number",
        description:
          "TMDB vote_average floor, 0–10. Use 6.5 for casual, 7.0 for solid, 7.5+ for highly-acclaimed.",
      },
      min_vote_count: {
        type: "integer",
        description:
          "Floor on vote_count to exclude obscure titles. ALWAYS set this. Default 100; use 500 for 'popular'/'acclaimed'; use 50 only for 'underrated'/'hidden gem'.",
      },
      watch_providers: {
        type: "array",
        items: { type: "integer" },
        description:
          "TMDB provider IDs. Multiple are OR'd. Requires watch_region. See WATCH PROVIDERS in the system prompt.",
      },
      watch_region: {
        type: "string",
        description: "ISO 3166-1 alpha-2 country code. Defaults to 'US'.",
      },
      original_language: {
        type: "string",
        description: "ISO 639-1 code (e.g. 'en', 'ja', 'ko').",
      },
      sort_by: {
        type: "string",
        enum: [
          "popularity.desc",
          "vote_average.desc",
          "primary_release_date.desc",
          "revenue.desc",
        ],
        description:
          "Default popularity.desc. Use vote_average.desc for 'best'/'underrated'.",
      },
      page: { type: "integer" },
    },
    required: ["media_type"],
  },
};

export interface DiscoverTitlesInput {
  media_type: "movie" | "tv" | "both";
  genres?: number[];
  min_runtime?: number;
  max_runtime?: number;
  min_year?: number;
  max_year?: number;
  min_rating?: number;
  min_vote_count?: number;
  watch_providers?: number[];
  watch_region?: string;
  original_language?: string;
  sort_by?:
    | "popularity.desc"
    | "vote_average.desc"
    | "primary_release_date.desc"
    | "revenue.desc";
  page?: number;
}

interface RawMovie {
  id: number;
  title: string;
  release_date?: string;
  vote_average: number;
  vote_count: number;
  overview: string;
  poster_path?: string | null;
  runtime?: number | null;
}

interface RawTv {
  id: number;
  name: string;
  first_air_date?: string;
  vote_average: number;
  vote_count: number;
  overview: string;
  poster_path?: string | null;
}

interface DiscoverEnvelope<T> {
  page: number;
  results: T[];
  total_results: number;
  total_pages: number;
}

interface DiscoverResult {
  tmdb_id: number;
  title: string;
  media_type: "movie" | "tv";
  release_year: number | null;
  vote_average: number;
  vote_count: number;
  overview: string;
  poster_url: string | null;
  runtime: number | null;
}

interface DiscoverTitlesOutput {
  results: DiscoverResult[];
  total_results: number;
  applied_filters: Record<string, unknown>;
}

const RESULTS_CAP = 10;

function enforceVoteFloor(input: DiscoverTitlesInput): number {
  if (typeof input.min_vote_count === "number" && input.min_vote_count >= 0) {
    return input.min_vote_count;
  }
  // No floor specified — apply defaults. Higher when sorting by rating to prevent
  // ultra-niche festival films from topping the list with their handful of 10/10 votes.
  return input.sort_by === "vote_average.desc" ? 300 : 100;
}

function parseYear(date?: string): number | null {
  if (!date) return null;
  const m = date.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

type TmdbParams = Record<string, string | number | boolean | undefined>;

function buildBaseParams(
  input: DiscoverTitlesInput,
  voteFloor: number,
): TmdbParams {
  const params: TmdbParams = {
    sort_by: input.sort_by ?? "popularity.desc",
    page: input.page ?? 1,
    "vote_count.gte": voteFloor,
  };
  if (input.genres?.length) params.with_genres = input.genres.join(",");
  if (typeof input.min_runtime === "number")
    params["with_runtime.gte"] = input.min_runtime;
  if (typeof input.max_runtime === "number")
    params["with_runtime.lte"] = input.max_runtime;
  if (typeof input.min_rating === "number")
    params["vote_average.gte"] = input.min_rating;
  if (input.watch_providers?.length) {
    params.with_watch_providers = input.watch_providers.join(",");
    params.watch_region = input.watch_region ?? "US";
  }
  if (input.original_language)
    params.with_original_language = input.original_language;
  return params;
}

function buildMovieParams(
  input: DiscoverTitlesInput,
  voteFloor: number,
): TmdbParams {
  const params = buildBaseParams(input, voteFloor);
  if (typeof input.min_year === "number")
    params["primary_release_date.gte"] = `${input.min_year}-01-01`;
  if (typeof input.max_year === "number")
    params["primary_release_date.lte"] = `${input.max_year}-12-31`;
  return params;
}

function buildTvParams(
  input: DiscoverTitlesInput,
  voteFloor: number,
): TmdbParams {
  const params = buildBaseParams(input, voteFloor);
  if (typeof input.min_year === "number")
    params["first_air_date.gte"] = `${input.min_year}-01-01`;
  if (typeof input.max_year === "number")
    params["first_air_date.lte"] = `${input.max_year}-12-31`;
  return params;
}

function mapMovie(m: RawMovie): DiscoverResult {
  return {
    tmdb_id: m.id,
    title: m.title,
    media_type: "movie",
    release_year: parseYear(m.release_date),
    vote_average: m.vote_average,
    vote_count: m.vote_count,
    overview: m.overview,
    poster_url: posterUrl(m.poster_path),
    runtime: m.runtime ?? null,
  };
}

function mapTv(t: RawTv): DiscoverResult {
  return {
    tmdb_id: t.id,
    title: t.name,
    media_type: "tv",
    release_year: parseYear(t.first_air_date),
    vote_average: t.vote_average,
    vote_count: t.vote_count,
    overview: t.overview,
    poster_url: posterUrl(t.poster_path),
    runtime: null,
  };
}

export async function discoverTitles(
  input: DiscoverTitlesInput,
): Promise<DiscoverTitlesOutput> {
  const voteFloor = enforceVoteFloor(input);
  const applied_filters: Record<string, unknown> = {
    ...input,
    min_vote_count: voteFloor,
  };

  if (input.media_type === "movie") {
    const data = await tmdbGet<DiscoverEnvelope<RawMovie>>(
      "/discover/movie",
      buildMovieParams(input, voteFloor),
    );
    return {
      results: (data.results ?? []).slice(0, RESULTS_CAP).map(mapMovie),
      total_results: data.total_results ?? 0,
      applied_filters,
    };
  }

  if (input.media_type === "tv") {
    const data = await tmdbGet<DiscoverEnvelope<RawTv>>(
      "/discover/tv",
      buildTvParams(input, voteFloor),
    );
    return {
      results: (data.results ?? []).slice(0, RESULTS_CAP).map(mapTv),
      total_results: data.total_results ?? 0,
      applied_filters,
    };
  }

  // both: parallel fetch + merge
  const [movieData, tvData] = await Promise.all([
    tmdbGet<DiscoverEnvelope<RawMovie>>(
      "/discover/movie",
      buildMovieParams(input, voteFloor),
    ),
    tmdbGet<DiscoverEnvelope<RawTv>>(
      "/discover/tv",
      buildTvParams(input, voteFloor),
    ),
  ]);

  const movies = (movieData.results ?? []).map(mapMovie);
  const tvs = (tvData.results ?? []).map(mapTv);

  let merged: DiscoverResult[];
  if (input.sort_by === "vote_average.desc") {
    merged = [...movies, ...tvs].sort(
      (a, b) => b.vote_average - a.vote_average,
    );
  } else {
    // Interleave movie/TV so both stay visible
    merged = [];
    const max = Math.max(movies.length, tvs.length);
    for (let i = 0; i < max; i++) {
      if (i < movies.length) merged.push(movies[i]!);
      if (i < tvs.length) merged.push(tvs[i]!);
    }
  }

  return {
    results: merged.slice(0, RESULTS_CAP),
    total_results:
      (movieData.total_results ?? 0) + (tvData.total_results ?? 0),
    applied_filters,
  };
}
