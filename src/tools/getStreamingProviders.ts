import type Anthropic from "@anthropic-ai/sdk";
import { tmdbGet } from "../clients/tmdb.js";

// Provider data is licensed from JustWatch via TMDB. Display attribution if
// you ever surface logos or link out: https://www.themoviedb.org/documentation/api/terms-of-use
const DEFAULT_REGION = process.env.STREAMING_REGION ?? "US";

export const getStreamingProvidersSchema: Anthropic.Tool = {
  name: "get_streaming_providers",
  description:
    "Find streaming/rent/buy options for a movie or TV show in a given country. tmdb_id comes from search_title. Returns provider lists separated by flatrate (subscription), rent, buy, and ads-supported. Default region is US — switch only if the user's question implies a different country.",
  input_schema: {
    type: "object",
    properties: {
      tmdb_id: { type: "integer" },
      media_type: { type: "string", enum: ["movie", "tv"] },
      region: {
        type: "string",
        description:
          "ISO 3166-1 alpha-2 country code, e.g. 'US', 'GB', 'CA'. Defaults to US.",
      },
    },
    required: ["tmdb_id", "media_type"],
  },
};

interface ProviderEntry {
  provider_id: number;
  provider_name: string;
}

interface RegionProviders {
  link?: string;
  flatrate?: ProviderEntry[];
  rent?: ProviderEntry[];
  buy?: ProviderEntry[];
  ads?: ProviderEntry[];
}

interface WatchProvidersResponse {
  id: number;
  results: Record<string, RegionProviders>;
}

interface ProvidersOutput {
  region: string;
  flatrate: string[];
  rent: string[];
  buy: string[];
  ads: string[];
  link?: string;
}

export interface GetStreamingProvidersInput {
  tmdb_id: number;
  media_type: "movie" | "tv";
  region?: string;
}

function names(list: ProviderEntry[] | undefined): string[] {
  return (list ?? []).map((p) => p.provider_name);
}

export async function getStreamingProviders(
  input: GetStreamingProvidersInput,
): Promise<ProvidersOutput> {
  const { tmdb_id, media_type } = input;
  const region = (input.region ?? DEFAULT_REGION).toUpperCase();
  const path = `/${media_type}/${tmdb_id}/watch/providers`;
  const data = await tmdbGet<WatchProvidersResponse>(path);
  const regionData: RegionProviders = data.results[region] ?? {};
  return {
    region,
    flatrate: names(regionData.flatrate),
    rent: names(regionData.rent),
    buy: names(regionData.buy),
    ads: names(regionData.ads),
    link: regionData.link,
  };
}
