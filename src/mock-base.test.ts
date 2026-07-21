import { describe, expect, test } from "bun:test";
import type { ITable } from "@lark-base-open/js-sdk";

import { createMockBase } from "./mock-base";

async function recordCount(table: ITable): Promise<number> {
  let count = 0;
  let pageToken: number | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- The next page token comes from this request.
    const page = await table.getRecordsByPage({ pageSize: 200, pageToken });
    count += page.records.length;
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined);
  return count;
}

describe("local Base mock", () => {
  test("serves tables and persists generated records in memory", async () => {
    const base = createMockBase();
    expect((await base.getTableMetaList()).map((table) => table.name)).toEqual([
      "旅行消费",
      "差额计算",
    ]);

    const target = await base.getTableById("target");
    const firstPage = await target.getRecordsByPage({ pageSize: 200 });
    expect(firstPage.records).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    const beforeCount = await recordCount(target);
    await target.addRecords([
      {
        fields: {
          left: { id: "person-a", text: "A" },
          right: { id: "person-b", text: "B" },
        },
      },
    ]);
    expect(await recordCount(target)).toBe(beforeCount + 1);
  });
});
