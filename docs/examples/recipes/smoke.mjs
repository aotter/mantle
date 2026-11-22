// Recipes acceptance: drafts stay hidden, publishing via the Admin API makes both locales visible with SEO, JSON-LD,
// hreflang, Markdown alternates, llms.txt, sitemap and robots; every page is complete server-rendered HTML read with
// plain fetch (no JavaScript), states its Cache-Control, is the same for every visitor, and loads React only late.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { smoke } from "./smoke-kit.mjs";

const recipe = {
  slug: "scallion-pancake", title: "Scallion Pancake", summary: "Crisp outside, soft inside. </script>", total_minutes: 25, servings: 2,
  ingredients: "200 g all-purpose flour\n120 ml hot water\n3 scallions", steps: "Knead and rest the dough\nRoll, add scallions, coil\nPan-fry until golden",
};
const french = {
  slug: "scallion-pancake", locale: "fr", title: "Galette aux oignons verts", summary: "Croustillante dehors, moelleuse dedans.",
  ingredients: "200 g de farine\n120 ml d’eau chaude\n3 oignons verts", steps: "Pétrir et laisser reposer la pâte\nÉtaler, ajouter les oignons et rouler\nFaire dorer à la poêle",
};
const PUBLIC = "public, max-age=60, stale-while-revalidate=600, stale-if-error=86400";
const jsonLd = html => JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)[1]);
// Elements `<name ...>text</name>` with their attributes (names lower-cased: React writes hrefLang, charSet) and text.
const elements = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*?)/?>(?:([^<]*)</${name}>)?`, "gi"))]
  .map(([, attributes, text]) => ({ text, ...Object.fromEntries([...attributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k.toLowerCase(), v])) }));
const has = (html, name, attributes, text) =>
  elements(html, name).some(e => Object.entries(attributes).every(([k, v]) => e[k] === v) && (text === undefined || e.text === text));
const cached = (response, expected, what) => assert.equal(response.headers.get("cache-control"), expected, `${what}: Cache-Control`);

await smoke(async ({ origin, owner, call, signIn, step }) => {
  const admin = await signIn(owner);
  const create = async (collection, data) => {
    const created = await call("POST", "/admin/api/entries", { cookie: admin, body: { collection, data } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.entry;
  };
  const publish = (collection, entry) => call("POST", `/admin/api/entries/${entry.id}/publish?collection=${collection}`, { cookie: admin, body: { expectedVersion: entry.version } });
  const parent = await create("recipes", recipe), translation = await create("recipe_translations", french);
  step("admin creates a en recipe and its fr translation as drafts");

  for (const path of ["/en/recipes/scallion-pancake", "/en/recipes/scallion-pancake.md", "/fr/recipes/scallion-pancake"]) {
    const missing = await call("GET", path);
    assert.equal(missing.status, 404, path);
    cached(missing, "no-store", path);
  }
  // Visitor pages read as anonymous even when the request carries an admin session.
  assert.equal((await call("GET", "/en/recipes/scallion-pancake", { cookie: admin })).status, 404);
  assert.equal((await call("GET", "/en/recipes/scallion-pancake.md", { cookie: admin })).status, 404);
  assert.ok(!(await call("GET", "/en/")).body.includes("scallion-pancake"));
  assert.ok(!(await call("GET", "/llms.txt")).body.includes("scallion-pancake"));
  assert.ok(!(await call("GET", "/sitemap.xml")).body.includes("scallion-pancake"));
  step("drafts are invisible to visitors: detail, Markdown, list, llms.txt and sitemap");

  assert.equal((await publish("recipe_translations", translation)).status, 409);
  const published = await publish("recipes", parent);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal((await call("GET", "/fr/recipes/scallion-pancake")).status, 404);
  assert.equal((await publish("recipe_translations", translation)).status, 200);
  step("a translation cannot publish before its parent; publishing both via the Admin API");

  const en = await call("GET", "/en/recipes/scallion-pancake");
  assert.equal(en.status, 200);
  assert.match(en.headers.get("content-type"), /text\/html/);
  cached(en, PUBLIC, "detail page");
  const html = en.body;
  assert.match(html, /^<!doctype html><html lang="en">/);
  assert.match(html, /<title>Scallion Pancake \| Recipes<\/title>/);
  assert.ok(has(html, "meta", { name: "description", content: "Crisp outside, soft inside. &lt;/script&gt;" }));
  assert.ok(html.includes(`<link rel="canonical" href="${origin}/en/recipes/scallion-pancake">`));
  assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${origin}/en/recipes/scallion-pancake.md">`));
  step("en detail has title, description and canonical");

  // The content is in the HTML body, not added by script.
  assert.ok(has(html, "h1", {}, "Scallion Pancake"), "the title is the h1");
  for (const item of recipe.ingredients.split("\n")) assert.ok(has(html, "li", {}, item), item);
  const steps = elements(html, "li").map(e => e.text).filter(text => recipe.steps.split("\n").includes(text));
  assert.deepEqual(steps, recipe.steps.split("\n"), "the steps, in order");
  step("the detail HTML holds the title in an h1, every ingredient and every step");

  for (const [lang, path] of [["en", "/en"], ["fr", "/fr"], ["x-default", "/en"]]) {
    assert.ok(has(html, "link", { rel: "alternate", hreflang: lang, href: `${origin}${path}/recipes/scallion-pancake` }), lang);
  }
  assert.ok(has(html, "a", { href: "/fr/recipes/scallion-pancake", hreflang: "fr", lang: "fr" }, "Français"));
  const fr = await call("GET", "/fr/recipes/scallion-pancake");
  assert.equal(fr.status, 200);
  assert.match(fr.body, /<html lang="fr">/);
  assert.ok(fr.body.includes(`<link rel="canonical" href="${origin}/fr/recipes/scallion-pancake">`));
  assert.ok(has(fr.body, "link", { rel: "alternate", hreflang: "en", href: `${origin}/en/recipes/scallion-pancake` }));
  assert.ok(has(fr.body, "a", { href: "/en/recipes/scallion-pancake", hreflang: "en", lang: "en" }, "English"));
  assert.ok(has(fr.body, "h1", {}, french.title) && has(fr.body, "li", {}, "3 oignons verts") && has(fr.body, "li", {}, "Faire dorer à la poêle"));
  step("hreflang alternates and the locale switcher link en and fr; the fr page holds its own content");

  const enData = jsonLd(html), frData = jsonLd(fr.body);
  assert.equal(enData["@type"], "Recipe");
  assert.equal(enData.name, "Scallion Pancake");
  assert.equal(enData.description, recipe.summary);
  assert.deepEqual(enData.recipeIngredient, ["200 g all-purpose flour", "120 ml hot water", "3 scallions"]);
  assert.equal(frData.name, french.title);
  assert.equal(frData.inLanguage, "fr");
  assert.equal(frData.totalTime, "PT25M"); // merged from the parent row
  assert.match(enData.datePublished, /^\d{4}-/); assert.match(enData.dateModified, /^\d{4}-/);
  assert.ok(has(fr.body, "meta", { property: "og:url", content: `${origin}/fr/recipes/scallion-pancake` }));
  assert.ok(has(fr.body, "meta", { property: "og:type", content: "article" }));
  assert.ok(has(fr.body, "meta", { property: "og:locale", content: "fr" }) && has(fr.body, "meta", { property: "og:locale:alternate", content: "en" }));
  assert.match(fr.body, /<section id="quick-answer"[^>]*><h2[^>]*>Combien de temps faut-il \?<\/h2><p>Environ 25 minutes au total, pour 2 personnes.<\/p><\/section>/);
  step("JSON-LD Recipe parses with name and dates; Open Graph url/type/locale; the short answer block is present");

  // The .md alternate is the whole recipe, composed in the View's SQL.
  const md = await call("GET", "/fr/recipes/scallion-pancake.md");
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type"), /^text\/markdown/);
  cached(md, PUBLIC, ".md");
  assert.ok(md.body.startsWith("# Galette aux oignons verts\n\nCroustillante dehors, moelleuse dedans.\n"));
  assert.ok(md.body.includes("## Ingrédients\n\n200 g de farine\n120 ml d’eau chaude\n3 oignons verts\n"));
  assert.ok(md.body.includes("## Étapes\n\nPétrir et laisser reposer la pâte\nÉtaler, ajouter les oignons et rouler\nFaire dorer à la poêle\n"));
  const enMd = await call("GET", "/en/recipes/scallion-pancake.md");
  assert.ok(enMd.body.startsWith("# Scallion Pancake\n") && enMd.body.includes("## Ingredients\n\n200 g all-purpose flour\n") && enMd.body.includes("## Steps\n\nKnead and rest the dough\n"));
  // Each locale's Markdown names that locale's HTML page as canonical, on PUBLIC_ORIGIN.
  assert.equal(md.headers.get("link"), `<${origin}/fr/recipes/scallion-pancake>; rel="canonical"`);
  assert.equal(enMd.headers.get("link"), `<${origin}/en/recipes/scallion-pancake>; rel="canonical"`);
  step(".md alternate returns the whole recipe as Markdown: title, summary, ingredients and steps, with a canonical Link");

  const llms = await call("GET", "/llms.txt");
  assert.match(llms.headers.get("content-type"), /^text\/plain/);
  cached(llms, PUBLIC, "llms.txt");
  assert.equal(llms.headers.get("link"), null);
  assert.ok(llms.body.includes(`- [Scallion Pancake](${origin}/en/recipes/scallion-pancake.md)`));
  assert.ok(llms.body.includes(`- [Galette aux oignons verts](${origin}/fr/recipes/scallion-pancake.md)`));
  // List Views carry no body: sitemap.xml and llms.txt walk them row by row. llms.txt still links each `.md`.
  for (const path of ["/api/views/published_recipes", "/api/views/published_translations?locale=fr", "/api/views/translation_index"]) {
    const rows = (await call("GET", path)).body.rows;
    assert.equal(rows.length, 1, path);
    for (const key of ["markdown", "steps", "ingredients"]) assert.ok(!(key in rows[0]), `${path} returns ${key}`);
  }
  for (const [locale, title, summary] of [["en", recipe.title, recipe.summary], ["fr", french.title, french.summary]]) {
    const list = await call("GET", `/${locale}/`);
    cached(list, PUBLIC, `/${locale}/`);
    assert.ok(has(list.body, "a", { href: `/${locale}/recipes/scallion-pancake` }, title), locale);
    assert.ok(list.body.includes(summary.replace("<", "&lt;").replace(">", "&gt;")), locale);
  }
  const home = await fetch(`${origin}/`, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), `${origin}/en/`);
  cached(home, "no-store", "redirect");
  const sitemap = await call("GET", "/sitemap.xml");
  assert.match(sitemap.headers.get("content-type"), /^application\/xml/);
  cached(sitemap, PUBLIC, "sitemap.xml");
  for (const path of ["/en/", "/fr/", "/en/recipes/scallion-pancake", "/fr/recipes/scallion-pancake"]) assert.ok(sitemap.body.includes(`<loc>${origin}${path}</loc>`), path);
  assert.match(sitemap.body, new RegExp(`<loc>${origin}/fr/recipes/scallion-pancake</loc><lastmod>\\d{4}-`));
  const robots = await call("GET", "/robots.txt");
  cached(robots, PUBLIC, "robots.txt");
  assert.ok(robots.body.includes("Disallow: /admin/") && robots.body.includes(`Sitemap: ${origin}/sitemap.xml`));
  step("llms.txt, sitemap (both locales, lastmod), robots and the locale lists show the published recipe; / redirects to the default locale");

  // Every visitor gets the same bytes, so a shared cache may keep them: a member's or an admin's page is the anonymous one.
  const member = await signIn("member@example.test"), other = await signIn("other@example.test");
  for (const path of ["/en/recipes/scallion-pancake", "/fr/", "/fr/recipes/scallion-pancake.md", "/llms.txt"]) {
    const anonymous = await call("GET", path);
    for (const cookie of [member, admin]) {
      const signedIn = await call("GET", path, { cookie });
      assert.equal(signedIn.body, anonymous.body, path);
      cached(signedIn, PUBLIC, `${path} signed in`);
      assert.equal(signedIn.headers.get("set-cookie"), null, path);
    }
  }
  const head = await fetch(`${origin}/en/recipes/scallion-pancake`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  cached(head, PUBLIC, "HEAD");
  assert.ok(!html.includes("noindex") && en.headers.get("x-robots-tag") === null, "public pages stay indexable");
  for (const path of ["/nope", "/application", "/de/", "/en/nope", "/en/recipes/Not-A-Slug", "/en/recipes/nope.md"]) {
    const missing = await call("GET", path, { cookie: member });
    assert.equal(missing.status, 404, path);
    cached(missing, "no-store", path);
  }
  // /assets/* is served by the edge without the Worker (run_worker_first excludes it), so its 404 is the platform's;
  // plain fetch, as the kit's `call` asserts the Worker's own Cache-Control.
  assert.equal((await fetch(`${origin}/assets/client/missing.js`)).status, 404);
  const post = await call("POST", "/en/recipes/scallion-pancake", { cookie: member });
  assert.equal(post.status, 405);
  cached(post, "no-store", "405");
  const signInPage = await call("GET", "/sign-in");
  assert.equal(signInPage.status, 200);
  assert.ok(signInPage.body.includes(`<meta name="robots" content="noindex">`), "the sign-in page is noindex");
  cached(signInPage, "no-store", "/sign-in");
  step("signed-in visitors get the anonymous page; HEAD, 404, 405 and the sign-in page state their Cache-Control");

  // One stylesheet, and one small module script; the save button's React bundle is fetched later by that script. All
  // three are the content-hashed copies this build wrote (@aotter/mantle/client-assets), cached for a day.
  const hashed = name => new RegExp(`^/assets/client/h/${name}-[0-9a-f]{16}\\.(?:js|css)$`);
  const scripts = elements(html, "script").filter(e => e.src);
  assert.equal(scripts.length, 1, "one script");
  assert.equal(scripts[0].type, "module");
  assert.match(scripts[0].src, hashed("page"), "the only script is the module loader's hashed copy");
  const stylesheets = elements(html, "link").filter(e => e.rel === "stylesheet");
  assert.equal(stylesheets.length, 1, "one stylesheet");
  assert.match(stylesheets[0].href, hashed("page"));
  const islandSrc = elements(html, "div").find(e => e["data-island-src"])?.["data-island-src"];
  assert.match(islandSrc ?? "", hashed("save"), "the island's hashed URL is written into its markup");
  assert.ok(!html.includes("modulepreload") && !scripts.some(e => e.src === islandSrc), "the island's bundle is not loaded by the HTML");
  assert.ok(has(html, "button", { type: "button" }, "儲存這道Recipes"), "the button is server-rendered");
  const IMMUTABLE = "public, max-age=86400, immutable";
  const asset = async (path, cacheControl) => {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    // `wrangler dev` applies the build's _headers rule as the edge does; a stable name keeps the platform default
    assert.equal(response.headers.get("cache-control"), cacheControl, `${path}: Cache-Control`);
    return { type: response.headers.get("content-type"), text: await response.text() };
  };
  const loader = await asset(scripts[0].src, IMMUTABLE), loaderCode = loader.text;
  assert.ok(loaderCode.length < 1024 && !/react/i.test(loaderCode), "the loader is small and has no React");
  const island = await asset(islandSrc, IMMUTABLE);
  assert.match(island.type, /javascript/);
  const css = (await asset(stylesheets[0].href, IMMUTABLE)).text;
  // The stable names still answer, with the same bytes, revalidated on each use.
  const REVALIDATE = "public, max-age=0, must-revalidate";
  assert.equal((await asset("/assets/client/page.js", REVALIDATE)).text, loaderCode);
  assert.equal((await asset("/assets/client/save.js", REVALIDATE)).text, island.text);
  assert.equal((await asset("/assets/client/page.css", REVALIDATE)).text, css);
  // A name this build does not have is the edge's 404 (an open tab after a deploy; the loader then reloads once), with the
  // same rule, which is why the rule is one day.
  assert.equal((await fetch(`${origin}/assets/client/h/save-0000000000000000.js`)).status, 404);
  step("pages link the content-hashed loader, stylesheet and island, served immutable; the stable names still answer");
  // A class `hover:bg-primary/80` is the selector `.hover\:bg-primary\/80`, not followed by more of a name.
  const defined = name => {
    const selector = "." + name.replace(/[^\w-]/g, "\\$&");
    for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) if (!/[\w\\-]/.test(css[at + selector.length] ?? "")) return true;
    return false;
  };
  for (const page of [html, fr.body, (await call("GET", "/en/")).body]) {
    for (const [, names] of page.matchAll(/\bclass="([^"]*)"/g)) for (const name of names.split(" ")) assert.ok(defined(name), `class ${name} is in page.css`);
  }
  // React is reached only through import() from the routes: the Worker's static graph (the entry and every chunk it
  // imports statically, as first-load.mjs in the handbook counts it) holds no React, and a lazy chunk does.
  const graph = new Set(), entry = resolve("dist/worker/index.js");
  const visit = file => {
    if (graph.has(file)) return;
    graph.add(file);
    for (const [, path] of readFileSync(file, "utf8").matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]*?from\s*)?["'](\.{1,2}\/[^"']+)["']/g)) visit(resolve(dirname(file), path));
  };
  visit(entry);
  const react = file => /react\.transitional\.element|renderToString/.test(readFileSync(file, "utf8"));
  for (const file of graph) assert.ok(!react(file), `${file} is in the Worker's static graph and holds React`);
  const chunks = readdirSync("dist/worker/chunks").map(name => resolve("dist/worker/chunks", name));
  assert.ok(chunks.some(file => !graph.has(file) && react(file)), "a lazily imported chunk holds React");
  step("pages link one stylesheet with every class they use and one small module loader; React is not in the Worker's startup graph");

  // The island loader in Chrome. It runs when MANTLE_TEST_CHROMIUM names a Chrome; the repository's Full checks set it.
  if (!process.env.MANTLE_TEST_CHROMIUM) step("skipped the island loader run in Chrome: set MANTLE_TEST_CHROMIUM to a Chrome or Chromium binary");
  else {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ headless: true, executablePath: process.env.MANTLE_TEST_CHROMIUM });
    const SAVE = "**/assets/client/h/save-*.js";
    // One visit in a fresh tab tall enough that the island loads at once; counts the page's loads (1 + reloads).
    // `island`: before the loader reads the page, add a second island with this `src` (`add`; before the save island with
    // `first`) or rewrite the save island's.
    const visit = async ({ route, island } = {}) => {
      const context = await browser.newContext({ viewport: { width: 800, height: 4000 } });
      const page = await context.newPage();
      let loads = 0;
      const requests = [];
      page.on("framenavigated", frame => frame === page.mainFrame() && loads++);
      page.on("request", request => requests.push(`${request.method()} ${request.url()}`));
      if (route) await page.route(SAVE, request => route(request, context));
      // runs in the page, so it closes over nothing: its value is the argument
      if (island) await page.addInitScript(({ src, add, first }) => document.addEventListener("readystatechange", () => {
        if (document.readyState !== "interactive") return;
        if (!add) return void (document.querySelector("[data-island-src]").dataset.islandSrc = src);
        const element = Object.assign(document.createElement("div"), { textContent: "island" });
        element.dataset.islandSrc = src;
        document.body[first ? "prepend" : "append"](element);
      }), island);
      await page.goto(`${origin}/en/recipes/scallion-pancake`);
      await page.waitForTimeout(2000);
      const [keys, srcs] = await page.evaluate(() => [Object.keys(sessionStorage), [...document.querySelectorAll("[data-island-src]")].map(e => e.dataset.islandSrc)]);
      await context.close();
      return { loads, keys, srcs, requests, island: requests.filter(r => r.startsWith(`GET ${origin}${islandSrc}`)).length };
    };
    try {
      const fine = await visit();
      assert.equal(fine.loads, 1);
      assert.equal(fine.island, 1, "the island loads from its hashed URL");
      assert.ok(fine.requests.some(r => r.includes("/api/views/my_saved_recipes")), "the island hydrated and asked for the saves");
      // gone (404): one reload, then the same URL never reloads again; the guard names the URL
      const gone = await visit({ route: request => request.fulfill({ status: 404, body: "gone" }) });
      assert.equal(gone.loads, 2, "a 404 island reloads the page once");
      assert.deepEqual(gone.keys, [`island-reloaded ${islandSrc}`]);
      // another island loading does not clear the guard of one that is gone: one reload, not a loop
      const goneSrc = "/assets/client/h/gone-0000000000000000.js";
      const two = await visit({ island: { src: goneSrc, add: true } });
      assert.deepEqual(two.srcs, [islandSrc, goneSrc]);
      assert.equal(two.loads, 2, "two islands, one gone: one reload");
      assert.equal(two.island, 2, "the save island loaded on both loads");
      assert.deepEqual(two.keys, [`island-reloaded ${goneSrc}`]);
      // a malformed URL is ignored, and the island observed after it, in the same batch, still loads
      const malformed = await visit({ island: { src: "http://[", add: true, first: true } });
      assert.deepEqual(malformed.srcs, ["http://[", islandSrc]);
      assert.equal(malformed.loads, 1);
      assert.equal(malformed.island, 1, "a malformed island URL before a working island: the working one still loads");
      // not a missing file: no reload
      for (const [what, route] of [
        ["a blocked request", request => request.abort("blockedbyclient")],
        ["an error in the island's code", request => request.fulfill({ status: 200, contentType: "text/javascript", body: "throw new Error('island')" })],
        ["offline", async (request, context) => (await context.setOffline(true), request.abort("internetdisconnected"))],
      ]) assert.equal((await visit({ route })).loads, 1, `${what}: no reload`);
      // an island URL on another origin or outside /assets/client/ is never imported
      for (const src of ["https://example.invalid/assets/client/x.js", "/api/views/my_saved_recipes", "/assets/../api/x.js"]) {
        const other = await visit({ island: { src } });
        assert.deepEqual(other.srcs, [src]);
        assert.equal(other.loads, 1, src);
        assert.ok(!other.requests.some(r => r.includes("example.invalid") || r.includes("/api/")), `${src}: requested`);
      }
    } finally {
      await browser.close();
    }
    step("in Chrome: the island hydrates from its hashed URL; a 404 reloads once per URL, also beside a working island; offline, a blocked request, a failing island or a foreign URL never reload; a malformed URL does not stop the next island");
  }

  // The save button reads the member's saves and writes only through the REST Triggers; each member sees and changes
  // only their own saves.
  const slug = "scallion-pancake";
  const draft = await create("recipes", { ...recipe, slug: "draft-soup", title: "Draft soup", summary: "Not published" });
  assert.ok(draft.id);
  const save = (cookie, name) => call("PUT", `/api/saved-recipes/${name}`, { cookie });
  const mine = async cookie => (await call("GET", "/api/views/my_saved_recipes", { cookie })).body.rows;
  assert.equal((await call("GET", `/api/views/my_saved_recipes?slug=${slug}`)).status, 401, "the button sends an anonymous visitor to sign in");
  assert.equal((await save(undefined, slug)).status, 401);
  assert.equal((await save(member, "draft-soup")).status, 404);
  assert.equal((await save(member, "no-such-recipe")).status, 404);
  assert.equal((await save(member, "Not A Slug")).status, 400);
  assert.deepEqual(await mine(member), []);
  assert.equal((await save(member, slug)).status, 200);
  assert.equal((await save(member, slug)).status, 200, "saving twice changes nothing");
  assert.deepEqual((await mine(member)).map(row => row.slug), [slug]);
  assert.equal((await mine(member))[0].title, "Scallion Pancake");
  assert.deepEqual((await call("GET", `/api/views/my_saved_recipes?slug=${slug}`, { cookie: member })).body.rows.map(row => row.slug), [slug]);
  assert.deepEqual((await call("GET", "/api/views/my_saved_recipes?slug=other", { cookie: member })).body.rows, []);
  assert.deepEqual(await mine(other), [], "another member sees none of it");
  // Another member's unsave matches none of their own rows (scope), so it changes nothing.
  assert.equal((await call("DELETE", `/api/saved-recipes/${slug}`, { cookie: other })).status, 200);
  assert.equal((await mine(member)).length, 1, "another member cannot unsave it");
  assert.equal((await call("GET", "/en/recipes/scallion-pancake", { cookie: member })).body, html, "a member's saves never reach the page");
  step("save and unsave are REST-only, idempotent, published-only and private to each member");

  assert.equal((await call("DELETE", `/api/saved-recipes/${slug}`, { cookie: member })).status, 200);
  assert.deepEqual(await mine(member), []);
  assert.equal((await call("DELETE", `/api/saved-recipes/${slug}`, { cookie: member })).status, 200, "unsaving twice changes nothing");
  assert.equal((await save(member, slug)).status, 200);
  const unpublished = await call("POST", `/admin/api/entries/${parent.id}/unpublish?collection=recipes`, { cookie: admin, body: { expectedVersion: published.body.entry.version } });
  assert.equal(unpublished.status, 200, JSON.stringify(unpublished.body));
  assert.deepEqual(await mine(member), [], "an unpublished recipe leaves the member's list");
  for (const path of ["/en/recipes/scallion-pancake", "/fr/recipes/scallion-pancake", "/fr/recipes/scallion-pancake.md"]) assert.equal((await call("GET", path)).status, 404, path);
  step("unsave removes it; unpublishing a recipe hides it from the saved list, both locales and the Markdown");
});
