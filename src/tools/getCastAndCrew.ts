import type Anthropic from "@anthropic-ai/sdk";
import { tmdbGet, profileUrl } from "../clients/tmdb.js";

export const getCastAndCrewSchema: Anthropic.Tool = {
  name: "get_cast_and_crew",
  description:
    "Fetch principal cast and key crew for a movie or TV show. For movies, returns the director(s) plus top 10 cast and key writing credits. For TV, returns the creators (from TMDB's created_by) plus top 10 cast. Use for who-stars-in, who-directed, who-created, or 'who plays X' questions. tmdb_id comes from search_title.",
  input_schema: {
    type: "object",
    properties: {
      tmdb_id: { type: "integer" },
      media_type: { type: "string", enum: ["movie", "tv"] },
    },
    required: ["tmdb_id", "media_type"],
  },
};

interface RawCastMember {
  name: string;
  character?: string;
  order?: number;
  profile_path?: string | null;
}

interface RawCrewMember {
  name: string;
  job?: string;
  profile_path?: string | null;
}

interface CreditsResponse {
  cast?: RawCastMember[];
  crew?: RawCrewMember[];
}

interface TvCreatorsResponse {
  created_by?: Array<{
    name: string;
    profile_path?: string | null;
  }>;
}

interface CastMember {
  name: string;
  character: string;
  profile_url: string | null;
}

interface CrewMember {
  name: string;
  job: string;
  profile_url: string | null;
}

interface Creator {
  name: string;
  profile_url: string | null;
}

interface CastAndCrewOutput {
  cast: CastMember[];
  crew?: CrewMember[];
  creators?: Creator[];
}

const CAST_LIMIT = 10;
const CREW_LIMIT = 6;
const MOVIE_CREW_PRIORITY = ["Director", "Writer", "Screenplay", "Story"];

function topCast(raw: RawCastMember[] | undefined): CastMember[] {
  return (raw ?? [])
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, CAST_LIMIT)
    .map((c) => ({
      name: c.name,
      character: c.character ?? "",
      profile_url: profileUrl(c.profile_path),
    }));
}

export interface GetCastAndCrewInput {
  tmdb_id: number;
  media_type: "movie" | "tv";
}

export async function getCastAndCrew(
  input: GetCastAndCrewInput,
): Promise<CastAndCrewOutput> {
  const { tmdb_id, media_type } = input;

  if (media_type === "movie") {
    const data = await tmdbGet<CreditsResponse>(`/movie/${tmdb_id}/credits`);
    const cast = topCast(data.cast);
    const crew = (data.crew ?? [])
      .filter((c) => c.job && MOVIE_CREW_PRIORITY.includes(c.job))
      .sort(
        (a, b) =>
          MOVIE_CREW_PRIORITY.indexOf(a.job ?? "") -
          MOVIE_CREW_PRIORITY.indexOf(b.job ?? ""),
      )
      .slice(0, CREW_LIMIT)
      .map((c) => ({
        name: c.name,
        job: c.job ?? "",
        profile_url: profileUrl(c.profile_path),
      }));
    return { cast, crew };
  }

  // TV: parallel fetch credits + show details so we can surface created_by as `creators`.
  const [credits, show] = await Promise.all([
    tmdbGet<CreditsResponse>(`/tv/${tmdb_id}/credits`),
    tmdbGet<TvCreatorsResponse>(`/tv/${tmdb_id}`),
  ]);

  const cast = topCast(credits.cast);
  const creators = (show.created_by ?? []).map((p) => ({
    name: p.name,
    profile_url: profileUrl(p.profile_path),
  }));
  return { cast, creators };
}
