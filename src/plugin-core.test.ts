import { describe, expect, test } from "bun:test";

import { createMockBase } from "./mock-base";
import { calculatePreview, generateMissingPairs } from "./plugin-core";

const config = {
  sourceTableId: "source",
  sourceFieldIds: ["payer", "consumers"],
  targetTableId: "target",
  leftFieldId: "left",
  rightFieldId: "right",
};

describe("plugin core", () => {
  test("reads, deduplicates and idempotently fills missing Base pairs", async () => {
    const base = createMockBase();
    const before = await calculatePreview(base, config);

    expect(before.members.map((member) => member.label)).toEqual([
      "秦旭洋",
      "刘润坤",
      "朱祯琳",
      "陈汝欣",
      "李白",
    ]);
    expect(before.totalPairs).toBe(10);
    expect(before.pairs).toHaveLength(7);

    expect(await generateMissingPairs(base, config)).toBe(7);
    expect((await calculatePreview(base, config)).pairs).toHaveLength(0);
    expect(await generateMissingPairs(base, config)).toBe(0);
  });

  test("keeps person sources idempotent when writing text fields", async () => {
    const base = createMockBase();
    const textConfig = {
      ...config,
      sourceFieldIds: ["people"],
      leftFieldId: "text-left",
      rightFieldId: "text-right",
    };

    expect(await generateMissingPairs(base, textConfig)).toBe(3);
    expect((await calculatePreview(base, textConfig)).pairs).toHaveLength(0);
    expect(await generateMissingPairs(base, textConfig)).toBe(0);
  });

  test("keeps user ids when writing person fields", async () => {
    const base = createMockBase();
    const userConfig = {
      ...config,
      sourceFieldIds: ["people"],
      leftFieldId: "user-left",
      rightFieldId: "user-right",
    };

    expect(await generateMissingPairs(base, userConfig)).toBe(3);
    expect((await calculatePreview(base, userConfig)).pairs).toHaveLength(0);
  });

  test("retries Base write conflicts", async () => {
    const base = createMockBase({ writeConflicts: 1 });

    expect(await generateMissingPairs(base, config)).toBe(7);
    expect((await calculatePreview(base, config)).pairs).toHaveLength(0);
  });

  test("queues concurrent runs in the same page", async () => {
    const base = createMockBase();

    expect(
      await Promise.all([generateMissingPairs(base, config), generateMissingPairs(base, config)]),
    ).toEqual([7, 0]);
  });
});
