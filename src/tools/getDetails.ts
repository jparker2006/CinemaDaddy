import type Anthropic from "@anthropic-ai/sdk";
import { tmdbGet, posterUrl } from "../clients/tmdb.js";

export const getDetailsSchema: Anthropic.Tool = {
  name: "get_details",
  description:
    "Fetch full TMDB metadata for a movie or TV show by tmdb_id (which you get from search_title). Returns imdb_id (use it with get_imdb_rating when that tool exists), genres, status, runtime, season/episode counts, and the latest/next episode for ongoing TV shows.",
  input_schema: {
    type: "object",
    properties: {
      tmdb_id: { type: "integer" },
      media_type: { type: "string", enum: ["movie", "tv"] },
    },
    required: ["tmdb_id", "media_type"],
  },
};

interface EpisodeSummary {
  name: string;
  season_number: number;
  episode_number: number;
  air_date: string | null;
  vote_average: number;
}

interface MovieDetails {
  id: number;
  imdb_id?: string | null;
  title: string;
  overview?: string;
  release_date?: string;
  runtime?: number | null;
  genres?: Array<{ id: number; name: string }>;
  status?: string;
  vote_average?: number;
  poster_path?: string | null;
  external_ids?: { imdb_id?: string | null };
}

interface TvDetails {
  id: number;
  name: string;
  overview?: string;
  first_air_date?: string;
  last_air_date?: string | null;
  status?: string;
  number_of_seasons?: number;
  number_of_episodes?: number;
  genres?: Array<{ id: number; name: string }>;
  vote_average?: number;
  poster_path?: string | null;
  last_episode_to_air?: EpisodeSummary | null;
  next_episode_to_air?: EpisodeSummary | null;
  external_ids?: { imdb_id?: string | null };
}

interface DetailsOutput {
  tmdb_id: number;
  media_type: "movie" | "tv";
  title: string;
  year: number | null;
  imdb_id: string | null;
  overview: string;
  genres: string[];
  status: string | null;
  vote_average: number | null;
  poster_url: string | null;
  runtime_minutes?: number | null;
  number_of_seasons?: number;
  number_of_episodes?: number;
  first_air_date?: string | null;
  last_air_date?: string | null;
  last_episode_to_air?: EpisodeSummary | null;
  next_episode_to_air?: EpisodeSummary | null;
}

function parseYear(dateStr: string | undefined | null): number | null {
  if (!dateStr) return null;
  const y = Number(dateStr.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

function trimEpisode(
  ep: EpisodeSummary | null | undefined,
): EpisodeSummary | null {
  if (!ep) return null;
  return {
    name: ep.name,
    season_number: ep.season_number,
    episode_number: ep.episode_number,
    air_date: ep.air_date,
    vote_average: ep.vote_average,
  };
}

export interface GetDetailsInput {
  tmdb_id: number;
  media_type: "movie" | "tv";
}

export async function getDetails(
  input: GetDetailsInput,
): Promise<DetailsOutput> {
  const { tmdb_id, media_type } = input;
  if (media_type === "movie") {
    const d = await tmdbGet<MovieDetails>(`/movie/${tmdb_id}`, {
      append_to_response: "external_ids",
    });
    return {
      tmdb_id: d.id,
      media_type: "movie",
      title: d.title,
      year: parseYear(d.release_date),
      imdb_id: d.imdb_id ?? d.external_ids?.imdb_id ?? null,
      overview: d.overview ?? "",
      genres: (d.genres ?? []).map((g) => g.name),
      status: d.status ?? null,
      vote_average: d.vote_average ?? null,
      poster_url: posterUrl(d.poster_path),
      runtime_minutes: d.runtime ?? null,
    };
  }
  const d = await tmdbGet<TvDetails>(`/tv/${tmdb_id}`, {
    append_to_response: "external_ids",
  });
  return {
    tmdb_id: d.id,
    media_type: "tv",
    title: d.name,
    year: parseYear(d.first_air_date),
    imdb_id: d.external_ids?.imdb_id ?? null,
    overview: d.overview ?? "",
    genres: (d.genres ?? []).map((g) => g.name),
    status: d.status ?? null,
    vote_average: d.vote_average ?? null,
    poster_url: posterUrl(d.poster_path),
    number_of_seasons: d.number_of_seasons,
    number_of_episodes: d.number_of_episodes,
    first_air_date: d.first_air_date ?? null,
    last_air_date: d.last_air_date ?? null,
    last_episode_to_air: trimEpisode(d.last_episode_to_air),
    next_episode_to_air: trimEpisode(d.next_episode_to_air),
  };
}
