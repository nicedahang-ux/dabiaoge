import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FileUp, Upload, X, Loader2, Save, BookOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { invalidateBySourceTable } from "@/lib/dashboardHtmlCache";

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

interface SheetPreview {
  sheet_name: string;
  columns: string[];
  preview_data: string[][];
  is_truncated: boolean;
  truncated_rows: number;
}

interface ColumnMapping {
  excel_col: string;
  db_col: string;
}

interface SavedMappingConfig {
  table_name: string;
  mappings: ColumnMapping[];
  auto_clean: boolean;
}

interface TableUploadModalProps {
  tableName: string;
  schema: ColumnInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export default function TableUploadModal({
  tableName,
  schema,
  open: modalOpen,
  onOpenChange,
  onSuccess,
}: TableUploadModalProps) {
  const [filePath, setFilePath] = useState("");
  const [sheets, setSheets] = useState<SheetPreview[]>([]);
  const [selectedSheet, setSelectedSheet] = useState(0);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [uploading, setUploading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [savedConfig, setSavedConfig] = useState<SavedMappingConfig | null>(null);
  const [autoClean, setAutoClean] = useState(true);
  const [useSaved, setUseSaved] = useState(false);
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [autoMatchedCount, setAutoMatchedCount] = useState(0);

  useEffect(() => {
    if (!modalOpen) {
      resetState();
    } else {
      loadSavedConfig();
      loadRemarks();
    }
  }, [modalOpen]);

  // 智能字段匹配：表头 ↔ db 列名 / 中文备注 双向匹配
  useEffect(() => {
    if (sheets.length > 0 && schema.length > 0 && !useSaved) {
      const sheetCols = sheets[selectedSheet]?.columns || [];
      const norm = (s: string) =>
        (s || "")
          .trim()
          .toLowerCase()
          // 全角转半角
          .replace(/[！-～]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
          )
          // 去掉中英文标点和空白
          .replace(/[\s,，.。;；:：()（）\-_/\\|]/g, "");

      const usedExcel = new Set<string>();
      const tryMatch = (
        candidate: string,
        target: string,
        mode: "exact" | "contains"
      ): boolean => {
        const a = norm(candidate);
        const b = norm(target);
        if (!a || !b) return false;
        if (mode === "exact") return a === b;
        if (a.length < 2 || b.length < 2) return false;
        return a.includes(b) || b.includes(a);
      };

      const result: ColumnMapping[] = [];
      // 4 级优先级：精确名 → 精确备注 → 包含名 → 包含备注
      for (const tier of ["exact-name", "exact-remark", "contains-name", "contains-remark"] as const) {
        for (const dbCol of schema) {
          if (result.some((m) => m.db_col === dbCol.name)) continue;
          const remark = remarks[dbCol.name] || "";
          for (const sc of sheetCols) {
            if (usedExcel.has(sc)) continue;
            const target =
              tier === "exact-name" || tier === "contains-name" ? dbCol.name : remark;
            const mode = tier.startsWith("exact") ? "exact" : "contains";
            if (tryMatch(sc, target, mode)) {
              result.push({ excel_col: sc, db_col: dbCol.name });
              usedExcel.add(sc);
              break;
            }
          }
        }
      }
      setMappings(result);
      setAutoMatchedCount(result.length);
    }
  }, [sheets, selectedSheet, schema, useSaved, remarks]);

  const resetState = () => {
    setFilePath("");
    setSheets([]);
    setSelectedSheet(0);
    setMappings([]);
    setUploading(false);
    setParsing(false);
    setUseSaved(false);
  };

  const loadSavedConfig = async () => {
    try {
      const cfg = await invoke<SavedMappingConfig>("get_table_mappings", {
        tableName,
      });
      setSavedConfig(cfg.mappings.length > 0 ? cfg : null);
      setAutoClean(cfg.auto_clean);
    } catch (e) {
      console.error("加载映射配置失败:", e);
    }
  };

  const loadRemarks = async () => {
    try {
      const res = await invoke<Record<string, string>>("get_column_remarks", {
        tableName,
      });
      setRemarks(res || {});
    } catch (e) {
      console.error("加载备注失败:", e);
    }
  };

  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "表格文件", extensions: ["xlsx", "xls", "csv"] },
        ],
      });
      if (selected && typeof selected === "string") {
        setFilePath(selected);
        setParsing(true);
        try {
          const result = await invoke<{ sheets: SheetPreview[] }>("parse_excel", {
            path: selected,
          });
          setSheets(result.sheets);
          if (result.sheets.length > 0) {
            toast.success(`已解析 ${result.sheets.length} 个工作表`);
          }
        } catch (e) {
          toast.error(String(e));
        } finally {
          setParsing(false);
        }
      }
    } catch (e) {
      toast.error("选择文件失败: " + String(e));
    }
  };

  const handleUpload = async () => {
    if (!filePath) {
      toast.error("请先选择文件");
      return;
    }

    const effectiveMappings = useSaved && savedConfig ? savedConfig.mappings : mappings;

    if (effectiveMappings.length === 0) {
      toast.error("请至少配置一个字段映射");
      return;
    }

    setUploading(true);
    try {
      const inserted = await invoke<number>("import_excel_to_table", {
        filePath,
        tableName,
        mappings: effectiveMappings,
        skipHeader: true,
        useSavedMappings: useSaved,
      });
      invalidateBySourceTable(tableName);
      toast.success(`成功导入 ${inserted} 行数据`);
      onSuccess();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setUploading(false);
    }
  };

  const handleSaveMappings = async () => {
    if (mappings.length === 0) {
      toast.error("请先配置映射关系");
      return;
    }
    try {
      await invoke("save_table_mappings", {
        tableName,
        mappings,
        autoClean,
      });
      toast.success("字段映射配置已保存");
      loadSavedConfig();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const addMapping = () => {
    setMappings([...mappings, { excel_col: "", db_col: "" }]);
  };

  const removeMapping = (index: number) => {
    setMappings(mappings.filter((_, i) => i !== index));
  };

  const updateMapping = (
    index: number,
    field: keyof ColumnMapping,
    value: string
  ) => {
    const updated = [...mappings];
    updated[index] = { ...updated[index], [field]: value };
    setMappings(updated);
  };

  const sheetCols = sheets[selectedSheet]?.columns || [];

  return (
    <Dialog open={modalOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5" />
            上传表格到 {tableName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto pr-1 flex-1">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={handleSelectFile}
              disabled={parsing}
              className="flex-1 justify-start"
            >
              {parsing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileUp className="mr-2 h-4 w-4" />
              )}
              {filePath ? filePath.split(/[\\/]/).pop() : "选择表格文件"}
            </Button>
          </div>

          {savedConfig && (
            <div className="flex items-center gap-4 bg-blue-50 p-3 rounded-md">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={useSaved}
                  onChange={(e) => setUseSaved(e.target.checked)}
                  className="rounded"
                />
                <BookOpen className="h-4 w-4 text-blue-600" />
                使用已保存的字段映射（{savedConfig.mappings.length} 个字段）
              </label>
              <span className="text-xs text-slate-500 ml-auto">
                自动清洗: {savedConfig.auto_clean ? "开" : "关"}
              </span>
            </div>
          )}

          {sheets.length > 1 && (
            <div className="grid gap-2">
              <label className="text-sm font-medium">选择工作表</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={selectedSheet}
                onChange={(e) => setSelectedSheet(Number(e.target.value))}
              >
                {sheets.map((s, i) => (
                  <option key={i} value={i}>
                    {s.sheet_name} ({s.columns.length} 列)
                  </option>
                ))}
              </select>
            </div>
          )}

          {sheets.length > 0 && (
            <>
              <div className="rounded-md border bg-slate-50 p-3">
                <div className="text-xs text-slate-500 mb-1">
                  文件表头预览（前5列）
                </div>
                <div className="flex flex-wrap gap-2">
                  {sheetCols.slice(0, 5).map((col) => (
                    <span
                      key={col}
                      className="inline-flex items-center rounded-full bg-white border px-2.5 py-0.5 text-xs font-medium"
                    >
                      {col}
                    </span>
                  ))}
                  {sheetCols.length > 5 && (
                    <span className="text-xs text-slate-400 self-center">
                      +{sheetCols.length - 5} 列
                    </span>
                  )}
                </div>
              </div>

              {!useSaved && (
                <>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">字段映射</label>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-slate-500">
                        <input
                          type="checkbox"
                          checked={autoClean}
                          onChange={(e) => setAutoClean(e.target.checked)}
                          className="rounded"
                        />
                        自动清洗多余列
                      </label>
                      <Button variant="ghost" size="sm" onClick={addMapping}>
                        + 添加映射
                      </Button>
                    </div>
                  </div>

                  {autoMatchedCount > 0 && (
                    <div className="flex items-center gap-2 bg-emerald-50 text-emerald-700 px-3 py-2 rounded-md text-xs">
                      <Sparkles className="h-3.5 w-3.5" />
                      已根据表头与字段中文备注自动匹配 {autoMatchedCount} 列，可在下方调整后点击"保存为默认映射"
                    </div>
                  )}

                  {mappings.length === 0 && (
                    <div className="text-center py-4 text-sm text-slate-400 bg-slate-50 rounded-md">
                      未自动识别到匹配字段，请手动添加映射
                    </div>
                  )}

                  {mappings.map((mapping, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 bg-white border rounded-md p-2"
                    >
                      <select
                        className="flex-1 h-8 rounded border px-2 text-sm"
                        value={mapping.excel_col}
                        onChange={(e) =>
                          updateMapping(index, "excel_col", e.target.value)
                        }
                      >
                        <option value="">选择表格列</option>
                        {sheetCols.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                      <span className="text-slate-400 text-sm">→</span>
                      <select
                        className="flex-1 h-8 rounded border px-2 text-sm"
                        value={mapping.db_col}
                        onChange={(e) =>
                          updateMapping(index, "db_col", e.target.value)
                        }
                      >
                        <option value="">选择数据库列</option>
                        {schema.map((col) => (
                          <option key={col.name} value={col.name}>
                            {col.name}
                            {remarks[col.name] ? ` [${remarks[col.name]}]` : ""}
                            {" "}({col.type || "TEXT"})
                            {col.pk ? " PK" : ""}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-red-500"
                        onClick={() => removeMapping(index)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}

                  {mappings.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={handleSaveMappings}
                    >
                      <Save className="mr-2 h-3 w-3" />
                      保存为默认映射配置
                    </Button>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={handleUpload}
            disabled={uploading || (!useSaved && mappings.length === 0)}
          >
            {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Upload className="mr-2 h-4 w-4" />
            开始导入
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
