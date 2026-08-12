import { describe, expect, it } from "vitest";

import { initialsFor } from "../src/layout/nav-user";

describe("initialsFor", () => {
  it.each([
    ["local-admin", "LA"],
    ["guyspy", "GU"],
    ["Ada Lovelace", "AL"],
    [null, "?"],
  ])("turns %s into %s", (login, expected) => {
    expect(initialsFor(login)).toBe(expected);
  });
});
