import { type IFieldMeta, type ITableMeta } from "@lark-base-open/js-sdk";
import {
  Check,
  Columns2,
  Combine,
  Database,
  GitBranch,
  Inbox,
  ListFilter,
  LoaderCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { base } from "@/base";
import { missingPairs, pairKey } from "@/pairs";
import {
  calculatePreview,
  chooseField,
  errorMessage,
  generateMissingPairs,
  SOURCE_TYPES,
  TARGET_TYPES,
  type PluginConfig,
  type Preview,
} from "@/plugin-core";
import { Badge } from "@/shadcn/components/ui/badge";
import { Button } from "@/shadcn/components/ui/button";
import { Checkbox } from "@/shadcn/components/ui/checkbox";
import { Label } from "@/shadcn/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shadcn/components/ui/select";
import { Separator } from "@/shadcn/components/ui/separator";

interface Status {
  message: string;
  error: boolean;
}

type BusyState = "init" | "generate" | null;

const initialConfig: PluginConfig = {
  sourceTableId: "",
  sourceFieldIds: [],
  targetTableId: "",
  leftFieldId: "",
  rightFieldId: "",
};

// ponytail: cap the DOM preview; add virtualization only if inspecting 100+ rows becomes common.
const PREVIEW_ROW_LIMIT = 50;

function ProductGlyph(): React.JSX.Element {
  return (
    <div className="product-glyph" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="5" cy="5" r="2" fill="currentColor" />
        <circle cx="15" cy="5" r="2" fill="currentColor" />
        <circle cx="10" cy="15" r="2" fill="currentColor" />
        <path d="M6.7 6.1 9 12.8M13.3 6.1 11 12.8M7 5h6" stroke="currentColor" />
      </svg>
    </div>
  );
}

export function ShadcnApp(): React.JSX.Element {
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<Status>({ message: "正在读取表格…", error: false });
  const [busy, setBusy] = useState<BusyState>("init");
  const [calculating, setCalculating] = useState(false);

  const configRef = useRef<PluginConfig>({ ...initialConfig });
  const fieldsCache = useRef(new Map<string, IFieldMeta[]>());
  const calculationVersion = useRef(0);
  const tableDirectoryVersion = useRef(0);
  const sourceFieldsVersion = useRef(0);
  const targetFieldsVersion = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);
  const needsFieldRefresh = useRef(false);

  const reportError = useCallback((error: unknown): void => {
    setStatus({ message: errorMessage(error), error: true });
  }, []);

  const loadFields = useCallback(async (tableId: string): Promise<IFieldMeta[]> => {
    if (!fieldsCache.current.has(tableId)) {
      const table = await base.getTableById(tableId);
      fieldsCache.current.set(tableId, await table.getFieldMetaList());
    }
    return fieldsCache.current.get(tableId) ?? [];
  }, []);

  const loadSourceFields = useCallback(
    async (tableId: string, preserveSelection: boolean): Promise<boolean> => {
      const version = ++sourceFieldsVersion.current;
      setSourceFieldsLoading(true);
      try {
        const fields = (await loadFields(tableId)).filter((field) => SOURCE_TYPES.has(field.type));
        if (
          version !== sourceFieldsVersion.current ||
          configRef.current.sourceTableId !== tableId
        ) {
          return false;
        }
        const previous = configRef.current.sourceFieldIds;
        const next = preserveSelection
          ? previous.filter((id) => fields.some((field) => field.id === id))
          : fields
              .filter((field) => ["付款人", "消费人"].includes(field.name))
              .map((field) => field.id);
        configRef.current = { ...configRef.current, sourceTableId: tableId, sourceFieldIds: next };
        setSourceFields(fields);
        setSourceFieldIds(next);
        return true;
      } catch (error) {
        if (
          version !== sourceFieldsVersion.current ||
          configRef.current.sourceTableId !== tableId
        ) {
          return false;
        }
        throw error;
      } finally {
        if (version === sourceFieldsVersion.current) setSourceFieldsLoading(false);
      }
    },
    [loadFields],
  );

  const loadTargetFields = useCallback(
    async (tableId: string, preserveSelection: boolean): Promise<boolean> => {
      const version = ++targetFieldsVersion.current;
      setTargetFieldsLoading(true);
      try {
        const fields = (await loadFields(tableId)).filter((field) => TARGET_TYPES.has(field.type));
        if (
          version !== targetFieldsVersion.current ||
          configRef.current.targetTableId !== tableId
        ) {
          return false;
        }
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
        return true;
      } catch (error) {
        if (
          version !== targetFieldsVersion.current ||
          configRef.current.targetTableId !== tableId
        ) {
          return false;
        }
        throw error;
      } finally {
        if (version === targetFieldsVersion.current) setTargetFieldsLoading(false);
      }
    },
    [loadFields],
  );

  const refreshPreview = useCallback(
    async (
      successMessage: string | null = "已实时计算",
      preserveError = false,
    ): Promise<boolean> => {
      const version = ++calculationVersion.current;
      setCalculating(true);
      setStatus((current) =>
        preserveError && current.error ? current : { message: "正在计算组合…", error: false },
      );
      try {
        const next = await calculatePreview(base, { ...configRef.current });
        if (version !== calculationVersion.current) return false;
        setPreview(next);
        if (successMessage) {
          setStatus((current) =>
            preserveError && current.error ? current : { message: successMessage, error: false },
          );
        }
        return true;
      } catch (error) {
        if (version !== calculationVersion.current) return false;
        setPreview(null);
        reportError(error);
        return false;
      } finally {
        if (version === calculationVersion.current) setCalculating(false);
      }
    },
    [reportError],
  );

  const loadTableDirectory = useCallback(async (): Promise<boolean> => {
    const version = ++tableDirectoryVersion.current;
    let tableList: ITableMeta[];
    try {
      tableList = await base.getTableMetaList();
    } catch (error) {
      if (version !== tableDirectoryVersion.current) return false;
      throw error;
    }
    if (version !== tableDirectoryVersion.current) return false;
    if (!tableList.length) throw new Error("当前多维表格没有数据表");
    setTables(tableList);

    const current = configRef.current;
    const sourceExists = tableList.some((table) => table.id === current.sourceTableId);
    const source = sourceExists
      ? current.sourceTableId
      : (tableList.find((table) => table.name === "旅行消费")?.id ?? tableList[0]?.id ?? "");
    const targetExists = tableList.some((table) => table.id === current.targetTableId);
    const target = targetExists
      ? current.targetTableId
      : (tableList.find((table) => ["差额计算", "两两组合"].includes(table.name))?.id ??
        tableList.find((table) => table.id !== source)?.id ??
        source);

    configRef.current = { ...current, sourceTableId: source, targetTableId: target };
    setSourceTableId(source);
    setTargetTableId(target);
    const [sourceApplied, targetApplied] = await Promise.all([
      loadSourceFields(source, sourceExists),
      loadTargetFields(target, targetExists),
    ]);
    return sourceApplied && targetApplied;
  }, [loadSourceFields, loadTargetFields]);

  const refreshFieldMeta = useCallback(async (): Promise<void> => {
    fieldsCache.current.clear();
    await loadTableDirectory();
  }, [loadTableDirectory]);

  const scheduleRefresh = useCallback(
    (refreshFields = false): void => {
      needsFieldRefresh.current ||= refreshFields;
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        void (async () => {
          try {
            if (needsFieldRefresh.current) {
              needsFieldRefresh.current = false;
              await refreshFieldMeta();
            }
            await refreshPreview("已实时计算", true);
          } catch (error) {
            reportError(error);
          }
        })();
      }, 250);
    },
    [refreshFieldMeta, refreshPreview, reportError],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy("init");
      try {
        const applied = await loadTableDirectory();
        if (cancelled || !applied) return;
        await refreshPreview();
      } catch (error) {
        if (!cancelled) reportError(error);
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
      calculationVersion.current += 1;
      tableDirectoryVersion.current += 1;
      sourceFieldsVersion.current += 1;
      targetFieldsVersion.current += 1;
    };
  }, [loadTableDirectory, refreshPreview, reportError]);

  useEffect(() => {
    if (!sourceTableId || !targetTableId) return;
    let cancelled = false;
    const unwatch: (() => void)[] = [];
    void Promise.all(
      [...new Set([sourceTableId, targetTableId])].map(async (id) => {
        const table = await base.getTableById(id);
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
      }),
    ).catch(reportError);
    return () => {
      cancelled = true;
      for (const stop of unwatch) stop();
    };
  }, [reportError, scheduleRefresh, sourceTableId, targetTableId]);

  useEffect(() => {
    const refresh = (): void => scheduleRefresh(true);
    const stopAdd = base.onTableAdd(refresh);
    const stopDelete = base.onTableDelete(refresh);
    return () => {
      stopAdd();
      stopDelete();
    };
  }, [scheduleRefresh]);

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

  const changeSourceTable = (value: string): void => {
    setSourceTableId(value);
    setPreview(null);
    configRef.current = { ...configRef.current, sourceTableId: value };
    setStatus({ message: "正在读取来源字段…", error: false });
    void loadSourceFields(value, false).then((applied) => {
      if (applied) void refreshPreview();
    }, reportError);
  };

  const changeTargetTable = (value: string): void => {
    setTargetTableId(value);
    setPreview(null);
    configRef.current = { ...configRef.current, targetTableId: value };
    setStatus({ message: "正在读取目标字段…", error: false });
    void loadTargetFields(value, false).then((applied) => {
      if (applied) void refreshPreview();
    }, reportError);
  };

  const toggleSourceField = (fieldId: string, checked: boolean): void => {
    const next = checked
      ? [...new Set([...configRef.current.sourceFieldIds, fieldId])]
      : configRef.current.sourceFieldIds.filter((id) => id !== fieldId);
    configRef.current = { ...configRef.current, sourceFieldIds: next };
    setSourceFieldIds(next);
    void refreshPreview();
  };

  const updateLeftField = (next: string): void => {
    const current = configRef.current;
    const right = next === current.rightFieldId ? current.leftFieldId : current.rightFieldId;
    configRef.current = { ...current, leftFieldId: next, rightFieldId: right };
    setLeftFieldId(next);
    setRightFieldId(right);
    void refreshPreview();
  };

  const updateRightField = (next: string): void => {
    const current = configRef.current;
    const left = next === current.leftFieldId ? current.rightFieldId : current.leftFieldId;
    configRef.current = { ...current, leftFieldId: left, rightFieldId: next };
    setLeftFieldId(left);
    setRightFieldId(next);
    void refreshPreview();
  };

  const generate = (): void => {
    setBusy("generate");
    setStatus({ message: "正在写入缺失组合…", error: false });
    void generateMissingPairs(base, { ...configRef.current })
      .then(async (count) => {
        window.clearTimeout(refreshTimer.current);
        needsFieldRefresh.current = false;
        await refreshPreview(count ? `已新增 ${count} 组` : "所有组合都已存在");
      })
      .catch(async (error) => {
        window.clearTimeout(refreshTimer.current);
        needsFieldRefresh.current = false;
        const refreshed = await refreshPreview(null);
        setStatus({
          message: refreshed
            ? `写入未完成，已刷新剩余组合：${errorMessage(error)}`
            : `写入未完成：${errorMessage(error)}`,
          error: true,
        });
      })
      .finally(() => setBusy(null));
  };

  const pairRows = useMemo(() => {
    if (!preview) return [];
    const pairs = missingPairs(preview.members);
    return pairs.map(([left, right]) => ({
      left,
      right,
      isNew: !preview.existingKeys.has(pairKey(left, right)),
    }));
  }, [preview]);

  const displayedPairRows = useMemo(() => {
    const rows = pairRows.slice(0, PREVIEW_ROW_LIMIT);
    const groupSizes = new Map<string, number>();
    for (const { left } of rows) groupSizes.set(left.key, (groupSizes.get(left.key) ?? 0) + 1);
    return rows.map((row) => ({
      left: row.left,
      right: row.right,
      isNew: row.isNew,
      groupSize: groupSizes.get(row.left.key) ?? 1,
    }));
  }, [pairRows]);
  const hiddenPairCount = pairRows.length - displayedPairRows.length;

  const fieldNames = useMemo(
    () => new Map(targetFields.map((field) => [field.id, field.name])),
    [targetFields],
  );
  const controlsDisabled = busy !== null;
  const mappingLoading = sourceFieldsLoading || targetFieldsLoading;
  const newPairCount = preview?.pairs.length ?? 0;
  const isActive = calculating || mappingLoading || busy === "generate";
  const statusClass = status.error ? "is-error" : isActive ? "is-busy" : "is-ready";

  return (
    <main className="flat-shell">
      <header className="flat-header">
        <ProductGlyph />
        <div className="flat-title">
          <h1>两两组合</h1>
          <p>
            汇总字段并补齐缺失的 <span className="formula">C(n,2)</span> 组合
          </p>
        </div>
        <Badge className="formula-badge" variant="outline">
          C(n,2)
        </Badge>
      </header>

      <div className="flat-content">
        <section className="flat-section" aria-labelledby="source-heading">
          <div className="flat-section-header">
            <h2 id="source-heading">数据来源</h2>
            <span>01</span>
          </div>
          <div className="property-list">
            <div className="property-row">
              <div className="field-copy">
                <Label htmlFor="source-table">
                  <Database aria-hidden="true" />
                  来源数据表
                </Label>
                <p>从这张表读取需要组合的值</p>
              </div>
              <Select
                value={sourceTableId}
                disabled={controlsDisabled}
                onValueChange={changeSourceTable}
              >
                <SelectTrigger id="source-table" className="w-full">
                  <SelectValue placeholder="请选择来源数据表" />
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
            <div className="property-row">
              <div className="field-copy">
                <div className="field-label" id="source-fields-label">
                  <ListFilter aria-hidden="true" />
                  来源字段
                </div>
                <p>可选择多个字段，所有值会合并去重</p>
              </div>
              {sourceFieldsLoading ? (
                <div className="control-placeholder">正在读取字段…</div>
              ) : sourceFields.length ? (
                <div
                  className="source-field-options"
                  role="group"
                  aria-labelledby="source-fields-label"
                >
                  {sourceFields.map((field) => (
                    <Label
                      className="source-field-option"
                      key={field.id}
                      htmlFor={`source-field-${field.id}`}
                    >
                      <Checkbox
                        id={`source-field-${field.id}`}
                        checked={sourceFieldIds.includes(field.id)}
                        disabled={controlsDisabled}
                        onCheckedChange={(value) => toggleSourceField(field.id, value === true)}
                      />
                      {field.name}
                    </Label>
                  ))}
                </div>
              ) : (
                <div className="control-placeholder">当前数据表没有支持的字段</div>
              )}
            </div>
          </div>
        </section>

        <Separator />

        <section className="flat-section" aria-labelledby="target-heading">
          <div className="flat-section-header">
            <h2 id="target-heading">写入位置</h2>
            <span>02</span>
          </div>
          <div className="property-list">
            <div className="property-row">
              <div className="field-copy">
                <Label htmlFor="target-table">
                  <Inbox aria-hidden="true" />
                  目标数据表
                </Label>
                <p>缺失的组合将新增到这张表</p>
              </div>
              <Select
                value={targetTableId}
                disabled={controlsDisabled}
                onValueChange={changeTargetTable}
              >
                <SelectTrigger id="target-table" className="w-full">
                  <SelectValue placeholder="请选择目标数据表" />
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
              <div className="control-placeholder">正在读取目标字段…</div>
            ) : (
              <>
                <div className="property-row">
                  <div className="field-copy">
                    <Label htmlFor="left-field">
                      <Columns2 aria-hidden="true" />A 字段
                    </Label>
                    <p>与 B 字段互斥，冲突时自动交换</p>
                  </div>
                  <Select
                    value={leftFieldId}
                    disabled={controlsDisabled || targetFields.length < 2}
                    onValueChange={updateLeftField}
                  >
                    <SelectTrigger id="left-field" className="w-full">
                      <SelectValue placeholder="请选择 A 字段" />
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
                <div className="property-row">
                  <div className="field-copy">
                    <Label htmlFor="right-field">
                      <Columns2 aria-hidden="true" />B 字段
                    </Label>
                    <p>与 A 字段互斥，冲突时自动交换</p>
                  </div>
                  <Select
                    value={rightFieldId}
                    disabled={controlsDisabled || targetFields.length < 2}
                    onValueChange={updateRightField}
                  >
                    <SelectTrigger id="right-field" className="w-full">
                      <SelectValue placeholder="请选择 B 字段" />
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
              </>
            )}
          </div>
        </section>

        <section
          className="pair-preview"
          aria-labelledby="pair-preview-heading"
          aria-busy={calculating}
        >
          <div className="pair-preview-header">
            <div>
              <h2 id="pair-preview-heading">组合结果</h2>
              <p className="pair-count">
                <GitBranch size={15} aria-hidden="true" />
                <strong>{preview?.members.length ?? 0} 个值</strong>
                <span>→</span>
                <strong>{preview?.totalPairs ?? 0} 组</strong>
                <span>·</span>
                <span>按 A 字段分组</span>
              </p>
            </div>
            <Badge variant={newPairCount ? "outline" : "secondary"}>
              {calculating ? "正在计算" : newPairCount ? `待新增 ${newPairCount} 组` : "已补齐"}
            </Badge>
          </div>
          {pairRows.length ? (
            <div className="pair-preview-table">
              <table>
                <caption className="sr-only">按 A 字段分组的两两组合预览</caption>
                <thead>
                  <tr>
                    <th scope="col">{fieldNames.get(leftFieldId) ?? "A 字段"}</th>
                    <th scope="col">{fieldNames.get(rightFieldId) ?? "B 字段"}</th>
                    <th scope="col" className="pair-status-column">
                      状态
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayedPairRows.map((pair, index) => {
                    const isGroupStart = displayedPairRows[index - 1]?.left.key !== pair.left.key;
                    return (
                      <tr
                        key={`${pair.left.key}-${pair.right.key}`}
                        className={pair.isNew ? "is-new" : undefined}
                      >
                        {isGroupStart && (
                          <th scope="rowgroup" rowSpan={pair.groupSize} className="pair-a-group">
                            {pair.left.label}
                          </th>
                        )}
                        <td>{pair.right.label}</td>
                        <td className="pair-status-column">
                          <span className={`pair-status ${pair.isNew ? "is-new" : "is-existing"}`}>
                            {pair.isNew ? "新增" : "已有"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {hiddenPairCount > 0 && (
                <p className="pair-preview-limit">
                  仅展示前 {PREVIEW_ROW_LIMIT} 组，另有 {hiddenPairCount}{" "}
                  组；生成时会写入全部缺失组合
                </p>
              )}
            </div>
          ) : (
            <p className="pair-preview-empty">
              {calculating
                ? "正在汇总并去重…"
                : preview
                  ? "至少需要 2 个不同的值"
                  : "完成字段设置后会在这里实时显示组合"}
            </p>
          )}
        </section>
      </div>

      <footer className="flat-actions">
        <div
          className={`flat-status ${statusClass}`}
          role={status.error ? "alert" : "status"}
          aria-live="polite"
        >
          {status.message}
        </div>
        <Button
          disabled={
            controlsDisabled || mappingLoading || calculating || !preview || newPairCount === 0
          }
          onClick={generate}
        >
          {busy === "generate" ? (
            <LoaderCircle className="spin" aria-hidden="true" />
          ) : newPairCount === 0 && preview ? (
            <Check aria-hidden="true" />
          ) : (
            <Combine aria-hidden="true" />
          )}
          {busy === "generate"
            ? "正在生成"
            : newPairCount === 0 && preview
              ? "已补齐"
              : `生成 ${newPairCount} 组`}
        </Button>
      </footer>
    </main>
  );
}
