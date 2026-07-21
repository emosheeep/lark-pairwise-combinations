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

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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

  const controlsDisabled = busy !== null;

  return (
    <main className="plugin-shell">
      <div className="space-y-5">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">两两组合</h1>
          <p className="text-sm text-muted-foreground">跨字段汇总去重，补齐 C(n,2) 组合</p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>数据来源</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>来源数据表</Label>
              <Select
                value={sourceTableId}
                disabled={busy === "init"}
                onValueChange={(value) => {
                  setSourceTableId(value);
                  configRef.current = { ...configRef.current, sourceTableId: value };
                  void run(async () => loadSourceFields(value, false));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择数据表" />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((table) => (
                    <SelectItem key={table.id} value={table.id}>
                      {table.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>来源字段（可多选）</Label>
              {sourceFieldsLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : sourceFields.length ? (
                <div className="flex flex-wrap gap-2">
                  {sourceFields.map((field) => {
                    const checked = sourceFieldIds.includes(field.id);
                    return (
                      <Label
                        key={field.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 font-normal hover:bg-accent"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => {
                            const values = next
                              ? [...sourceFieldIds, field.id]
                              : sourceFieldIds.filter((id) => id !== field.id);
                            setSourceFieldIds(values);
                            configRef.current = {
                              ...configRef.current,
                              sourceFieldIds: values,
                            };
                            invalidatePreview();
                          }}
                        />
                        {field.name}
                      </Label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">当前数据表没有支持的字段</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>写入位置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>目标数据表</Label>
              <Select
                value={targetTableId}
                disabled={busy === "init"}
                onValueChange={(value) => {
                  setTargetTableId(value);
                  configRef.current = { ...configRef.current, targetTableId: value };
                  void run(async () => loadTargetFields(value, false));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择数据表" />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((table) => (
                    <SelectItem key={table.id} value={table.id}>
                      {table.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {targetFieldsLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {[
                  { label: "A 字段", value: leftFieldId, side: "left" },
                  { label: "B 字段", value: rightFieldId, side: "right" },
                ].map(({ label, value, side }) => (
                  <div key={side} className="space-y-2">
                    <Label>{label}</Label>
                    <Select
                      value={value}
                      onValueChange={(next) => {
                        if (side === "left") {
                          setLeftFieldId(next);
                          configRef.current = { ...configRef.current, leftFieldId: next };
                        } else {
                          setRightFieldId(next);
                          configRef.current = { ...configRef.current, rightFieldId: next };
                        }
                        invalidatePreview();
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择字段" />
                      </SelectTrigger>
                      <SelectContent>
                        {targetFields.map((field) => (
                          <SelectItem key={field.id} value={field.id}>
                            {field.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Alert className="border-blue-200 bg-blue-50 text-blue-950">
          <AlertTitle>{summary}</AlertTitle>
          <AlertDescription>只补齐缺失组合，不修改已有记录</AlertDescription>
        </Alert>
      </div>

      <footer className="plugin-footer">
        <Badge
          variant={status.error ? "destructive" : "secondary"}
          className="max-w-[45%] truncate"
        >
          {status.message}
        </Badge>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            disabled={controlsDisabled && busy !== "preview"}
            onClick={() => void run(calculatePreview)}
          >
            {busy === "preview" ? "预览中…" : "预览"}
          </Button>
          <Button
            disabled={controlsDisabled || !previewState || previewState.pairs.length === 0}
            onClick={() => void run(generate)}
          >
            {busy === "generate" ? "生成中…" : "生成组合"}
          </Button>
        </div>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
