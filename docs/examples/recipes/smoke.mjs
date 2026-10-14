// Recipes acceptance: drafts stay hidden, publishing via the Admin API makes both locales visible with SEO, JSON-LD,
// hreflang, Markdown alternates and llms.txt.
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
  step("drafts are invisible to visitors: detail, Markdown, list and llms.txt");

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
  step("llms.txt and the locale lists show the published recipe; / redirects to the default locale");
});
