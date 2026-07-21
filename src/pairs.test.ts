import { describe, expect, test } from "bun:test";

import { missingPairs, uniqueMembers } from "./pairs";

describe("pair generation", () => {
  test("deduplicates members before generating unordered pairs", () => {
    const members = uniqueMembers([
      { label: "A" },
      { label: "B" },
      { label: "A " },
      { label: "C" },
      { label: "D" },
      { label: "E" },
      { label: "F" },
    ]);

    expect(members).toHaveLength(6);
    expect(missingPairs(members)).toHaveLength(15);
  });

  test("only returns missing pairs", () => {
    const members = uniqueMembers([{ label: "A" }, { label: "B" }, { label: "C" }]);
    const existing = new Set([`${members[0]?.key}\u0000${members[1]?.key}`]);

    expect(missingPairs(members, existing)).toHaveLength(2);
  });
});
