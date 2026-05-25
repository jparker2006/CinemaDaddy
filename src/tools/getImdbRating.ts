import type Anthropic from "@anthropic-ai/sdk";
import { omdbGet } from "../clients/omdb.js";

export const getImdbRatingSchema: Anthropic.Tool = {
  name: "get_imdb_rating",
  description:
    "Fetch IMDB rating and vote count via OMDb. Prefer imdb_id (from get_details) — it's exact. Fall back to title+year only if no imdb_id is available. If the call returns { error: 'rate_limit' }, OMDb's daily 1000-request free-tier limit is hit; tell the user and offer TMDB's vote_average (from get_details) as a substitute. { error: 'unavailable' } means OMDb isn't configured locally — say so and offer TMDB's vote_average too. { error: 'not_found' } means OMDb has no record for that id/title.",
  input_schema: {
    type: "object",
    properties: {
      imdb_id: {
        type: "string",
        description: "IMDB id like 'tt3896198'. Preferred.",
      },
      title: { type: "string" },
      year: { type: "integer" },
      media_type: {
        type: "string",
        enum: ["movie", "tv"],
        description:
          "If using the title fallback, this helps OMDb disambiguate movies vs series.",
      },
    },
  },
};

interface OmdbResponse {
  Title: string;
  Year: string;
  imdbID: string;
  imdbRating?: string;
  imdbVotes?: string;
  Type?: string;
}

export interface GetImdbRatingInput {
  imdb_id?: string;
  title?: string;
  year?: number;
  media_type?: "movie" | "tv";
}

type GetImdbRatingOutput =
  | {
      title: string;
      year: string;
      imdb_id: string;
      imdb_rating: number | null;
      imdb_votes: number | null;
    }
  | {
      error: "rate_limit" | "not_found" | "unavailable";
      message?: string;
    };

function parseRating(s: string | undefined): number | null {
  if (!s || s === "N/A") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseVotes(s: string | undefined): number | null {
  if (!s || s === "N/A") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function getImdbRating(
  input: GetImdbRatingInput,
): Promise<GetImdbRatingOutput> {
  const { imdb_id, title, year, media_type } = input;
  if (!imdb_id && !title) {
    return {
      error: "not_found",
      message: "Provide either imdb_id or title.",
    };
  }

  const params: Record<string, string | number | undefined> = imdb_id
    ? { i: imdb_id }
    : { t: title!, y: year, type: media_type === "tv" ? "series" : media_type };

  const result = await omdbGet<OmdbResponse>(params);
  if (!result.ok) {
    if (result.error === "auth") {
      return { error: "unavailable", message: result.message };
    }
    return { error: result.error, message: result.message };
  }

  const d = result.data;
  return {
    title: d.Title,
    year: d.Year,
    imdb_id: d.imdbID,
    imdb_rating: parseRating(d.imdbRating),
    imdb_votes: parseVotes(d.imdbVotes),
  };
}
