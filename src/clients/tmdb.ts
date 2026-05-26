const TMDB_BASE = "https://api.themoviedb.org/3";

// TMDB serves images from a separate CDN. The canonical lookup is GET /3/configuration,
// but the base URL has been stable since 2014 — hardcoding is fine for a hobby app.
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
export const POSTER_SIZE = "w342";
export const PROFILE_SIZE = "w185";

const cache = new Map<string, unknown>();

type ParamValue = string | number | boolean | undefined;

export async function tmdbGet<T>(
  path: string,
  params: Record<string, ParamValue> = {},
): Promise<T> {
  const token = process.env.TMDB_BEARER_TOKEN;
  if (!token) {
    throw new Error("TMDB_BEARER_TOKEN is not set");
  }

  const url = new URL(TMDB_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  const key = url.toString();

  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;

  const res = await fetch(key, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { status_message?: string };
      detail = body.status_message ?? "";
    } catch {
      // body wasn't JSON — fall back to status text
    }
    throw new Error(
      `TMDB ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
    );
  }

  const json = (await res.json()) as T;
  cache.set(key, json);
  return json;
}

export function posterUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${POSTER_SIZE}${path}`;
}

export function profileUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${PROFILE_SIZE}${path}`;
}
