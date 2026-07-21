import {
  bitable,
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
  type ITableMeta,
} from "@lark-base-open/js-sdk";

import { missingPairs, pairKey, uniqueMembers, type Member, type NormalizedMember } from "./pairs";
import "./style.css";

const SOURCE_TYPES = new Set<FieldType>([
  FieldType.Text,
  FieldType.SingleSelect,
  FieldType.MultiSelect,
  FieldType.User,
]);
const TARGET_TYPES = new Set<FieldType>([FieldType.Text, FieldType.SingleSelect, FieldType.User]);

type TargetType = FieldType.Text | FieldType.SingleSelect | FieldType.User;

interface PluginConfig {
  sourceTableId: string;
  sourceFieldIds: string[];
  targetTableId: string;
  leftFieldId: string;
  rightFieldId: string;
}

interface Preview extends PluginConfig {
  members: NormalizedMember[];
  pairs: [NormalizedMember, NormalizedMember][];
  targetTable: ITable;
  targetType: TargetType;
}

const state: {
  tables: ITableMeta[];
  fields: Map<string, IFieldMeta[]>;
  preview: Preview | null;
} = { tables: [], fields: new Map(), preview: null };

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`找不到页面元素：${id}`);
  return found as T;
}

function select(id: string): HTMLSelectElement {
  return element<HTMLSelectElement>(id);
}

function option(meta: { id: string; name: string }): HTMLOptionElement {
  return new Option(meta.name, meta.id);
}

function setStatus(message: string, error = false): void {
  const status = element("status");
  status.textContent = message;
  status.classList.toggle("error", error);
}

function selectByName(target: HTMLSelectElement, name: string): void {
  const match = [...target.options].find((item) => item.text === name);
  if (match) target.value = match.value;
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
    // oxlint-disable-next-line no-await-in-loop -- The next page token is returned by this request.
    const page = await table.getRecordsByPage({ pageSize: 200, pageToken });
    records.push(...page.records);
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined);

  return records;
}

async function loadFields(tableId: string): Promise<IFieldMeta[]> {
  if (!state.fields.has(tableId)) {
    const table = await bitable.base.getTableById(tableId);
    state.fields.set(tableId, await table.getFieldMetaList());
  }
  return state.fields.get(tableId) ?? [];
}

async function renderSourceFields(): Promise<void> {
  const fields = (await loadFields(select("source-table").value)).filter((field) =>
    SOURCE_TYPES.has(field.type),
  );
  element("source-fields").replaceChildren(
    ...fields.map((field) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = field.id;
      input.checked = ["付款人", "消费人"].includes(field.name);
      label.append(input, field.name);
      return label;
    }),
  );
  invalidatePreview();
}

async function renderTargetFields(): Promise<void> {
  const fields = (await loadFields(select("target-table").value)).filter((field) =>
    TARGET_TYPES.has(field.type),
  );
  for (const id of ["left-field", "right-field"]) select(id).replaceChildren(...fields.map(option));
  selectByName(select("left-field"), "甲方");
  selectByName(select("right-field"), "乙方");
  invalidatePreview();
}

function invalidatePreview(): void {
  state.preview = null;
  element<HTMLButtonElement>("generate").disabled = true;
  element("summary").textContent = "请选择字段后预览";
}

function readConfig(): PluginConfig {
  const sourceFieldIds = [
    ...document.querySelectorAll<HTMLInputElement>("#source-fields input:checked"),
  ].map((input) => input.value);
  if (!sourceFieldIds.length) throw new Error("请至少选择一个成员字段");
  if (!select("left-field").value || !select("right-field").value) {
    throw new Error("目标表需要两个可写的成员字段");
  }
  if (select("left-field").value === select("right-field").value) {
    throw new Error("成员 A 和成员 B 不能写入同一个字段");
  }

  return {
    sourceTableId: select("source-table").value,
    sourceFieldIds,
    targetTableId: select("target-table").value,
    leftFieldId: select("left-field").value,
    rightFieldId: select("right-field").value,
  };
}

function isTargetType(type: FieldType): type is TargetType {
  return TARGET_TYPES.has(type);
}

