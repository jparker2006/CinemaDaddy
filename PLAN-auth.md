# CinemaDaddy — Google Login (Supabase) + Postgres Chat History + Auth Gate

## Context

CinemaDaddy is currently a single-page app with no auth. The canonical conversation lives in browser `localStorage` under `cinema-daddy-conversation` and is posted up to `/api/chat` every turn (Vercel stateless function). Refresh keeps your chat; "+ New Chat" clears it. There is no concept of multiple chats, no account, no server-side history.

This plan adds:

1. **Google login via Supabase Auth** — hard wall, no anonymous access.
2. **Supabase Postgres persistence** for conversations + messages, per-user, protected by Row Level Security.
3. **Routing** (`react-router-dom`) so each conversation has its own URL (`/chat/:conversationId`) and the sidebar "Recent" list works.
4. **Sidebar user menu** with avatar + sign out.

What stays unchanged: every tool, the system prompt, `runTurn` semantics, NDJSON streaming, the dark theater palette, the sidebar mini-rail / collapse pattern, the composer, markdown rendering, the "What are we watching?" empty state (now per-conversation), follow-up chips, the `cinema-daddy-sidebar-open` localStorage key. The Vercel function `api/chat.ts` does NOT need to change — it remains stateless and conversation-agnostic; persistence is entirely a client concern (writes happen from the browser using the user's Supabase session + RLS).

The deliverable for this planning pass is `PLAN-auth.md` in the project root. No code yet.

---

## 1. Supabase project setup — manual dashboard steps

Do these in order. Notes after each step call out what you'll need later.

1. **Create Supabase project** at [supabase.com/dashboard](https://supabase.com/dashboard).
   - Region: pick the one closest to where you're deploying (Vercel default is `iad1` / Washington DC → choose **us-east-1** for lowest latency).
   - DB password: save it in your password manager — you don't need it day-to-day but you do need it for direct SQL access.
   - Project takes ~2 minutes to provision.

2. **Enable Google OAuth provider** at **Authentication → Providers → Google → Enable**.
   - Leave the toggle on. The provider config form will ask for **Client ID** and **Client Secret** — get them from Google in step 3.
   - Note the **Callback URL** Supabase shows you (looks like `https://<project-ref>.supabase.co/auth/v1/callback`). You'll paste this into Google in the next step.

3. **Google Cloud Console** at [console.cloud.google.com](https://console.cloud.google.com):
   - Create (or reuse) a project.
   - **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
     - Application type: **Web application**.
     - Name: `CinemaDaddy`.
     - Authorized redirect URI: paste the Supabase callback URL from step 2.
     - You can add Authorized JavaScript origins for local + prod (`http://localhost:5173`, `http://localhost:3000`, your Vercel domain) — not strictly required for the OAuth code-exchange flow, but tidy.
   - Click **Create**. Copy the **Client ID** and **Client Secret**.
   - Paste both into the Supabase Google provider config from step 2 and save.

4. **Supabase auth URLs** at **Authentication → URL Configuration**:
   - **Site URL**: `http://localhost:3000` for now (this is the fallback when no redirect is specified). Switch to your Vercel prod URL once deployed.
   - **Redirect URLs** (allow list — multiple allowed): add **all** of:
     - `http://localhost:3000/**`
     - `http://localhost:5173/**` (only if you ever run `vite` directly; `vercel dev` defaults to 3000)
     - `https://<your-vercel-prod-domain>/**`
     - `https://*-<your-vercel-team>.vercel.app/**` if you want preview deploys to work (wildcard pattern for `*.vercel.app` preview URLs)
   - **Critical**: a missing entry here is the #1 cause of "OAuth callback failed" on prod. Verify in Vercel after first prod deploy.

5. **Grab Supabase credentials** at **Settings → API**:
   - **Project URL** — looks like `https://<project-ref>.supabase.co`
   - **anon public key** — long JWT starting with `eyJ…`, role `anon`. Safe to ship in the client bundle.
   - **service_role key** — long JWT, role `service_role`. **Server-side only. Bypasses RLS.** Do not ship to the browser. We probably don't need it for this scope but capture it for completeness.

6. **Add env vars** locally and on Vercel:

   Local `.env` (add new lines; keep existing entries):
   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ…
   ```
   (No `SUPABASE_SERVICE_ROLE_KEY` needed for this scope — the client writes to Postgres directly using the anon key + the user's session JWT, protected by RLS.)

   Vercel **Project Settings → Environment Variables**: add the same two for **Production**, **Preview**, and **Development**. The `VITE_*` prefix means Vite inlines them into the client bundle at build time — this is intentional and safe (the anon key is designed for client exposure; RLS is what protects data).

---

## 2. Environment variables

| Var | Where it's used | Sensitive? |
|---|---|---|
| `VITE_SUPABASE_URL` | Frontend client (Vite inlines at build) | No |
| `VITE_SUPABASE_ANON_KEY` | Frontend client (Vite inlines at build) | No — designed to be public; RLS protects rows |
| `SUPABASE_SERVICE_ROLE_KEY` | **Not used in this scope.** Skipped to avoid accidental exposure. If a future feature needs it (e.g. admin scripts), it lives in `process.env` on the server only. | YES — never `VITE_` prefix this |
| `ANTHROPIC_API_KEY`, `TMDB_BEARER_TOKEN`, `OMDB_API_KEY`, `STREAMING_REGION` | Already configured server-side in `api/chat.ts` + `src/clients/*`. Unchanged. | YES, unchanged |

Update `.env.example` with the two new `VITE_SUPABASE_*` placeholders (empty values), preserving the existing four.

---

## 3. Database schema

Run these in the Supabase SQL editor (one file, in order). All `CREATE TABLE` + indexes + RLS + triggers can be applied in a single transaction; the SQL is below in the order you'd paste it.

### 3.1 Tables

```sql
-- profiles: one row per auth.users row, holds display data
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

-- conversations: one row per chat
create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text,                          -- nullable; set after first turn
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- messages: one row per Anthropic MessageParam (text-only, text+tool_use, or tool_result-only)
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         jsonb not null,            -- string | ContentBlock[] (Anthropic shape)
  sequence        integer not null,          -- 0-indexed position within conversation
  created_at      timestamptz not null default now(),
  unique (conversation_id, sequence)
);
```

**Schema rationale — `content jsonb`:**

Anthropic's `MessageParam.content` is either a `string` (text-only message) or a `ContentBlock[]` (mixed text/tool_use/tool_result). Storing it as a single `jsonb` round-trips perfectly with zero translation logic — load gives you exactly what you'll re-POST to `/api/chat`. The display layer (`deriveDisplay()` in `App.tsx` lines 190–230, already written) reads this same shape and renders text + tool breadcrumbs. No new conversion code needed.

Examples of what each row looks like:

```jsonb
-- user text turn
{"role": "user", "content": "What's The Bear rated on IMDB?", ...}

-- assistant text + tool_use
{"role": "assistant", "content": [
  {"type": "text", "text": "Let me check that for you."},
  {"type": "tool_use", "id": "toolu_…", "name": "search_title", "input": {"query": "The Bear"}}
], ...}

-- user tool_result (internal plumbing — NOT shown in UI but persisted for server round-trip)
{"role": "user", "content": [
  {"type": "tool_result", "tool_use_id": "toolu_…", "content": "[{\"tmdb_id\":… }]"}
], ...}
```

### 3.2 Indexes

```sql
create index conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

create index messages_conversation_sequence_idx
  on public.messages (conversation_id, sequence);
```

Sidebar "Recent" list: `SELECT … WHERE user_id = auth.uid() ORDER BY updated_at DESC LIMIT N` — hits the first index directly.

Conversation load: `SELECT … WHERE conversation_id = $1 ORDER BY sequence ASC` — hits the second.

### 3.3 Updated-at trigger

```sql
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();
```

Plus we'll bump `updated_at` from the client whenever a new message is inserted (so the conversation rises to the top of the sidebar after each turn) — see §6.

### 3.4 Profile auto-create trigger

```sql
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

Google's OAuth populates `raw_user_meta_data` with `full_name`, `avatar_url`, `email`, `picture`, `sub` (Google ID), etc. We pull what we need into our own `profiles` table so we can join freely later without poking `auth.users`.

### 3.5 Row Level Security policies

**Critical: without RLS, anyone with the anon key can read every chat.** Enable RLS on each table and add per-action policies.

```sql
alter table public.profiles      enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- profiles: a user can read & update their own row only
create policy "profiles self read"
  on public.profiles for select
  using (auth.uid() = id);
create policy "profiles self update"
  on public.profiles for update
  using (auth.uid() = id);
-- (Insert handled by the trigger as security definer; no insert policy needed for end users.)

-- conversations: full CRUD on your own rows
create policy "conversations self read"
  on public.conversations for select
  using (auth.uid() = user_id);
create policy "conversations self insert"
  on public.conversations for insert
  with check (auth.uid() = user_id);
create policy "conversations self update"
  on public.conversations for update
  using (auth.uid() = user_id);
create policy "conversations self delete"
  on public.conversations for delete
  using (auth.uid() = user_id);

-- messages: scoped via the parent conversation's owner
create policy "messages self read"
  on public.messages for select
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and c.user_id = auth.uid()
  ));
create policy "messages self insert"
  on public.messages for insert
  with check (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and c.user_id = auth.uid()
  ));
create policy "messages self delete"
  on public.messages for delete
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and c.user_id = auth.uid()
  ));
-- No update policy on messages — messages are append-only.
```

Verification step in §7.

### 3.6 Where the SQL lives in-repo

Save the full DDL as `supabase/migrations/0001_init.sql` so it's committed (and you can replay it on a fresh project if needed). Supabase CLI not required — we apply manually via the SQL editor.

---

## 4. Client-side architecture

### 4.1 New dependencies

```json
"@supabase/supabase-js": "^2"  
"react-router-dom": "^7"        
```

(`react-router-dom` v7 is the current major. v6 would also work fine; v7's `data` APIs aren't required here.)

### 4.2 New files

| File | Purpose |
|---|---|
| `frontend/src/lib/supabase.ts` | Single Supabase client instance. Exports `supabase`. |
| `frontend/src/lib/auth.tsx` | `AuthProvider` + `useAuth()` hook. Holds `{ user, session, loading, signInWithGoogle, signOut }`. Subscribes to `onAuthStateChange`. |
| `frontend/src/lib/db.ts` | Typed wrappers: `createConversation`, `listConversations`, `loadMessages`, `insertMessages`, `updateConversationTitle`, `bumpConversationUpdatedAt`, `deleteConversation` (last one optional for v1). |
| `frontend/src/lib/types.ts` | Shared types: extract `MessageParam`, `ContentBlock`, `AssistantPart`, `DisplayItem`, `StreamingTurn` from `App.tsx`. `App.tsx` imports them after. |
| `frontend/src/pages/Login.tsx` | Full-screen login page. Serif logo, tagline, Google sign-in button. |
| `frontend/src/pages/Chat.tsx` | The current `App.tsx` body, parameterized by `conversationId` from the URL. Handles both `/` (no id, empty state) and `/chat/:id` (load from DB). |
| `frontend/src/components/ProtectedRoute.tsx` | Wraps a route element; redirects to `/login` when `!user`, renders a small loading state while `loading`. |
| `frontend/src/components/UserMenu.tsx` | Sidebar-bottom widget: avatar + name + sign-out. |
| `frontend/src/components/ConversationList.tsx` | Sidebar "Recent" content. Fetches via `listConversations`, renders clickable `NavLink` entries. |

### 4.3 Refactor of existing files

- **`frontend/src/main.tsx`** — wrap `<App />` in `<BrowserRouter>` and `<AuthProvider>`. Order: `BrowserRouter > AuthProvider > App` (the auth provider can use `useNavigate` only if it's inside the router).
- **`frontend/src/App.tsx`** — gutted to a tiny shell that just declares routes:
  ```tsx
  <Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<ProtectedRoute />}>
      <Route path="/" element={<Chat />} />
      <Route path="/chat/:conversationId" element={<Chat />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
  ```
  All the chat UI logic moves to `pages/Chat.tsx`.
- **`frontend/src/styles.css`** — append (do not edit existing) `.login`, `.user-menu`, `.conversation-list` styles. Palette tokens (`--amber`, `--bg`, etc.) are reused as-is.

### 4.4 Auth provider sketch

```ts
// frontend/src/lib/auth.tsx
const ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signInWithGoogle = () =>
    supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/` },
    });
  const signOut = () => supabase.auth.signOut();

  return (
    <ctx.Provider value={{ user: session?.user ?? null, session, loading, signInWithGoogle, signOut }}>
      {children}
    </ctx.Provider>
  );
}

export const useAuth = () => {
  const v = useContext(ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
};
```

### 4.5 ProtectedRoute sketch

```tsx
export function ProtectedRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-loading" />;     // tiny skeleton
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}
```

`<Outlet />` renders the matched child route (`Chat`). The Login route also gets a small inverse guard: if already authed, redirect to `/`.

---

## 5. Login screen design

```
┌─────────────────────────────────────────┐
│                                         │
│                                         │
│            CinemaDaddy                  │ ← serif, amber, 2.5rem
│       What are we watching?             │ ← muted, italic, 1rem
│                                         │
│       ┌─────────────────────────┐       │
│       │  G   Sign in with Google│       │ ← .new-chat style, ~280px wide
│       └─────────────────────────┘       │
│                                         │
│                                         │
└─────────────────────────────────────────┘
```

- Background: `var(--bg)` full viewport.
- Container: flex column, `align-items: center`, `justify-content: center`, `min-height: 100vh`, gap `2rem`.
- Logo: same serif treatment as the sidebar brand (`font-family: var(--serif)`, `color: var(--amber)`).
- Tagline: `color: var(--text-muted)`, `font-style: italic`, `font-family: var(--serif)`.
- Button: clone `.new-chat` exactly (amber border, transparent fill, `--amber-low` on hover). Add a small Google "G" inline SVG to the left of the text — Google's brand guidelines allow the multicolor G mark next to the words "Sign in with Google" on a dark surface.
- No marketing copy, no feature list, no footer.
- On error (rare for OAuth — typically only popup blocked or cancellation), render a small `var(--danger)` line below the button: "Sign-in failed. Try again."

### Login flow

1. User lands on `/login` → sees the button.
2. Click → `signInWithGoogle()` → Supabase opens the Google OAuth flow (full-page redirect by default — no popup hassles).
3. Google auth → Supabase callback (`/auth/v1/callback`) → Supabase issues session cookie + redirects back to `redirectTo: ${origin}/`.
4. On return to `/`, the AuthProvider's `onAuthStateChange` fires; session is set; `ProtectedRoute` lets Chat render.

---

## 6. Migrating chat state from localStorage to Postgres

This is the central change. Existing behavior: conversation lives in `localStorage` under `cinema-daddy-conversation`, updated only on `done` event from the server. After this change: conversation lives in Postgres, identified by URL. localStorage is removed for conversation state.

### 6.1 Routes and URL contract

| URL | Component | Initial conversation state |
|---|---|---|
| `/` | `<Chat />` | Empty (`conversation = []`); first turn lazily creates a row. |
| `/chat/:conversationId` | `<Chat />` | Hydrated from DB. |
| Invalid `:conversationId` (404 from DB or RLS denies) | redirect to `/` | (Either it's not yours or it doesn't exist.) |

`<Chat />` reads `useParams().conversationId`. When the param changes (sidebar click, new chat, browser back) it re-fetches.

### 6.2 New conversation flow (turn 1)

```
User on "/" types "Show me the Severance trailer" → Send
  │
  ├─ INSERT INTO conversations (user_id, title=null) RETURNING id  ← optimistic-ish; we await the id
  │
  ├─ Compute first user MessageParam: { role: "user", content: "Show me…" }
  ├─ INSERT INTO messages (conv_id, role, content, sequence=0)
  │
  ├─ POST /api/chat { message: "Show me…", conversation: [] }
  │   ← stream: text_delta, tool_use, text_delta, …
  │   ← live: render into streamingTurn (existing logic, unchanged)
  │   ← stream: { type: "done", conversation: [ <user>, <assistant_with_text_tool_use>, <user_tool_result>, <assistant_text> ] }
  │
  ├─ On `done`:
  │    server returned conversation length L (e.g. 4)
  │    client had length 0 (turn 1, before this write)
  │    BUT we already inserted the first user message (sequence=0)
  │    SO we INSERT messages 1..L-1 (assistant text+tool_use, user tool_result, assistant text)
  │
  ├─ UPDATE conversations
  │     SET title = COALESCE(title, <first ~30 chars of user msg>),
  │         updated_at = now()
  │   WHERE id = <new id>
  │
  ├─ navigate(`/chat/${id}`, { replace: true })  ← URL now reflects the conversation
  │
  └─ setConversation(done.conversation)  ← UI now renders from DB-equivalent state
```

Two things to highlight:

- **Bulk-insert assistant rows in one round-trip**: `supabase.from("messages").insert([row1, row2, row3])` — the rows are independent and RLS lets us insert them in a single statement.
- **The user message is inserted BEFORE posting to /api/chat**, not on the `done` event. This is so a network or server failure leaves the user's input persisted (they can refresh and resend).

### 6.3 Continuing conversation flow (turn 2+)

```
User on "/chat/abc" types another message
  │
  ├─ Current conversation array length = N (e.g. 4)
  │
  ├─ INSERT INTO messages (conv_id, role: "user", content: text, sequence=N)
  │   Optimistically: also append to local conversation state.
  │
  ├─ POST /api/chat { message, conversation: <current array> }
  │   ← stream events flow same as turn 1
  │
  ├─ On `done`:
  │    server returns conversation length L  (e.g. 7)
  │    client had length N+1=5 (after inserting user msg above)
  │    Insert messages N+1..L-1 with incrementing sequence
  │
  ├─ UPDATE conversations SET updated_at = now() WHERE id = abc
  │   (the existing trigger handles this; alternatively the client just does it explicitly so the call is cheap and deterministic)
  │
  └─ setConversation(done.conversation)
```

Sequence numbers are derived from array index — never read from the DB at insert time. The unique constraint on `(conversation_id, sequence)` prevents accidental dupes if two tabs race.

### 6.4 Tool breadcrumbs on reload

Tool breadcrumbs (the italic "→ Searching for The Bear…" lines) are derived in `deriveDisplay()` from the `tool_use` blocks inside assistant messages. Since we persist the full `ContentBlock[]` including `tool_use` blocks, breadcrumbs reappear automatically when a conversation is reloaded. **No separate storage and no extra logic** — the existing render function already does this; we just hand it a DB-hydrated array instead of a localStorage-hydrated one.

### 6.5 Loading an existing conversation

```ts
// On `/chat/:conversationId` mount or when the param changes:
const { data, error } = await supabase
  .from("messages")
  .select("role, content, sequence")
  .eq("conversation_id", conversationId)
  .order("sequence", { ascending: true });

if (error || !data) navigate("/");
else setConversation(data.map(r => ({ role: r.role, content: r.content })));
```

RLS guarantees: if the user opens `/chat/<someone-else's-id>`, the query returns `[]` (rows exist but the policy hides them). We treat zero-length results on a URL that has an id as "not yours" and redirect to `/`.

### 6.6 New Chat behavior

`handleNewChat` is currently a state reset + `localStorage.removeItem`. After this change:

```ts
function handleNewChat() {
  setConversation([]);
  setStreamingTurn(null);
  setLatestChips([]);
  setErrorMessage(null);
  navigate("/");  // empty-state UI returns; no DB row is created until first send
}
```

No DB row created. Empty conversations stay empty.

### 6.7 Sidebar "Recent" list

```ts
const { data } = await supabase
  .from("conversations")
  .select("id, title, updated_at")
  .order("updated_at", { ascending: false })
  .limit(50);
```

Render as `<NavLink to={`/chat/${id}`}>`. Active conversation gets `--amber` text + `--amber-low` background. Title fallback rules:

1. If `title` is set → use it.
2. Else → fetch the first user message's text (a small extra query, or join with the first message in the `select` chain) and use the first 30 chars.
3. Else (no messages yet — shouldn't happen because we don't create rows until first send) → "Untitled chat".

To keep this cheap, prefer option 1 and ensure title is always set after the first turn (§6.2 updates it in the same flow).

The Recent list refreshes:
- On mount.
- After every successful turn (the active conversation's `updated_at` changes; we re-fetch).
- On Supabase realtime subscription (optional polish — postgres_changes channel for the user's conversations table). v1 can skip realtime and just re-fetch after every turn.

### 6.8 Title auto-generation

**Recommend approach (a): first 30 chars of the user's first message** — free, instant, deterministic. Implemented in §6.2 as part of the same `UPDATE conversations` call. No second model round-trip, no token spend.

Approach (b) — a Haiku call to summarize the first exchange — is a nice future polish but not v1. The system already does a Haiku call for follow-up chips; adding a second adds latency and cost without changing the user experience meaningfully for v1.

### 6.9 What gets removed from `App.tsx`

| Currently in App.tsx | Fate after migration |
|---|---|
| `CONVERSATION_KEY` constant + `MAX_BYTES` | **Remove.** Conversation is in Postgres now. |
| `trimConversation`, `persistConversation`, `getInitialConversation` | **Remove.** No localStorage trimming needed. |
| `localStorage.setItem(CONVERSATION_KEY, …)` on `done` | **Replace** with DB insert(s). |
| `localStorage.removeItem(CONVERSATION_KEY)` in `handleNewChat` | **Remove.** |
| `cinema-daddy-sidebar-open` key + `getInitialSidebarOpen` | **Keep unchanged.** UI preference, not conversation state. |

---

## 7. RLS verification — smoke test

After applying the schema, do this manual test:

1. Sign in as **User A** in the running app, send a couple of messages, get a conversation row.
2. In a private window, sign in as **User B** (different Google account).
3. As User B, in the Supabase SQL editor, run:
   ```sql
   select * from public.conversations;
   select * from public.messages;
   ```
   The SQL editor uses your service role identity, so this will show everything. That's expected (it's the admin view).
4. **The real test**: as User B, in the browser, open the URL `/chat/<User A's conversation id>` (you can read User A's id from the SQL editor or from the Network tab on User A's machine).
   - Expected: the page redirects to `/` (the messages query returned zero rows — RLS hid them).
5. Also from User B's browser console, manually run:
   ```js
   await window.supabase.from("messages").select("*").eq("conversation_id", "<A's id>")
   ```
   Expected: `data: [], error: null`. RLS returns an empty set, not an error — this is correct behavior.

Document this verification step in the README too so it can be re-run anytime the schema changes.

---

## 8. Vercel deployment considerations

1. **Env vars**: add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in Vercel **Project Settings → Environment Variables** for **Production**, **Preview**, **Development**. Trigger a redeploy (Vercel doesn't pick up env changes for an existing build automatically; pushing any commit or using "Redeploy → Use existing build cache: off" works).
2. **Supabase URL allow list**: in Supabase **Authentication → URL Configuration**, add your `https://<your-domain>.vercel.app/**` (and your custom domain if any). Without this, the OAuth callback returns "Invalid redirect URL".
3. **Preview deploys**: each Vercel preview gets a unique URL like `cinema-daddy-abc123-jakeparker.vercel.app`. To allow all previews, add `https://*-jakeparker.vercel.app/**` (or whatever the team slug is) to Supabase's redirect URL list. Without this, preview deploys can't complete the OAuth flow.
4. **SPA fallback**: `react-router-dom` uses client-side routing. Vercel's static hosting needs to serve `index.html` for any unmatched path so the router can take over. The Vite framework preset on Vercel handles this out of the box for SPAs — but verify by visiting `/chat/anything` directly on the deployed URL (not via a link). If you get a 404, add `vercel.json`:
   ```json
   { "rewrites": [{ "source": "/(.*)", "destination": "/" }] }
   ```
   But preserve the `/api/*` routes — `vercel.json` would need to exclude `/api`. Simpler: rely on the Vite preset which already does this correctly. **Test before adding `vercel.json`.**
5. **OAuth end-to-end test on prod**: sign in fresh from the prod URL after deploy. The first time, the redirect URL config is the most common breakage. Confirm `auth.users` shows the row in Supabase dashboard and `profiles` was auto-populated by the trigger.

---

## 9. Build order

Each step is independently testable before moving on.

### Step 1 — Supabase project + Google OAuth (manual, dashboard)
**Files**: none (yet).
**Test**: in the Supabase dashboard, **Authentication → Users**, do nothing yet. You'll create your first user via the app in Step 3.

### Step 2 — Database schema + RLS
**Files**: `supabase/migrations/0001_init.sql` (committed for reference; applied manually via SQL editor).
**Test**: open Supabase **Table Editor**, confirm three tables exist with the expected columns. Confirm RLS shield icon is enabled on each.

### Step 3 — Supabase client + auth context + login screen + routing
**Files**: new `frontend/src/lib/supabase.ts`, `lib/auth.tsx`, `pages/Login.tsx`, `components/ProtectedRoute.tsx`, `App.tsx` shell rewrite, `main.tsx` wrap, `styles.css` login styles. Update `.env.example`, add deps to `package.json`.
**Test**: `npm run dev`. Visit `/`. Redirects to `/login`. Click Google button. After OAuth, lands on `/`. `chat` UI renders (no conversation yet — Step 5). In Supabase dashboard, **Authentication → Users** now shows your row; `profiles` table has the matching row.

### Step 4 — Protect routing fully
This is verifying Step 3, not new code. Visit `/` while signed out → `/login`. Visit `/login` while signed in → `/`.

### Step 5 — Save user + assistant messages to DB on new conversation
**Files**: `lib/db.ts` (insert helpers), `pages/Chat.tsx` (refactored from `App.tsx`; persistence on send + on `done`).
**Test**: from `/`, send a message. Confirm in Supabase Table Editor: `conversations` has 1 row (your user_id), `messages` has 2+ rows for it (user, assistant, possibly more from tool turns). URL has changed to `/chat/<id>`.

### Step 6 — Load existing conversation on route param change
**Files**: `pages/Chat.tsx` (effect on `conversationId` change → fetch messages).
**Test**: refresh `/chat/<id>` → conversation re-renders identically. Open a fresh tab to `/chat/<id>` → same.

### Step 7 — Sidebar "Recent" list
**Files**: new `components/ConversationList.tsx`, `pages/Chat.tsx` integrates it into the sidebar JSX (replaces the empty `.sidebar__history` placeholder).
**Test**: create a few conversations, switch between them via sidebar clicks. Confirm Recent ordering rises with new activity. Confirm clicking a conversation loads it.

### Step 8 — Title auto-generation
**Files**: extend `db.ts` insert flow to UPDATE the conversation's `title` to first-30-chars on first turn.
**Test**: send a message in a new chat. Sidebar Recent updates immediately with the truncated title.

### Step 9 — User menu / sign out
**Files**: new `components/UserMenu.tsx`. Rendered at the bottom of `.sidebar__expanded`. Shows avatar (from `user.user_metadata.avatar_url`), name, and a small popover or always-visible "Sign out" line.
**Test**: click sign out → redirected to `/login`, session cleared, refreshing doesn't restore.

### Step 10 — Vercel env update + production OAuth flow test
**Files**: Vercel dashboard (env vars), Supabase dashboard (allow-list prod URL).
**Test**: push to main. Wait for Vercel deploy. Visit prod URL. Run through: log in with Google → send a message → refresh → conversation persists → sign out → log in again as a different account → confirm you don't see the first account's chats.

---

## 10. Edge cases and gotchas

| Concern | Resolution |
|---|---|
| **Email confirmation flow** | Google OAuth bypasses email confirmation entirely (Google has already verified the email). No need to configure SMTP or confirmation templates. |
| **User revokes Google access externally** | Supabase's existing JWT remains valid until its TTL expires (1 hour by default). On next refresh attempt, the refresh fails and `onAuthStateChange` fires `SIGNED_OUT`. UI handles by redirecting to `/login`. Acceptable behavior — no special handling. |
| **Session refresh** | Handled automatically by `@supabase/supabase-js` (refresh-token flow on every API call within a couple of minutes of expiry). `onAuthStateChange` fires `TOKEN_REFRESHED` events — we don't need to do anything with them. |
| **Service role key safety** | Not used in this scope. If a future feature needs admin DB access (e.g. an analytics script), it lives in `process.env.SUPABASE_SERVICE_ROLE_KEY` server-side only — never `VITE_` prefixed. |
| **localStorage conflict** | Supabase stores its session under keys like `sb-<project-ref>-auth-token`. Our existing `cinema-daddy-sidebar-open` is unaffected. No conflict. |
| **Two-tab race** | If a user has two tabs open and sends from one, the other tab's local state is stale until they switch back. v1: acceptable. Polish: Supabase Realtime postgres_changes subscription to refresh the active conversation. |
| **Partial-write on `done`** | If the user closes the tab mid-stream, the user message is already in the DB (inserted on send), but the assistant rows from `done` never get written. Result: a stuck conversation showing the user message with no assistant reply. v1 acceptable; documented as known limitation. Future polish: on reload, detect a trailing user message and offer "regenerate". |
| **Conversation deletion** | Out of scope for v1. The schema supports it (`on delete cascade` on messages). UI to delete from the sidebar can be a Step 11. |
| **Anon key in client bundle** | Intentional and safe by Supabase design. The anon key only authorizes the API surface; RLS protects rows. **Confirmed earlier**: no other secrets need `VITE_*` prefix. |
| **Race between AuthProvider's initial `getSession()` and ProtectedRoute** | `loading: true` flag in the provider; `ProtectedRoute` renders a small skeleton (or nothing) until `loading` becomes false. Without this, a refresh on `/chat/abc` briefly redirects to `/login` even for authenticated users. |
| **Vercel SPA fallback for nested routes** | Vite preset handles this for most cases. If `/chat/anything` 404s on hard refresh in prod, add `vercel.json` rewrites (§8.4). |
| **Google profile data null** | `raw_user_meta_data.full_name` is reliably present; `avatar_url` is usually present. Profile trigger defaults both to `null` if missing; `UserMenu` falls back to email + initial-letter avatar. |
| **MessageParam round-trip with tool_use IDs** | The Anthropic SDK requires `tool_use_id` references inside `tool_result` blocks to match the `id` on a prior `tool_use` block. Since we persist the full `ContentBlock[]` verbatim, IDs round-trip naturally. No regeneration needed. |

---

## 11. Critical files

### New
- `/Users/jakeparker/Desktop/CinemaDaddy/PLAN-auth.md` *(this plan, copied to project root after approval)*
- `/Users/jakeparker/Desktop/CinemaDaddy/supabase/migrations/0001_init.sql`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/lib/supabase.ts`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/lib/auth.tsx`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/lib/db.ts`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/lib/types.ts`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/pages/Login.tsx`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/pages/Chat.tsx`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/components/ProtectedRoute.tsx`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/components/UserMenu.tsx`
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/components/ConversationList.tsx`

### Modified
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/App.tsx` — gutted to routing shell; chat logic moves to `pages/Chat.tsx`.
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/main.tsx` — wrap in `BrowserRouter` + `AuthProvider`.
- `/Users/jakeparker/Desktop/CinemaDaddy/frontend/src/styles.css` — append `.login`, `.user-menu`, `.conversation-list` styles. Existing rules untouched.
- `/Users/jakeparker/Desktop/CinemaDaddy/package.json` — add `@supabase/supabase-js` + `react-router-dom` deps.
- `/Users/jakeparker/Desktop/CinemaDaddy/.env.example` — add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` placeholders.
- `/Users/jakeparker/Desktop/CinemaDaddy/README.md` — new "Setup → Supabase" subsection, updated env-var list, RLS verification step.

### Unchanged
- `/Users/jakeparker/Desktop/CinemaDaddy/api/chat.ts` — still stateless, no auth check in v1 (the prod API surface is only the front-door endpoint and Anthropic credits are at risk; this is documented as a known concern from the Vercel plan, and a future hardening pass should add a Supabase JWT verification in `api/chat.ts` so the function rejects non-authenticated calls).
- `/Users/jakeparker/Desktop/CinemaDaddy/src/**` — backend modules and tools untouched.
- `/Users/jakeparker/Desktop/CinemaDaddy/vite.config.ts`, `tsconfig.json`, `frontend/tsconfig.json` — untouched.

---

## 12. Don't change (verbatim from request + earlier session constraints)

- Tool-use logic, system prompt (`src/systemPrompt.ts`), streaming behavior, markdown rendering
- Dark theater theme palette (`--bg`, `--amber`, `--text`, etc.), sidebar layout + mini-rail, composer, scrollbar styling
- TMDB / OMDb / Anthropic API integration
- The "What are we watching?" empty state — still appears in `/` (new conversation), just inside the protected app
- `cinema-daddy-sidebar-open` localStorage key (UI preference, not conversation state)
- `api/chat.ts` interface and contract — the function stays stateless; persistence is entirely client-driven via Supabase

---

## 13. Verification

After Step 10 in §9:

1. `npm run typecheck` passes both projects.
2. `npm run build` writes the bundle to `dist/`.
3. Local: `npm run dev` boots the app on `localhost:3000`. Visiting `/` redirects to `/login`. Google sign-in completes, lands on `/`. Send a message; URL changes to `/chat/<id>`. Hard refresh; conversation re-renders. Click "+ New Chat"; URL returns to `/`, empty state. Sign out; back to `/login`.
4. Database: in Supabase Table Editor, confirm `conversations` and `messages` rows belong to your `auth.users.id`. Confirm `profiles` was auto-populated.
5. RLS smoke test from §7: sign in as a second Google account, attempt to load the first account's `conversationId`, confirm redirect to `/`.
6. Push to Vercel preview. Confirm OAuth flow on the preview URL (with the right Supabase redirect URL added). Send a message on prod, refresh, confirm persistence.
7. On the deployed URL: open the Network tab while sending. Confirm:
   - One `POST` to `<supabase-url>/rest/v1/conversations` (only on first turn).
   - One `POST` to `<supabase-url>/rest/v1/messages` (user message).
   - One `POST` to `/api/chat` (Anthropic turn).
   - One `POST` to `<supabase-url>/rest/v1/messages` with N rows on `done`.
   - One `PATCH` to `<supabase-url>/rest/v1/conversations` for `updated_at` (and title on turn 1).
   - All Supabase requests carry the `Authorization: Bearer <jwt>` header — no anon-only requests for protected resources.
