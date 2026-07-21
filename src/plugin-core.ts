import {
  FieldType,
  IOpenSegmentType,
  type IFieldMeta,
  type IOpenCellValue,
  type IOpenSingleSelect,
  type IOpenUser,
  type IRecord,
  type IRecordValue,
  type ISingleSelectField,
  type ITable,
  type bitable,
} from "@lark-base-open/js-sdk";

import { missingPairs, pairKey, uniqueMembers, type Member, type NormalizedMember } from "./pairs";

export const SOURCE_TYPES = new Set<FieldType>([
  FieldType.Text,
  FieldType.SingleSelect,
  FieldType.MultiSelect,
  FieldType.User,
]);
export const TARGET_TYPES = new Set<FieldType>([
  FieldType.Text,
  FieldType.SingleSelect,
  FieldType.User,
]);

const MAX_PAIR_COUNT = 5000;
const WRITE_RETRY_DELAYS = [200, 500] as const;

// ponytail: one in-page queue is enough; cross-client atomicity needs a server-side unique key.
let generationQueue: Promise<void> = Promise.resolve();

export type TargetType = FieldType.Text | FieldType.SingleSelect | FieldType.User;

export interface PluginConfig {
  sourceTableId: string;
  sourceFieldIds: string[];
  targetTableId: string;
  leftFieldId: string;
  rightFieldId: string;
}

export interface Preview extends PluginConfig {
  members: NormalizedMember[];
  pairs: [NormalizedMember, NormalizedMember][];
  existingKeys: Set<string>;
  totalPairs: number;
  targetTable: ITable;
  targetType: TargetType;
}

function memberFromValue(value: IOpenCellValue | undefined, type: FieldType): Member[] {
  if (value == null) return [];

  if (type === FieldType.Text) {
    const label = Array.isArray(value)
      ? value
          .map((part) => (typeof part === "object" && part && "text" in part ? part.text : ""))
          .join("")
      : String(value);
    return [{ label }];
  }

  if (type === FieldType.SingleSelect) return [{ label: (value as IOpenSingleSelect).text }];
  if (type === FieldType.MultiSelect) {
    return (value as IOpenSingleSelect[]).map((item) => ({ label: item.text }));
  }
  if (type === FieldType.User) {
    return (value as IOpenUser[]).map((user) => ({
      label: user.name || user.email || user.id,
      user,
    }));
  }

  return [];
}

async function allRecords(table: ITable): Promise<IRecord[]> {
  const records: IRecord[] = [];
  let pageToken: number | undefined;

  do {
    // oxlint-disable-next-line no-await-in-loop -- The next page token comes from this request.
    const page = await table.getRecordsByPage({ pageSize: 200, pageToken });
    records.push(...page.records);
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined);

  return records;
}

function isTargetType(type: FieldType): type is TargetType {
  return TARGET_TYPES.has(type);
}

function isWriteConflict(error: unknown): boolean {
  if (error instanceof Error && error.message.includes("1254291")) return true;
  return Boolean(
    error && typeof error === "object" && "code" in error && String(error.code) === "1254291",
  );
}

async function withWriteRetry<T>(operation: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const delay = WRITE_RETRY_DELAYS[attempt];
    if (!isWriteConflict(error) || delay === undefined) throw error;
    await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
    return withWriteRetry(operation, attempt + 1);
  }
}

async function singleSelectValues(
  table: ITable,
  fieldId: string,
  members: NormalizedMember[],
): Promise<Map<string, IOpenSingleSelect>> {
  const field = (await table.getField(fieldId)) as ISingleSelectField;
  const existing = await field.getOptions();
  const missing = members.filter((member) => !existing.some((item) => item.name === member.label));
  if (missing.length) {
    await withWriteRetry(() => field.addOptions(missing.map((member) => ({ name: member.label }))));
  }
  return new Map(
    (await field.getOptions()).map((item) => [item.name, { id: item.id, text: item.name }]),
  );
}

function cellValue(
  member: NormalizedMember,
  type: TargetType,
  selectValues: Map<string, IOpenSingleSelect> | null,
): IOpenCellValue {
  if (type === FieldType.Text) return [{ type: IOpenSegmentType.Text, text: member.label }];
  if (type === FieldType.SingleSelect) {
    const value = selectValues?.get(member.label);
    if (!value) throw new Error(`无法创建单选选项：${member.label}`);
    return value;
  }
  if (member.user) return [member.user];
  throw new Error(`无法识别人员：${member.label}`);
}

export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return "读取表格失败，请稍后重试";
  if (error instanceof Error) return error.message;
  return "操作失败";
}

