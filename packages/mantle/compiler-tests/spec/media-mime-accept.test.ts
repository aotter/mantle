import { expect, it } from "vitest";
import { parseMimeAccept, expandPolicyRequired } from "../../src/build/spec/domain/model/MediaMimeAccept.js";
import { assertSiteDefaultsCanonical, InvalidMediaPurposesError } from "../../src/build/spec/domain/service/SiteDefaultsValidator.js";

it("expands MIME aliases, slots, whitespace and empty tokens", () => {
  for (const [input, output] of [
    ["image/jpeg", ["image/jpeg"]], ["image/avif", ["image/avif"]],
    ["webp", ["image/webp"]], ["avif", ["image/avif"]], ["png", ["image/png"]],
    ["gif", ["image/gif"]], ["svg", ["image/svg+xml"]],
    ["jpg", ["image/jpeg"]], ["jpeg", ["image/jpeg"]], ["image/jpg", ["image/jpeg"]],
    ["image/jpg,image/png", ["image/jpeg", "image/png"]], ["webp,avif", ["image/webp", "image/avif"]],
    ["  image/jpeg , image/png  ", ["image/jpeg", "image/png"]], ["jpg,jpeg,image/jpg", ["image/jpeg"]],
    [",image/jpeg,,image/png,", ["image/jpeg", "image/png"]],
    ["", []], ["   ", []], [",,,", []], ["application/wibble", ["application/wibble"]],
  ] as const) expect(parseMimeAccept(input)).toEqual(output);
  expect(expandPolicyRequired(["image/jpg,image/png", "webp", "avif"]))
    .toEqual([["image/jpeg", "image/png"], ["image/webp"], ["image/avif"]]);
  expect(expandPolicyRequired(["image/jpeg", "image/webp", "image/avif"]))
    .toEqual([["image/jpeg"], ["image/webp"], ["image/avif"]]);
});

it("accepts canonical and shorthand policies; rejects ambiguous slots and unexpanded caps", () => {
  const policy = (required: string[], maxBytes: Record<string, number>) => ({media:{purposes:[{name:"cover",required,maxBytes}]}});
  expect(() => assertSiteDefaultsCanonical(policy(["image/jpg,image/png", "webp", "avif"],
    {"image/jpeg":500_000,"image/png":600_000,"image/webp":400_000,"image/avif":300_000}))).not.toThrow();
  expect(() => assertSiteDefaultsCanonical(policy(["image/avif", "image/webp", "image/jpeg"],
    {"image/avif":200_000,"image/webp":300_000,"image/jpeg":500_000}))).not.toThrow();
  for (const value of [
    policy(["jpg,webp", "webp"], {"image/jpeg":1,"image/webp":1}),
    policy(["jpg", ",,,"], {"image/jpeg":1}), policy(["jpg", "webp"], {jpg:1,webp:1}),
  ]) expect(() => assertSiteDefaultsCanonical(value)).toThrow(InvalidMediaPurposesError);
});
