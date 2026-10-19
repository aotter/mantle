import { expect, it } from "vitest";
import { assertSiteDefaultsCanonical, InvalidMediaPurposesError, InvalidSiteDefaultsError, InvalidSiteIconsError } from "../../src/build/spec/domain/service/SiteDefaultsValidator.js";

it("validates site locales and preserves structured invalid-locale facts", () => {
  for (const value of [undefined, {}, {locales:[]}, {brand:"X",title:"Y"},
    {locales:["en","zh-TW","ja"]}, {locales:["en","zh-tw"]}])
    expect(() => assertSiteDefaultsCanonical(value)).not.toThrow();
  for (const locales of [["english",""], ["zh-Hant","zh-Hans"]])
    expect(() => assertSiteDefaultsCanonical({locales})).toThrow(InvalidSiteDefaultsError);
  try { assertSiteDefaultsCanonical({locales:["english","zh-TW",""]}); throw Error("expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(InvalidSiteDefaultsError); expect((error as InvalidSiteDefaultsError).invalidLocales).toEqual(["english",""]); }
});

it("accepts safe icons and refuses unsafe URLs, empty icons and malformed sizes", () => {
  expect(() => assertSiteDefaultsCanonical({icons:[
    {src:"/site-icon.svg",mimeType:"image/svg+xml",sizes:["any"]},
    {src:"https://cdn.example/icon.png",mimeType:"image/png",sizes:["64x64"]},
  ]})).not.toThrow();
  for (const src of ["javascript:alert(1)","data:image/svg+xml,x","//evil.example/x.png","/\\evil.example/x.png","http://example.com/x.png"])
    expect(() => assertSiteDefaultsCanonical({icons:[{src}]})).toThrow(InvalidSiteIconsError);
  for (const icons of [[], [{src:"/icon.png",sizes:["64"]}]])
    expect(() => assertSiteDefaultsCanonical({icons})).toThrow(InvalidSiteIconsError);
});

it("validates media names, required MIME caps and structured policy issues", () => {
  const policy = (name: string) => ({name,required:["image/avif","image/webp","image/jpeg"],maxBytes:{"image/avif":200_000,"image/webp":300_000,"image/jpeg":500_000}});
  expect(() => assertSiteDefaultsCanonical({media:{purposes:["post-cover","product-cover","product-gallery","a1b2"].map(policy)}})).not.toThrow();
  for (const media of [undefined, {}, {purposes:[]}]) expect(() => assertSiteDefaultsCanonical({media})).not.toThrow();
  const invalid: {name: string; required: string[]; maxBytes: Record<string, number>}[] = [
    ...["Post-Cover","post_cover","-leading","trailing-","double--dash",""].map(policy),
    {name:"post-cover",required:[],maxBytes:{}},
    {name:"post-cover",required:["image/avif","image/webp"],maxBytes:{"image/avif":200_000}},
    {name:"post-cover",required:["image/avif"],maxBytes:{"image/avif":0}},
  ];
  for (const value of invalid) expect(() => assertSiteDefaultsCanonical({media:{purposes:[value]}})).toThrow(InvalidMediaPurposesError);
  try {
    assertSiteDefaultsCanonical({media:{purposes:[policy("ok-one"),policy("Bad"),policy("ok-two"),{name:"missing-cap",required:["image/avif"],maxBytes:{}}]}});
    throw Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidMediaPurposesError);
    expect((error as InvalidMediaPurposesError).issues).toHaveLength(2);
    expect((error as InvalidMediaPurposesError).issues[0]).toMatchObject({name:"Bad",reason:"invalid-slug"});
    expect((error as InvalidMediaPurposesError).issues[1]).toMatchObject({name:"missing-cap",reason:"maxBytes-missing-mime"});
  }
});
