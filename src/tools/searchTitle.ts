import type Anthropic from "@anthropic-ai/sdk";
import { tmdbGet } from "../clients/tmdb.js";

const RESULT_LIMIT = 5;

export const searchTitleSchema: Anthropic.Tool = {
  name: "search_title",
  description:
    "Search TMDB for a movie or TV show by title. Use this for every title the user mentions, including ones you recognize — your training data may be stale on year, season count, or status, and TMDB is the canonical source. Returns up to 5 matches ordered by popularity, each with year and overview so you can disambiguate.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The title to search for.",
      },
      media_type: {
        type: "string",
        enum: ["movie", "tv", "any"],
        description:
          "Whether to restrict the search to movies, TV shows, or both. Defaults to 'any'.",
      },
      year: {
        type: "integer",
        description:
          "Optional release year (movies) or first-air year (TV) to narrow results.",
      },
    },
    required: ["query"],
  },
};

export interface SearchHit {
  tmdb_id: number;
  media_type: "movie" | "tv";
  title: string;
  year: number | null;
  overview: string;
  popularity: number;
}

interface MovieItem {
  id: number;
  title: string;
  release_date?: string;
  overview?: string;
  popularity?: number;
}

interface TvItem {
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  popularity?: number;
}

interface MultiItem {
  id: number;
  media_type: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  popularity?: number;
}

interface SearchEnvelope<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

function parseYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const year = Number(dateStr.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

export interface SearchTitleInput {
  query: string;
  media_type?: "movie" | "tv" | "any";
  year?: number;
}

export async function searchTitle(
  input: SearchTitleInput,
): Promise<{ results: SearchHit[] }> {
  const { query, media_type = "any", year } = input;

  if (media_type === "movie") {
    const data = await tmdbGet<SearchEnvelope<MovieItem>>("/search/movie", {
      query,
      year,
      include_adult: false,
    });
    return {
      results: data.results.slice(0, RESULT_LIMIT).map((r) => ({
        tmdb_id: r.id,
        media_type: "movie",
        title: r.title,
        year: parseYear(r.release_date),
        overview: r.overview ?? "",
        popularity: r.popularity ?? 0,
      })),
    };
  }

  if (media_type === "tv") {
    const data = await tmdbGet<SearchEnvelope<TvItem>>("/search/tv", {
      query,
      first_air_date_year: year,
      include_adult: false,
    });
    return {
      results: data.results.slice(0, RESULT_LIMIT).map((r) => ({
        tmdb_id: r.id,
        media_type: "tv",
        title: r.name,
        year: parseYear(r.first_air_date),
        overview: r.overview ?? "",
        popularity: r.popularity ?? 0,
      })),
    };
  }

  const data = await tmdbGet<SearchEnvelope<MultiItem>>("/search/multi", {
    query,
    include_adult: false,
  });

  const filtered = data.results.filter(
    (r): r is MultiItem & { media_type: "movie" | "tv" } =>
      r.media_type !== "person",
  );

  const yearFiltered = year
    ? filtered.filter((r) => {
        const dateStr =
          r.media_type === "movie" ? r.release_date : r.first_air_date;
        return parseYear(dateStr) === year;
      })
    : filtered;

  return {
    results: yearFiltered.slice(0, RESULT_LIMIT).map((r) => ({
      tmdb_id: r.id,
      media_type: r.media_type,
      title: (r.media_type === "movie" ? r.title : r.name) ?? "",
      year: parseYear(
        r.media_type === "movie" ? r.release_date : r.first_air_date,
      ),
      overview: r.overview ?? "",
      popularity: r.popularity ?? 0,
    })),
  };
}
