import type Anthropic from "@anthropic-ai/sdk";
import { tmdbGet } from "../clients/tmdb.js";

export const getTrailerSchema: Anthropic.Tool = {
  name: "get_trailer",
  description:
    "Fetch the official YouTube trailer for a movie or TV show. Prefers official trailers, falls back to any trailer if none are marked official. Returns the most recent. tmdb_id comes from search_title.",
  input_schema: {
    type: "object",
    properties: {
      tmdb_id: { type: "integer" },
      media_type: { type: "string", enum: ["movie", "tv"] },
    },
    required: ["tmdb_id", "media_type"],
  },
};

interface RawVideo {
  key: string;
  name: string;
  site: string;
  type: string;
  official?: boolean;
  published_at?: string;
}

interface VideosResponse {
  results?: RawVideo[];
}

export interface GetTrailerInput {
  tmdb_id: number;
  media_type: "movie" | "tv";
}

export type TrailerOutput =
  | {
      found: true;
      youtube_key: string;
      name: string;
      published_at: string | null;
    }
  | { found: false };

function pickTrailer(results: RawVideo[]): RawVideo | null {
  const youtube = results.filter(
    (v) => v.site === "YouTube" && v.type === "Trailer",
  );
  const byRecency = (a: RawVideo, b: RawVideo) =>
    (b.published_at ?? "").localeCompare(a.published_at ?? "");

  const official = youtube.filter((v) => v.official === true).sort(byRecency);
  if (official.length > 0) return official[0]!;

  const any = youtube.slice().sort(byRecency);
  if (any.length > 0) return any[0]!;

  return null;
}

export async function getTrailer(
  input: GetTrailerInput,
): Promise<TrailerOutput> {
  const { tmdb_id, media_type } = input;
  const data = await tmdbGet<VideosResponse>(
    `/${media_type}/${tmdb_id}/videos`,
  );
  const pick = pickTrailer(data.results ?? []);
  if (!pick) return { found: false };
  return {
    found: true,
    youtube_key: pick.key,
    name: pick.name,
    published_at: pick.published_at ?? null,
  };
}
