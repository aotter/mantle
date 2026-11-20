// The save button's island, loaded by src/client/page.ts. It hydrates the server-rendered SaveButton (src/pages.tsx)
// with the same props, then asks whether the member saved this recipe. It writes only through the REST Triggers
// PUT/DELETE /api/saved-recipes/{slug} and holds no authority: the session cookie is the member's, checked by the server
// on every call. Anonymous visitors go to /sign-in and come back. React, and kit components if it used them, load here.
import { useEffect, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { SaveButton } from "../pages.js";

type Props = { slug: string; label: { save: string; saved: string } };
type State = "loading" | "signed-out" | "saved" | "unsaved" | "busy";

function Save({ slug, label, clicked }: Props & { clicked: boolean }) {
  // The first render must equal the server's markup: "loading" renders the static button.
  const [state, setState] = useState<State>("loading");
  const [pending, setPending] = useState(clicked);
  useEffect(() => {
    // 401 for an anonymous visitor (the View requires a signed-in member).
    fetch(`/api/views/my_saved_recipes?slug=${slug}`)
      .then(async response => setState(!response.ok ? "signed-out" : ((await response.json()) as { rows: unknown[] }).rows.length ? "saved" : "unsaved"), () => setState("signed-out"));
  }, [slug]);
  useEffect(() => {
    if (pending && state !== "loading") { setPending(false); act(); }
  }, [pending, state]);

  function act() {
    if (state === "loading") return setPending(true);
    if (state === "signed-out") return location.assign(`/sign-in?return=${encodeURIComponent(location.pathname)}`);
    const was = state;
    setState("busy");
    fetch(`/api/saved-recipes/${slug}`, { method: was === "saved" ? "DELETE" : "PUT" })
      .then(response => setState(response.ok ? (was === "saved" ? "unsaved" : "saved") : was), () => setState(was));
  }
  const saved = state === "saved" ? true : state === "unsaved" ? false : undefined;
  return <SaveButton label={saved ? label.saved : label.save} saved={saved} busy={state === "busy"} onClick={act} />;
}

export function mount(element: HTMLElement, clicked: boolean) {
  hydrateRoot(element, <Save {...(JSON.parse(element.dataset.props!) as Props)} clicked={clicked} />);
}
