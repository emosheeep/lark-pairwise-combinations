import {
  FieldType,
  IOpenSegmentType,
  type IFieldMeta,
  type IRecord,
  type IRecordValue,
  type ITable,
  type ITableMeta,
  type bitable,
} from "@lark-base-open/js-sdk";

interface MockTable {
  meta: ITableMeta;
  fields: IFieldMeta[];
  records: IRecord[];
  options: Map<string, { id: string; name: string }[]>;
  listeners: Set<() => void>;
}

interface MockRuntime {
  writeConflicts: number;
}

function createSourceTable(): MockTable {
  return {
    meta: { id: "source", name: "旅行消费", isSync: false },
    fields: [
      { id: "description", name: "内容", type: FieldType.Text },
      { id: "category", name: "分类", type: FieldType.SingleSelect },
      { id: "payer", name: "付款人", type: FieldType.SingleSelect },
      { id: "consumers", name: "消费人", type: FieldType.MultiSelect },
      { id: "people", name: "人员", type: FieldType.User },
    ] as IFieldMeta[],
    records: (
      [
        ["高铁票", "交通", "秦旭洋", ["秦旭洋", "刘润坤", "朱祯琳"]],
        ["酒店", "住宿", "刘润坤", ["刘润坤", "陈汝欣"]],
        ["晚餐", "餐饮", "朱祯琳", ["朱祯琳", "李白"]],
      ] satisfies [string, string, string, string[]][]
    ).map(([description, category, payer, consumers], index) => ({
      recordId: `expense-${index + 1}`,
      fields: {
        description: [{ type: IOpenSegmentType.Text, text: description }],
        category: { id: `category-${category}`, text: category },
        payer: { id: `person-${payer}`, text: payer },
        consumers: (consumers as string[]).map((name) => ({ id: `person-${name}`, text: name })),
        people: [{ id: `user-${payer}`, name: payer }],
      },
    })),
    options: new Map(),
    listeners: new Set(),
  };
}

function createTargetTable(): MockTable {
  return {
    meta: { id: "target", name: "差额计算", isSync: false },
    fields: [
      { id: "left", name: "甲方", type: FieldType.SingleSelect },
      { id: "right", name: "乙方", type: FieldType.SingleSelect },
      { id: "text-left", name: "文本 A", type: FieldType.Text },
      { id: "text-right", name: "文本 B", type: FieldType.Text },
      { id: "user-left", name: "人员 A", type: FieldType.User },
      { id: "user-right", name: "人员 B", type: FieldType.User },
    ] as IFieldMeta[],
    records: (
      [
        ["秦旭洋", "刘润坤"],
        ["秦旭洋", "朱祯琳"],
        ["刘润坤", "陈汝欣"],
      ] satisfies [string, string][]
    ).map(([left, right], index) => ({
      recordId: `pair-${index + 1}`,
      fields: {
        left: { id: `person-${left}`, text: left },
        right: { id: `person-${right}`, text: right },
      },
    })),
    options: new Map([
      ["left", []],
      ["right", []],
    ]),
    listeners: new Set(),
  };
}

function mockTable(table: MockTable, runtime: MockRuntime): ITable {
  const watch = (listener: () => void): (() => void) => {
    table.listeners.add(listener);
    return () => table.listeners.delete(listener);
  };

  return {
    getFieldMetaList: async () => table.fields,
    getRecordsByPage: async ({ pageSize = 200, pageToken = 0 } = {}) => {
      const size = Math.min(pageSize, 2);
      const records = table.records.slice(pageToken, pageToken + size);
      const nextPageToken = pageToken + records.length;
      return {
        records,
        hasMore: nextPageToken < table.records.length,
        pageToken: nextPageToken,
      };
    },
    getField: async (fieldId: string) => ({
      getOptions: async () => table.options.get(fieldId) ?? [],
      addOptions: async (options: { name: string }[]) => {
        const current = table.options.get(fieldId) ?? [];
        current.push(
          ...options.map((option, index) => ({
            id: `${fieldId}-${current.length + index + 1}`,
            name: option.name,
          })),
        );
        table.options.set(fieldId, current);
      },
    }),
    addRecords: async (records: IRecordValue[]) => {
      if (runtime.writeConflicts > 0) {
        runtime.writeConflicts -= 1;
        throw Object.assign(new Error("1254291: concurrent write conflict"), { code: 1254291 });
      }
      table.records.push(
        ...records.map((record, index) => ({
          recordId: `generated-${table.records.length + index + 1}`,
          fields: record.fields,
        })),
      );
      for (const listener of table.listeners) listener();
    },
    onRecordAdd: watch,
    onRecordDelete: watch,
    onRecordModify: watch,
    onFieldAdd: watch,
    onFieldDelete: watch,
    onFieldModify: watch,
  } as unknown as ITable;
}

export function createMockBase({
  writeConflicts = 0,
}: { writeConflicts?: number } = {}): typeof bitable.base {
  const sourceTable = createSourceTable();
  const targetTable = createTargetTable();
  const runtime = { writeConflicts };
  const tables = new Map([
    [sourceTable.meta.id, sourceTable],
    [targetTable.meta.id, targetTable],
  ]);

  return {
    getTableMetaList: async () => [...tables.values()].map((table) => table.meta),
    getTableById: async (id: string) => {
      const table = tables.get(id);
      if (!table) throw new Error(`Mock 数据表不存在：${id}`);
      return mockTable(table, runtime);
    },
    isEditable: async () => true,
    onTableAdd: () => () => undefined,
    onTableDelete: () => () => undefined,
  } as unknown as typeof bitable.base;
}
