// "My saved recipes": the signed-in member's single-page app, served under /app. It reads the public Views
// published_recipes and my_saved_recipes and writes only through the REST Triggers PUT/DELETE /api/saved-recipes/{slug}.
// It holds no authority: the session cookie is the member's, and the server checks it on every call.
import { type ReactNode, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

interface Listed { slug: string; title: string; summary: string }

async function rows(view: string): Promise<Listed[]> {
  const response = await fetch(`/api/views/${view}`);
  if (!response.ok) throw new Error(String(response.status));
  return ((await response.json()) as { rows: Listed[] }).rows;
}

async function write(method: "PUT" | "DELETE", slug: string) {
  const response = await fetch(`/api/saved-recipes/${encodeURIComponent(slug)}`, { method });
  if (!response.ok) throw new Error(String(response.status));
}

function Link({ to, go, children }: { to: string; go: (to: string) => void; children: ReactNode }) {
  return <a href={to} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return; event.preventDefault(); go(to); }}>{children}</a>;
}

function Recipe({ recipe, saved, busy, toggle }: { recipe: Listed; saved: boolean; busy: boolean; toggle: (slug: string, saved: boolean) => void }) {
  return (
    <li>
      {/* The recipe itself lives on its public, server-rendered page. */}
      <a href={`/zh-TW/recipes/${recipe.slug}`}>{recipe.title}</a>
      <p>{recipe.summary}</p>
      <button type="button" disabled={busy} aria-pressed={saved} onClick={() => toggle(recipe.slug, saved)}>{saved ? "Unsave" : "Save"}</button>
    </li>
  );
}

function App() {
  const [path, setPath] = useState(location.pathname);
  const [all, setAll] = useState<Listed[]>();
  const [mine, setMine] = useState<Listed[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const go = (to: string) => { history.pushState(null, "", to); setPath(to); };
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const load = useCallback(async () => {
    try {
      const [recipes, saved] = await Promise.all([rows("published_recipes"), rows("my_saved_recipes")]);
      setAll(recipes); setMine(saved); setError("");
    } catch (failure) {
      // 401/403: the session ended, or this account is not a member (an admin-only session cannot save).
      setError(`Could not load your recipes (${(failure as Error).message}). `);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (slug: string, saved: boolean) => {
    setBusy(true);
    try { await write(saved ? "DELETE" : "PUT", slug); } catch (failure) { setError(`Could not change that recipe (${(failure as Error).message}). `); }
    await load();
    setBusy(false);
  };

  const savedSlugs = new Set(mine?.map(recipe => recipe.slug));
  const slug = /^\/app\/recipes\/([^/]+)$/.exec(path)?.[1];
  const shown = slug === undefined ? undefined : all?.find(recipe => recipe.slug === decodeURIComponent(slug));

  return (
    <main>
      <nav><Link to="/app/" go={go}>My saved recipes</Link> | <a href="/">All recipes (public site)</a></nav>
      {error && <p role="alert">{error}<a href={`/sign-in?return=${encodeURIComponent(path)}`}>Sign in again</a></p>}
      {!all || !mine ? (error ? null : <p role="status">Loading…</p>) : slug !== undefined ? (
        shown ? <section aria-label="Recipe"><h1>{shown.title}</h1><ul><Recipe recipe={shown} saved={savedSlugs.has(shown.slug)} busy={busy} toggle={toggle} /></ul></section>
          : <p>That recipe is not available. <Link to="/app/" go={go}>Back to my saved recipes</Link></p>
      ) : (
        <>
          <section aria-labelledby="saved"><h1 id="saved">My saved recipes</h1>
            {mine.length ? <ul>{mine.map(recipe => <Recipe key={recipe.slug} recipe={recipe} saved busy={busy} toggle={toggle} />)}</ul> : <p>Nothing saved yet.</p>}
          </section>
          <section aria-labelledby="all"><h2 id="all">All recipes</h2>
            <ul>{all.map(recipe => <Recipe key={recipe.slug} recipe={recipe} saved={savedSlugs.has(recipe.slug)} busy={busy} toggle={toggle} />)}</ul>
          </section>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
