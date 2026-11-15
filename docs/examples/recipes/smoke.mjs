// Recipes acceptance: drafts stay hidden, publishing via the Admin API makes both locales visible with SEO, JSON-LD,
// hreflang, Markdown alternates, llms.txt, sitemap and robots.
import assert from "node:assert/strict";
import { smoke } from "./smoke-kit.mjs";

const recipe = {
  slug: "scallion-pancake", title: "蔥油餅", summary: "外酥內軟的蔥油餅 </script>", total_minutes: 25, servings: 2,
  ingredients: "中筋麵粉 200 克\n熱水 120 毫升\n青蔥 3 根", steps: "揉麵團並靜置\n擀開撒蔥捲起\n小火煎至金黃",
};
const english = {
  slug: "scallion-pancake", locale: "en", title: "Scallion Pancake", summary: "Crisp outside, soft inside.",
  ingredients: "200 g all-purpose flour\n120 ml hot water\n3 scallions", steps: "Knead and rest the dough\nRoll, add scallions, coil\nPan-fry until golden",
};
const jsonLd = html => JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)[1]);

await smoke(async ({ origin, owner, call, signIn, step }) => {
  const admin = await signIn(owner);
  const create = async (collection, data) => {
    const created = await call("POST", "/admin/api/entries", { cookie: admin, body: { collection, data } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.entry;
  };
  const publish = (collection, entry) => call("POST", `/admin/api/entries/${entry.id}/publish?collection=${collection}`, { cookie: admin, body: { expectedVersion: entry.version } });
  const parent = await create("recipes", recipe), translation = await create("recipe_translations", english);
  step("admin creates a zh-TW recipe and its en translation as drafts");

  for (const path of ["/zh-TW/recipes/scallion-pancake", "/zh-TW/recipes/scallion-pancake.md", "/en/recipes/scallion-pancake"]) {
    assert.equal((await call("GET", path)).status, 404, path);
  }
  // Visitor pages read as anonymous even when the request carries an admin session.
  assert.equal((await call("GET", "/zh-TW/recipes/scallion-pancake", { cookie: admin })).status, 404);
  assert.ok(!(await call("GET", "/zh-TW/")).body.includes("scallion-pancake"));
  assert.ok(!(await call("GET", "/llms.txt")).body.includes("scallion-pancake"));
  assert.ok(!(await call("GET", "/sitemap.xml")).body.includes("scallion-pancake"));
  step("drafts are invisible to visitors: detail, Markdown, list, llms.txt and sitemap");

  assert.equal((await publish("recipe_translations", translation)).status, 409);
  const published = await publish("recipes", parent);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal((await call("GET", "/en/recipes/scallion-pancake")).status, 404);
  assert.equal((await publish("recipe_translations", translation)).status, 200);
  step("a translation cannot publish before its parent; publishing both via the Admin API");

  const zh = await call("GET", "/zh-TW/recipes/scallion-pancake");
  assert.equal(zh.status, 200);
  assert.match(zh.headers.get("content-type"), /text\/html/);
  const html = zh.body;
  assert.match(html, /<html lang="zh-TW">/);
  assert.match(html, /<title>蔥油餅 \| 食譜<\/title>/);
  assert.match(html, /<meta name="description" content="外酥內軟的蔥油餅 &lt;\/script&gt;">/);
  assert.ok(html.includes(`<link rel="canonical" href="${origin}/zh-TW/recipes/scallion-pancake">`));
  assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${origin}/zh-TW/recipes/scallion-pancake.md">`));
  step("zh-TW detail has title, description and canonical");

  for (const [lang, path] of [["zh-TW", "/zh-TW"], ["en", "/en"], ["x-default", "/zh-TW"]]) {
    assert.ok(html.includes(`<link rel="alternate" hreflang="${lang}" href="${origin}${path}/recipes/scallion-pancake">`), lang);
  }
  assert.ok(html.includes(`<a href="/en/recipes/scallion-pancake" hreflang="en" lang="en">English</a>`));
  const en = await call("GET", "/en/recipes/scallion-pancake");
  assert.equal(en.status, 200);
  assert.match(en.body, /<html lang="en">/);
  assert.ok(en.body.includes(`<link rel="canonical" href="${origin}/en/recipes/scallion-pancake">`));
  assert.ok(en.body.includes(`<link rel="alternate" hreflang="zh-TW" href="${origin}/zh-TW/recipes/scallion-pancake">`));
  assert.ok(en.body.includes(`<a href="/zh-TW/recipes/scallion-pancake" hreflang="zh-TW" lang="zh-TW">繁體中文</a>`));
  step("hreflang alternates and the locale switcher link zh-TW and en");

  const zhData = jsonLd(html), enData = jsonLd(en.body);
  assert.equal(zhData["@type"], "Recipe");
  assert.equal(zhData.name, "蔥油餅");
  assert.equal(zhData.description, recipe.summary);
  assert.deepEqual(zhData.recipeIngredient, ["中筋麵粉 200 克", "熱水 120 毫升", "青蔥 3 根"]);
  assert.equal(enData.name, "Scallion Pancake");
  assert.equal(enData.inLanguage, "en");
  assert.equal(enData.totalTime, "PT25M"); // merged from the parent row
  assert.match(zhData.datePublished, /^\d{4}-/); assert.match(zhData.dateModified, /^\d{4}-/);
  assert.ok(en.body.includes(`<meta property="og:url" content="${origin}/en/recipes/scallion-pancake">`));
  assert.ok(en.body.includes(`<meta property="og:type" content="article">`));
  assert.ok(en.body.includes(`<meta property="og:locale" content="en">`) && en.body.includes(`<meta property="og:locale:alternate" content="zh_TW">`));
  assert.match(en.body, /<section id="quick-answer"><h2>How long does it take\?<\/h2><p>About 25 minutes in total; serves 2.<\/p><\/section>/);
  step("JSON-LD Recipe parses with name and dates; Open Graph url/type/locale; the short answer block is present");

  const md = await call("GET", "/en/recipes/scallion-pancake.md");
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type"), /^text\/markdown/);
  assert.ok(md.body.startsWith("# Scallion Pancake\n"));
  assert.ok(md.body.includes("- 200 g all-purpose flour") && md.body.includes("1. Knead and rest the dough"));
  step(".md alternate returns Markdown");

  const llms = await call("GET", "/llms.txt");
  assert.ok(llms.body.includes(`- [蔥油餅](${origin}/zh-TW/recipes/scallion-pancake.md)`));
  assert.ok(llms.body.includes(`- [Scallion Pancake](${origin}/en/recipes/scallion-pancake.md)`));
  assert.ok((await call("GET", "/en/")).body.includes(`<a href="/en/recipes/scallion-pancake">Scallion Pancake</a>`));
  const home = await fetch(`${origin}/`, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), `${origin}/zh-TW/`);
  const sitemap = await call("GET", "/sitemap.xml");
  assert.match(sitemap.headers.get("content-type"), /^application\/xml/);
  for (const path of ["/zh-TW/", "/en/", "/zh-TW/recipes/scallion-pancake", "/en/recipes/scallion-pancake"]) assert.ok(sitemap.body.includes(`<loc>${origin}${path}</loc>`), path);
  const robots = await call("GET", "/robots.txt");
  assert.ok(robots.body.includes("Disallow: /admin/") && robots.body.includes(`Sitemap: ${origin}/sitemap.xml`));
  step("llms.txt, sitemap (both locales), robots and the locale lists show the published recipe; / redirects to the default locale");

  // The /app single-page app next to the server-rendered pages: its shell is noindex, members only, and never listed.
  const slug = "scallion-pancake", deep = `/app/recipes/${slug}`;
  assert.ok(html.includes(`<a href="${deep}" rel="nofollow">`), "the public detail page links into the app");
  assert.ok(!html.includes("noindex") && zh.headers.get("x-robots-tag") === null, "public pages stay indexable");
  for (const body of [sitemap.body, llms.body]) assert.ok(!body.includes("/app"), "the app is not listed in sitemap.xml or llms.txt");
  assert.ok(!robots.body.includes("/app"), "robots.txt must not hide the noindex the shell sends");
  const anonymous = await fetch(`${origin}${deep}?x=1`, { redirect: "manual" });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), `/sign-in?return=${encodeURIComponent(`${deep}?x=1`)}`);
  assert.equal((await fetch(`${origin}/app/`, { redirect: "manual" })).status, 303);
  assert.equal((await fetch(`${origin}/app/index.html`, { redirect: "manual" })).status, 404, "the shell file is not served around the sign-in check");
  const signInPage = await call("GET", "/sign-in");
  assert.equal(signInPage.status, 200);
  assert.ok(signInPage.body.includes(`<meta name="robots" content="noindex">`), "the sign-in page is noindex");
  step("an anonymous visit to /app/... is sent to sign in, with the deep link as the way back");

  const member = await signIn("member@example.test"), other = await signIn("other@example.test");
  for (const path of ["/app", "/app/", deep, "/app/some/deep/link"]) {
    const shell = await call("GET", path, { cookie: member });
    assert.equal(shell.status, 200, path);
    assert.match(shell.headers.get("content-type"), /^text\/html/);
    assert.equal(shell.headers.get("x-robots-tag"), "noindex");
    assert.ok(shell.body.includes(`<meta name="robots" content="noindex">`) && shell.body.includes(`<div id="root">`), path);
    assert.ok(!shell.body.includes("蔥油餅"), "the shell holds no recipe content");
  }
  const bundle = await call("GET", "/assets/client/spa.js");
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type"), /javascript/);
  // Not every unknown path is the app: other URLs and missing files under /app stay 404.
  for (const path of ["/nope", "/application", "/app.js", "/app/missing.js", "/app/index.html", "/zh-TW/nope", "/assets/client/missing.js"]) {
    assert.equal((await call("GET", path, { cookie: member })).status, 404, path);
  }
  assert.equal((await call("POST", deep, { cookie: member })).status, 405);
  step("/app and its deep links return the noindex shell for a member; the bundle is served; other unknown paths are 404");

  // The SPA reads Views and writes only through the REST Triggers; each member sees and changes only their own saves.
  const draft = await create("recipes", { ...recipe, slug: "draft-soup", title: "Draft soup", summary: "Not published" });
  assert.ok(draft.id);
  const save = (cookie, name) => call("PUT", `/api/saved-recipes/${name}`, { cookie });
  const mine = async cookie => (await call("GET", "/api/views/my_saved_recipes", { cookie })).body.rows;
  assert.equal((await call("GET", "/api/views/my_saved_recipes")).status, 401);
  assert.equal((await save(undefined, slug)).status, 401);
  assert.equal((await save(member, "draft-soup")).status, 404);
  assert.equal((await save(member, "no-such-recipe")).status, 404);
  assert.equal((await save(member, "Not A Slug")).status, 400);
  assert.deepEqual(await mine(member), []);
  assert.equal((await save(member, slug)).status, 200);
  assert.equal((await save(member, slug)).status, 200, "saving twice changes nothing");
  assert.deepEqual((await mine(member)).map(row => row.slug), [slug]);
  assert.equal((await mine(member))[0].title, "蔥油餅");
  assert.deepEqual(await mine(other), [], "another member sees none of it");
  // Another member's unsave matches none of their own rows (scope), so it changes nothing.
  assert.equal((await call("DELETE", `/api/saved-recipes/${slug}`, { cookie: other })).status, 200);
  assert.equal((await mine(member)).length, 1, "another member cannot unsave it");
  assert.ok((await call("GET", "/api/views/published_recipes")).body.rows.some(row => row.slug === slug), "the app lists recipes from the public View");
  step("save and unsave are REST-only, idempotent, published-only and private to each member");

  assert.equal((await call("DELETE", `/api/saved-recipes/${slug}`, { cookie: member })).status, 200);
  assert.deepEqual(await mine(member), []);
  assert.equal((await call("DELETE", `/api/saved-recipes/${slug}`, { cookie: member })).status, 200, "unsaving twice changes nothing");
  assert.equal((await save(member, slug)).status, 200);
  const unpublished = await call("POST", `/admin/api/entries/${parent.id}/unpublish?collection=recipes`, { cookie: admin, body: { expectedVersion: published.body.entry.version } });
  assert.equal(unpublished.status, 200, JSON.stringify(unpublished.body));
  assert.deepEqual(await mine(member), [], "an unpublished recipe leaves the member's list");
  step("unsave removes it; unpublishing a recipe hides it from the saved list");
});