async function preview(): Promise<void> {
  setStatus("正在计算…");
  const config = readConfig();
  const sourceFields = await loadFields(config.sourceTableId);
  const sourceMeta = new Map(sourceFields.map((field) => [field.id, field]));
  const sourceTable = await bitable.base.getTableById(config.sourceTableId);
  const sourceRecords = await allRecords(sourceTable);
  const members = uniqueMembers(
    sourceRecords.flatMap((record) =>
      config.sourceFieldIds.flatMap((fieldId) => {
        const field = sourceMeta.get(fieldId);
        return field ? memberFromValue(record.fields[fieldId], field.type) : [];
      }),
    ),
  );

  const targetFields = await loadFields(config.targetTableId);
  const targetMeta = new Map(targetFields.map((field) => [field.id, field]));
  const leftMeta = targetMeta.get(config.leftFieldId);
  const rightMeta = targetMeta.get(config.rightFieldId);
  if (!leftMeta || !rightMeta) throw new Error("找不到目标字段，请重新选择");
  if (leftMeta.type !== rightMeta.type) throw new Error("成员 A 和成员 B 的字段类型必须一致");
  if (!isTargetType(leftMeta.type)) throw new Error("目标字段类型不受支持");
  if (leftMeta.type === FieldType.User && members.some((member) => !member.user?.id)) {
    throw new Error("写入人员字段时，所有来源字段也必须是人员字段");
  }

  const targetTable = await bitable.base.getTableById(config.targetTableId);
  const existing = new Set<string>();
  for (const record of await allRecords(targetTable)) {
    const left = memberFromValue(record.fields[config.leftFieldId], leftMeta.type)[0];
    const right = memberFromValue(record.fields[config.rightFieldId], rightMeta.type)[0];
    const pair = uniqueMembers([left, right].filter((member): member is Member => Boolean(member)));
    if (pair.length === 2 && pair[0] && pair[1]) existing.add(pairKey(pair[0], pair[1]));
  }

  const pairs = missingPairs(members, existing);
  state.preview = { ...config, members, pairs, targetTable, targetType: leftMeta.type };
  const total = (members.length * (members.length - 1)) / 2;
  element("summary").textContent =
    `识别 ${members.length} 人，共 ${total} 组；已有 ${total - pairs.length} 组，本次新增 ${pairs.length} 组`;
  element<HTMLButtonElement>("generate").disabled = pairs.length === 0;
  setStatus("预览完成");
}

async function singleSelectValues(
  table: ITable,
  fieldId: string,
  members: NormalizedMember[],
): Promise<Map<string, IOpenSingleSelect>> {
  const field = (await table.getField(fieldId)) as ISingleSelectField;
  const existing = await field.getOptions();
  const missing = members.filter((member) => !existing.some((item) => item.name === member.label));
  if (missing.length) await field.addOptions(missing.map((member) => ({ name: member.label })));
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

async function generate(): Promise<void> {
  if (!state.preview) return;
  if (!(await bitable.base.isEditable())) throw new Error("当前用户没有编辑这份多维表格的权限");

  const { targetTable, targetType, members, pairs, leftFieldId, rightFieldId } = state.preview;
  element<HTMLButtonElement>("generate").disabled = true;
  setStatus("正在写入…");
  const leftValues =
    targetType === FieldType.SingleSelect
      ? await singleSelectValues(targetTable, leftFieldId, members)
      : null;
  const rightValues =
    targetType === FieldType.SingleSelect
      ? await singleSelectValues(targetTable, rightFieldId, members)
      : null;

  const records: IRecordValue[] = pairs.map(([left, right]) => ({
    fields: {
      [leftFieldId]: cellValue(left, targetType, leftValues),
      [rightFieldId]: cellValue(right, targetType, rightValues),
    },
  }));
  for (let index = 0; index < records.length; index += 200) {
    // oxlint-disable-next-line no-await-in-loop -- Sequential batches avoid API rate bursts.
    await targetTable.addRecords(records.slice(index, index + 200));
  }
  setStatus(`已新增 ${records.length} 组`);
  await preview();
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "操作失败", true);
  }
}

async function init(): Promise<void> {
  state.tables = await bitable.base.getTableMetaList();
  for (const id of ["source-table", "target-table"]) {
    select(id).replaceChildren(...state.tables.map(option));
  }
  selectByName(select("source-table"), "旅行消费");
  selectByName(select("target-table"), "差额计算");
  await Promise.all([renderSourceFields(), renderTargetFields()]);
  select("source-table").addEventListener("change", () => run(renderSourceFields));
  select("target-table").addEventListener("change", () => run(renderTargetFields));
  element("source-fields").addEventListener("change", invalidatePreview);
  select("left-field").addEventListener("change", invalidatePreview);
  select("right-field").addEventListener("change", invalidatePreview);
  element("preview").addEventListener("click", () => run(preview));
  element("generate").addEventListener("click", () => run(generate));
  setStatus("已自动识别常用字段");
  await run(preview);
}

void run(init);
