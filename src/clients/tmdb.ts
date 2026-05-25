const TMDB_BASE = "https://api.themoviedb.org/3";

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