export function chooseField(
  fields: IFieldMeta[],
  current: string,
  preferredNames: string[],
  fallbackIndex: number,
): string {
  if (fields.some((field) => field.id === current)) return current;
  return (
    fields.find((field) => preferredNames.includes(field.name))?.id ??
    fields[fallbackIndex]?.id ??
    fields[0]?.id ??
    ""
  );
}

export async function calculatePreview(
  base: typeof bitable.base,
  config: PluginConfig,
): Promise<Preview> {
  if (!config.sourceTableId || !config.targetTableId) throw new Error("请先选择数据表");
  if (!config.sourceFieldIds.length) throw new Error("请至少选择一个来源字段");
  if (!config.leftFieldId || !config.rightFieldId) throw new Error("目标表需要两个可写字段");
  if (config.leftFieldId === config.rightFieldId) throw new Error("A 和 B 不能写入同一个字段");

  const sourceTable = await base.getTableById(config.sourceTableId);
  const sourceFields = await sourceTable.getFieldMetaList();
  const sourceMeta = new Map(sourceFields.map((field) => [field.id, field]));
  const sourceRecords = await allRecords(sourceTable);
  const rawMembers = sourceRecords.flatMap((record) =>
    config.sourceFieldIds.flatMap((fieldId) => {
      const field = sourceMeta.get(fieldId);
      return field ? memberFromValue(record.fields[fieldId], field.type) : [];
    }),
  );

  const targetTable = await base.getTableById(config.targetTableId);
  const targetFields = await targetTable.getFieldMetaList();
  const targetMeta = new Map(targetFields.map((field) => [field.id, field]));
  const leftMeta = targetMeta.get(config.leftFieldId);
  const rightMeta = targetMeta.get(config.rightFieldId);
  if (!leftMeta || !rightMeta) throw new Error("找不到目标字段，请重新选择");
  if (leftMeta.type !== rightMeta.type) throw new Error("A 和 B 的字段类型必须一致");
  if (!isTargetType(leftMeta.type)) throw new Error("目标字段类型不受支持");
  if (leftMeta.type === FieldType.User && rawMembers.some((member) => !member.user?.id)) {
    throw new Error("写入人员字段时，所有来源字段也必须是人员字段");
  }

  const members = uniqueMembers(
    leftMeta.type === FieldType.User
      ? rawMembers
      : rawMembers.map((member) => ({ label: member.label })),
  );
  const totalPairs = (members.length * (members.length - 1)) / 2;
  if (totalPairs > MAX_PAIR_COUNT) {
    throw new Error(`共有 ${totalPairs} 组，超过单次上限 ${MAX_PAIR_COUNT} 组，请缩小来源范围`);
  }

  const existingKeys = new Set<string>();
  for (const record of await allRecords(targetTable)) {
    const left = memberFromValue(record.fields[config.leftFieldId], leftMeta.type)[0];
    const right = memberFromValue(record.fields[config.rightFieldId], rightMeta.type)[0];
    const pair = uniqueMembers([left, right].filter((member): member is Member => Boolean(member)));
    if (pair.length === 2 && pair[0] && pair[1]) existingKeys.add(pairKey(pair[0], pair[1]));
  }

  return {
    ...config,
    members,
    pairs: missingPairs(members, existingKeys),
    existingKeys,
    totalPairs,
    targetTable,
    targetType: leftMeta.type,
  };
}

async function generateMissingPairsNow(
  base: typeof bitable.base,
  config: PluginConfig,
): Promise<number> {
  if (!(await base.isEditable())) throw new Error("当前用户没有编辑这份多维表格的权限");

  const preview = await calculatePreview(base, config);
  if (!preview.pairs.length) return 0;
  const leftValues =
    preview.targetType === FieldType.SingleSelect
      ? await singleSelectValues(preview.targetTable, preview.leftFieldId, preview.members)
      : null;
  const rightValues =
    preview.targetType === FieldType.SingleSelect
      ? await singleSelectValues(preview.targetTable, preview.rightFieldId, preview.members)
      : null;
  const records: IRecordValue[] = preview.pairs.map(([left, right]) => ({
    fields: {
      [preview.leftFieldId]: cellValue(left, preview.targetType, leftValues),
      [preview.rightFieldId]: cellValue(right, preview.targetType, rightValues),
    },
  }));

  for (let index = 0; index < records.length; index += 200) {
    // oxlint-disable-next-line no-await-in-loop -- Sequential batches avoid API rate bursts.
    await withWriteRetry(() => preview.targetTable.addRecords(records.slice(index, index + 200)));
  }
  return records.length;
}

export function generateMissingPairs(
  base: typeof bitable.base,
  config: PluginConfig,
): Promise<number> {
  const run = generationQueue.then(() => generateMissingPairsNow(base, config));
  generationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
