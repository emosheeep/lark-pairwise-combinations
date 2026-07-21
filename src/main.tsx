import "@mantine/core/styles.css";
import {
  Alert,
  Badge,
  Button,
  Card,
  Chip,
  Group,
  MantineProvider,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
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
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";

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
type BusyState = "init" | "preview" | "generate" | null;

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

interface Status {
  message: string;
  error: boolean;
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

function isTargetType(type: FieldType): type is TargetType {
  return TARGET_TYPES.has(type);
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

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return "读取表格失败，请稍后重试";
  if (error instanceof Error) return error.message;
  return "操作失败";
}

function chooseField(
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

function App(): React.JSX.Element {
  const [tables, setTables] = useState<ITableMeta[]>([]);
  const [sourceFields, setSourceFields] = useState<IFieldMeta[]>([]);
  const [targetFields, setTargetFields] = useState<IFieldMeta[]>([]);
  const [sourceTableId, setSourceTableId] = useState("");
  const [sourceFieldIds, setSourceFieldIds] = useState<string[]>([]);
  const [targetTableId, setTargetTableId] = useState("");
  const [leftFieldId, setLeftFieldId] = useState("");
  const [rightFieldId, setRightFieldId] = useState("");
  const [sourceFieldsLoading, setSourceFieldsLoading] = useState(false);
  const [targetFieldsLoading, setTargetFieldsLoading] = useState(false);
  const [previewState, setPreviewState] = useState<Preview | null>(null);
  const [summary, setSummary] = useState("请选择字段后预览");
  const [status, setStatus] = useState<Status>({ message: "正在读取表格…", error: false });
  const [busy, setBusy] = useState<BusyState>("init");

  const fieldsCache = useRef(new Map<string, IFieldMeta[]>());
  const refreshTimer = useRef<number | undefined>(undefined);
  const needsFieldRefresh = useRef(false);
  const previewRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshFieldsRef = useRef<() => Promise<void>>(async () => undefined);
  const runRef = useRef<(action: () => Promise<void>) => Promise<void>>(async (action) => action());
  const configRef = useRef<PluginConfig>({
    sourceTableId: "",
    sourceFieldIds: [],
    targetTableId: "",
    leftFieldId: "",
    rightFieldId: "",
  });

  const invalidatePreview = useCallback((): void => {
    setPreviewState(null);
    setSummary("请选择字段后预览");
  }, []);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      setBusy(null);
      setStatus({ message: errorMessage(error), error: true });
    }
  }, []);
  runRef.current = run;

  const loadFields = useCallback(async (tableId: string): Promise<IFieldMeta[]> => {
    if (!fieldsCache.current.has(tableId)) {
      const table = await bitable.base.getTableById(tableId);
      fieldsCache.current.set(tableId, await table.getFieldMetaList());
    }
    return fieldsCache.current.get(tableId) ?? [];
  }, []);

  const loadSourceFields = useCallback(
    async (tableId: string, preserveSelection: boolean): Promise<void> => {
      setSourceFieldsLoading(true);
      try {
        const fields = (await loadFields(tableId)).filter((field) => SOURCE_TYPES.has(field.type));
        const previous = configRef.current.sourceFieldIds;
        const next = preserveSelection
          ? previous.filter((id) => fields.some((field) => field.id === id))
          : fields
              .filter((field) => ["付款人", "消费人"].includes(field.name))
              .map((field) => field.id);
        configRef.current = { ...configRef.current, sourceTableId: tableId, sourceFieldIds: next };
        setSourceFields(fields);
        setSourceFieldIds(next);
        invalidatePreview();
      } finally {
        setSourceFieldsLoading(false);
      }
    },
    [invalidatePreview, loadFields],
  );

  const loadTargetFields = useCallback(
    async (tableId: string, preserveSelection: boolean): Promise<void> => {
      setTargetFieldsLoading(true);
      try {
        const fields = (await loadFields(tableId)).filter((field) => TARGET_TYPES.has(field.type));
        const previous = configRef.current;
        const left = chooseField(
          fields,
          preserveSelection ? previous.leftFieldId : "",
          ["甲方", "成员 A", "A"],
          0,
        );
        let right = chooseField(
          fields,
          preserveSelection ? previous.rightFieldId : "",
          ["乙方", "成员 B", "B"],
          1,
        );
        if (right === left) right = fields.find((field) => field.id !== left)?.id ?? right;
        configRef.current = {
          ...configRef.current,
          targetTableId: tableId,
          leftFieldId: left,
          rightFieldId: right,
        };
        setTargetFields(fields);
        setLeftFieldId(left);
        setRightFieldId(right);
        invalidatePreview();
      } finally {
        setTargetFieldsLoading(false);
      }
    },
    [invalidatePreview, loadFields],
  );

  const calculatePreview = useCallback(async (): Promise<void> => {
    setBusy("preview");
    setStatus({ message: "正在计算…", error: false });
    try {
      const config = configRef.current;
      if (!config.sourceFieldIds.length) throw new Error("请至少选择一个来源字段");
      if (!config.leftFieldId || !config.rightFieldId) throw new Error("目标表需要两个可写字段");
      if (config.leftFieldId === config.rightFieldId) throw new Error("A 和 B 不能写入同一个字段");

      const sourceFieldsMeta = await loadFields(config.sourceTableId);
      const sourceMeta = new Map(sourceFieldsMeta.map((field) => [field.id, field]));
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

      const targetFieldsMeta = await loadFields(config.targetTableId);
      const targetMeta = new Map(targetFieldsMeta.map((field) => [field.id, field]));
      const leftMeta = targetMeta.get(config.leftFieldId);
      const rightMeta = targetMeta.get(config.rightFieldId);
      if (!leftMeta || !rightMeta) throw new Error("找不到目标字段，请重新选择");
      if (leftMeta.type !== rightMeta.type) throw new Error("A 和 B 的字段类型必须一致");
      if (!isTargetType(leftMeta.type)) throw new Error("目标字段类型不受支持");
      if (leftMeta.type === FieldType.User && members.some((member) => !member.user?.id)) {
        throw new Error("写入人员字段时，所有来源字段也必须是人员字段");
      }

      const targetTable = await bitable.base.getTableById(config.targetTableId);
      const existing = new Set<string>();
      for (const record of await allRecords(targetTable)) {
        const left = memberFromValue(record.fields[config.leftFieldId], leftMeta.type)[0];
        const right = memberFromValue(record.fields[config.rightFieldId], rightMeta.type)[0];
        const pair = uniqueMembers(
          [left, right].filter((member): member is Member => Boolean(member)),
        );
        if (pair.length === 2 && pair[0] && pair[1]) existing.add(pairKey(pair[0], pair[1]));
      }

      const pairs = missingPairs(members, existing);
      const total = (members.length * (members.length - 1)) / 2;
      setPreviewState({ ...config, members, pairs, targetTable, targetType: leftMeta.type });
      setSummary(
        `识别 ${members.length} 个值，共 ${total} 组；已有 ${total - pairs.length} 组，本次新增 ${pairs.length} 组`,
      );
      setStatus({ message: "预览完成", error: false });
    } finally {
      setBusy(null);
    }
  }, [loadFields]);
  previewRef.current = calculatePreview;

  const generate = useCallback(async (): Promise<void> => {
    if (!previewState) return;
    setBusy("generate");
    setStatus({ message: "正在写入…", error: false });
    try {
      if (!(await bitable.base.isEditable())) {
        throw new Error("当前用户没有编辑这份多维表格的权限");
      }
      const {
        targetTable,
        targetType,
        members,
        pairs,
        leftFieldId: previewLeftFieldId,
        rightFieldId: previewRightFieldId,
      } = previewState;
      const leftValues =
        targetType === FieldType.SingleSelect
          ? await singleSelectValues(targetTable, previewLeftFieldId, members)
          : null;
      const rightValues =
        targetType === FieldType.SingleSelect
          ? await singleSelectValues(targetTable, previewRightFieldId, members)
          : null;
      const records: IRecordValue[] = pairs.map(([left, right]) => ({
        fields: {
          [previewLeftFieldId]: cellValue(left, targetType, leftValues),
          [previewRightFieldId]: cellValue(right, targetType, rightValues),
        },
      }));
      for (let index = 0; index < records.length; index += 200) {
        // oxlint-disable-next-line no-await-in-loop -- Sequential batches avoid API rate bursts.
        await targetTable.addRecords(records.slice(index, index + 200));
      }
      setStatus({ message: `已新增 ${records.length} 组`, error: false });
      await calculatePreview();
    } finally {
      setBusy(null);
    }
  }, [calculatePreview, previewState]);

  refreshFieldsRef.current = async () => {
    fieldsCache.current.clear();
    const config = configRef.current;
    await loadSourceFields(config.sourceTableId, true);
    await loadTargetFields(config.targetTableId, true);
  };

  const scheduleRefresh = useCallback((refreshFields = false): void => {
    needsFieldRefresh.current ||= refreshFields;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      void runRef.current(async () => {
        if (needsFieldRefresh.current) {
          needsFieldRefresh.current = false;
          await refreshFieldsRef.current();
        }
        if (configRef.current.sourceFieldIds.length) await previewRef.current();
      });
    }, 250);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void run(async () => {
      setBusy("init");
      const tableList = await bitable.base.getTableMetaList();
      if (cancelled) return;
      setTables(tableList);
      const source =
        tableList.find((table) => table.name === "旅行消费")?.id ?? tableList[0]?.id ?? "";
      const target =
        tableList.find((table) => ["差额计算", "两两组合"].includes(table.name))?.id ??
        tableList.find((table) => table.id !== source)?.id ??
        source;
      configRef.current = { ...configRef.current, sourceTableId: source, targetTableId: target };
      await loadSourceFields(source, false);
      await loadTargetFields(target, false);
      if (cancelled) return;
      await calculatePreview();
      if (cancelled) return;
      setSourceTableId(source);
      setTargetTableId(target);
    });
    return () => {
      cancelled = true;
    };
  }, [calculatePreview, loadSourceFields, loadTargetFields, run]);

  useEffect(() => {
    if (!sourceTableId || !targetTableId) return;
    let cancelled = false;
    const unwatch: (() => void)[] = [];
    void run(async () => {
      for (const id of new Set([sourceTableId, targetTableId])) {
        // oxlint-disable-next-line no-await-in-loop -- SDK event registration is safer sequentially.
        const table = await bitable.base.getTableById(id);
        if (cancelled) return;
        const refreshRecords = (): void => scheduleRefresh();
        const refreshFields = (): void => scheduleRefresh(true);
        unwatch.push(
          table.onRecordAdd(refreshRecords),
          table.onRecordDelete(refreshRecords),
          table.onRecordModify(refreshRecords),
          table.onFieldAdd(refreshFields),
          table.onFieldDelete(refreshFields),
          table.onFieldModify(refreshFields),
        );
      }
    });
    return () => {
      cancelled = true;
      for (const stop of unwatch) stop();
    };
  }, [run, scheduleRefresh, sourceTableId, targetTableId]);

  useEffect(() => {
    const refresh = (): void => scheduleRefresh(true);
    const refreshWhenVisible = (): void => {
      if (!document.hidden) refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearTimeout(refreshTimer.current);
    };
  }, [scheduleRefresh]);

  const tableOptions = tables.map((table) => ({ value: table.id, label: table.name }));
  const targetFieldOptions = targetFields.map((field) => ({ value: field.id, label: field.name }));
  const controlsDisabled = busy !== null;

  return (
    <main className="plugin-shell">
      <Stack gap="lg">
        <header>
          <Title order={1}>两两组合</Title>
          <Text c="dimmed">跨字段汇总去重，补齐 C(n,2) 组合</Text>
        </header>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={2}>数据来源</Title>
            <Select
              label="来源数据表"
              data={tableOptions}
              value={sourceTableId || null}
              allowDeselect={false}
              disabled={busy === "init"}
              onChange={(value) => {
                if (!value) return;
                setSourceTableId(value);
                configRef.current = { ...configRef.current, sourceTableId: value };
                void run(async () => loadSourceFields(value, false));
              }}
            />
            <Stack gap={8}>
              <Text size="sm" fw={500}>
                来源字段（可多选）
              </Text>
              {sourceFieldsLoading ? (
                <Skeleton height={32} radius="md" />
              ) : sourceFields.length ? (
                <Chip.Group
                  multiple
                  value={sourceFieldIds}
                  onChange={(values) => {
                    setSourceFieldIds(values);
                    configRef.current = { ...configRef.current, sourceFieldIds: values };
                    invalidatePreview();
                  }}
                >
                  <Group gap="xs">
                    {sourceFields.map((field) => (
                      <Chip key={field.id} value={field.id} size="sm">
                        {field.name}
                      </Chip>
                    ))}
                  </Group>
                </Chip.Group>
              ) : (
                <Text size="sm" c="dimmed">
                  当前数据表没有支持的字段
                </Text>
              )}
            </Stack>
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={2}>写入位置</Title>
            <Select
              label="目标数据表"
              data={tableOptions}
              value={targetTableId || null}
              allowDeselect={false}
              disabled={busy === "init"}
              onChange={(value) => {
                if (!value) return;
                setTargetTableId(value);
                configRef.current = { ...configRef.current, targetTableId: value };
                void run(async () => loadTargetFields(value, false));
              }}
            />
            {targetFieldsLoading ? (
              <Skeleton height={58} radius="md" />
            ) : (
              <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
                <Select
                  label="A 字段"
                  data={targetFieldOptions}
                  value={leftFieldId || null}
                  allowDeselect={false}
                  onChange={(value) => {
                    const next = value ?? "";
                    setLeftFieldId(next);
                    configRef.current = { ...configRef.current, leftFieldId: next };
                    invalidatePreview();
                  }}
                />
                <Select
                  label="B 字段"
                  data={targetFieldOptions}
                  value={rightFieldId || null}
                  allowDeselect={false}
                  onChange={(value) => {
                    const next = value ?? "";
                    setRightFieldId(next);
                    configRef.current = { ...configRef.current, rightFieldId: next };
                    invalidatePreview();
                  }}
                />
              </SimpleGrid>
            )}
          </Stack>
        </Card>

        <Alert color="blue" variant="light" radius="md">
          <Text fw={600}>{summary}</Text>
          <Text size="sm" c="dimmed" mt={4}>
            只补齐缺失组合，不修改已有记录
          </Text>
        </Alert>
      </Stack>

      <footer>
        <Badge
          variant="light"
          color={status.error ? "red" : busy ? "blue" : "green"}
          size="lg"
          radius="xl"
        >
          {status.message}
        </Badge>
        <Group gap="sm" wrap="nowrap">
          <Button
            variant="default"
            loading={busy === "preview"}
            disabled={controlsDisabled && busy !== "preview"}
            onClick={() => void run(calculatePreview)}
          >
            预览
          </Button>
          <Button
            loading={busy === "generate"}
            disabled={controlsDisabled || !previewState || previewState.pairs.length === 0}
            onClick={() => void run(generate)}
          >
            生成组合
          </Button>
        </Group>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <MantineProvider
    defaultColorScheme="light"
    theme={{
      primaryColor: "blue",
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      defaultRadius: "md",
    }}
  >
    <App />
  </MantineProvider>,
);
