const OMDB_BASE = "https://www.omdbapi.com/";

type OmdbErrorKind = "rate_limit" | "not_found" | "auth";

export type OmdbResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: OmdbErrorKind; message: string };

const cache = new Map<string, OmdbResult<unknown>>();

type ParamValue = string | number | undefined;

export async function omdbGet<T>(
  params: Record<string, ParamValue>,
): Promise<OmdbResult<T>> {
  const apikey = process.env.OMDB_API_KEY;
  if (!apikey) {
    return {
      ok: false,
      error: "auth",
      message: "OMDB_API_KEY is not set",
    };
  }

  const cacheKey = JSON.stringify(params);
  const hit = cache.get(cacheKey);
  if (hit) return hit as OmdbResult<T>;

  const url = new URL(OMDB_BASE);
  url.searchParams.set("apikey", apikey);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`OMDb HTTP ${res.status} ${res.statusText}`);
  }

  // OMDb returns errors with HTTP 200 and Response: "False". Parse the body
  // to distinguish rate-limit, not-found, and bad-key.
  const body = (await res.json()) as {
    Response?: string;
    Error?: string;
  } & Record<string, unknown>;

  if (body.Response === "False") {
    const msg = body.Error ?? "unknown OMDb error";
    const lower = msg.toLowerCase();
    let kind: OmdbErrorKind = "not_found";
    if (lower.includes("request limit")) kind = "rate_limit";
    else if (lower.includes("invalid api key")) kind = "auth";
    const result: OmdbResult<T> = { ok: false, error: kind, message: msg };
    cache.set(cacheKey, result);
    return result;
  }

  const result: OmdbResult<T> = { ok: true, data: body as T };
  cache.set(cacheKey, result);
  return result;
}
