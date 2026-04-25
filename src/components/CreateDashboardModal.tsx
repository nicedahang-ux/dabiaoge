import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  UploadCloud,
  FileCode2,
  FileSpreadsheet,
  CheckCircle2,
  X,
  AlertTriangle,
  Loader2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import CreateDashboardTracker from "./CreateDashboardTracker";

interface NewFileSpec {
  file_path: string;
  target_table_name: string;
}

interface SheetPreview {
  sheet_name: string;
  columns: string[];
  preview_data: string[][];
  is_truncated: boolean;
  truncated_rows: number;
}

interface ParseResult {
  sheets: SheetPreview[];
}

interface CreateDashboardResult {
  dashboard_id: string;
  dashboard_name: string;
  created_tables: string[];
  warnings: string[];
}

interface FileEntry {
  file: File;
  path: string;
  targetTable: string;
  preview: ParseResult | null;
  loading: boolean;
}

function sanitizeTableName(name: string): string {
  return name
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9_一-龥]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
}

interface CreateDashboardModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}

export default function CreateDashboardModal({
  open,
  onOpenChange,
  onCreated,
}: CreateDashboardModalProps) {
  const [step, setStep] = useState(1);
  const [htmlContent, setHtmlContent] = useState("");
  const [htmlFileName, setHtmlFileName] = useState("");
  const [newFiles, setNewFiles] = useState<FileEntry[]>([]);
  const [existingTables, setExistingTables] = useState<string[]>([]);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [dashboardName, setDashboardName] = useState("");
  const [trackerActive, setTrackerActive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreateDashboardResult | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdTablesOnError, setCreatedTablesOnError] = useState<string[]>([]);

  // 加载已有表
  useEffect(() => {
    if (open && step === 1) {
      invoke<string[]>("get_db_tables")
        .then((tables) => setExistingTables(tables))
        .catch(() => setExistingTables([]));
    }
  }, [open, step]);

  // 重置状态
  const resetState = useCallback(() => {
    setStep(1);
    setHtmlContent("");
    setHtmlFileName("");
    setNewFiles([]);
    setSelectedTables(new Set());
    setDashboardName("");
    setTrackerActive(false);
    setCreating(false);
    setResult(null);
    setCreateError(null);
    setCreatedTablesOnError([]);
  }, []);

  useEffect(() => {
    if (!open) {
      resetState();
    }
  }, [open, resetState]);

  // HTML dropzone
  const onDropHtml = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".html") && !file.name.toLowerCase().endsWith(".htm")) {
      toast.error("请上传 .html 文件");
      return;
    }
    file.text().then((text) => {
      setHtmlContent(text);
      setHtmlFileName(file.name);
    });
  }, []);

  const {
    getRootProps: getHtmlRootProps,
    getInputProps: getHtmlInputProps,
    isDragActive: isHtmlDragActive,
  } = useDropzone({
    onDrop: onDropHtml,
    accept: { "text/html": [".html", ".htm"] },
    multiple: false,
  });

  // Data file dropzone
  const onDropData = useCallback((acceptedFiles: File[]) => {
    for (const file of acceptedFiles) {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (!["xlsx", "xls", "csv"].includes(ext || "")) continue;
      // @ts-expect-error electron/tauri specific path property
      const path = file?.path as string | undefined;
      if (!path) {
        toast.error(`无法获取文件路径: ${file.name}`);
        continue;
      }
      const entry: FileEntry = {
        file,
        path,
        targetTable: sanitizeTableName(file.name),
        preview: null,
        loading: true,
      };
      setNewFiles((prev) => [...prev, entry]);
      // 解析预览
      invoke<ParseResult>("parse_excel", { path })
        .then((res) => {
          setNewFiles((prev) =>
            prev.map((f) =>
              f.path === path ? { ...f, preview: res, loading: false } : f
            )
          );
        })
        .catch((e) => {
          toast.error(`${file.name} 预览失败: ${String(e)}`);
          setNewFiles((prev) =>
            prev.map((f) =>
              f.path === path ? { ...f, loading: false } : f
            )
          );
        });
    }
  }, []);

  const {
    getRootProps: getDataRootProps,
    getInputProps: getDataInputProps,
    isDragActive: isDataDragActive,
  } = useDropzone({
    onDrop: onDropData,
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
        ".xlsx",
      ],
      "application/vnd.ms-excel": [".xls"],
      "text/csv": [".csv"],
    },
    multiple: true,
  });

  const removeNewFile = (path: string) => {
    setNewFiles((prev) => prev.filter((f) => f.path !== path));
  };

  const updateTargetTable = (path: string, value: string) => {
    setNewFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, targetTable: value } : f))
    );
  };

  const toggleExistingTable = (table: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  const canProceed =
    htmlContent.length > 0 &&
    (newFiles.length > 0 || selectedTables.size > 0);

  const handleCreate = async () => {
    if (!canProceed) return;
    setStep(2);
    setTrackerActive(true);
    setCreating(true);
    setCreateError(null);
    try {
      const spec: NewFileSpec[] = newFiles.map((f) => ({
        file_path: f.path,
        target_table_name: f.targetTable || sanitizeTableName(f.file.name),
      }));
      const res = await invoke<CreateDashboardResult>(
        "create_dashboard_from_template",
        {
          htmlContent,
          newFiles: spec,
          existingTables: Array.from(selectedTables),
          dashboardName: dashboardName.trim() || undefined,
        }
      );
      setResult(res);
      setStep(3);
      toast.success(`看板「${res.dashboard_name}」创建成功`);
      if (res.warnings.length > 0) {
        res.warnings.forEach((w) => toast.warning(w));
      }
    } catch (e) {
      const msg = String(e);
      setCreateError(msg);
      // 尝试从错误信息中提取已建表名（后端会在错误中包含已建表信息）
      // 这里简化处理，实际回滚需要用户手动触发
      setStep(2);
    } finally {
      setCreating(false);
      setTrackerActive(false);
    }
  };

  const handleRollback = async () => {
    const toDrop = createdTablesOnError.length > 0
      ? createdTablesOnError
      : newFiles.map((f) => f.targetTable || sanitizeTableName(f.file.name));
    if (toDrop.length === 0) return;
    try {
      await invoke("rollback_created_tables", { tableNames: toDrop });
      toast.success(`已清理 ${toDrop.length} 张临时表`);
      setCreatedTablesOnError([]);
    } catch (e) {
      toast.error("回滚失败: " + String(e));
    }
  };

  useEffect(() => {
    if (step === 3 && result) {
      const timer = setTimeout(() => {
        onOpenChange(false);
        onCreated(result.dashboard_id);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [step, result, onOpenChange, onCreated]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 1 && (
              <>
                <FileCode2 className="h-5 w-5" /> 创建看板
              </>
            )}
            {step === 2 && "AI 正在生成..."}
            {step === 3 && (
              <>
                <CheckCircle2 className="h-5 w-5 text-green-500" /> 创建成功
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4">
          {step === 1 && (
            <>
              {/* HTML 上传 */}
              <div className="space-y-2">
                <Label>上传 HTML 设计稿（必须）</Label>
                {htmlContent ? (
                  <div className="flex items-center gap-2 rounded-lg border p-3 bg-slate-50">
                    <FileCode2 className="h-5 w-5 text-blue-500" />
                    <span className="text-sm flex-1 truncate">{htmlFileName}</span>
                    <button
                      onClick={() => {
                        setHtmlContent("");
                        setHtmlFileName("");
                      }}
                      className="text-slate-400 hover:text-red-500"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div
                    {...getHtmlRootProps()}
                    className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors cursor-pointer min-h-[120px] ${
                      isHtmlDragActive
                        ? "border-blue-400 bg-blue-50"
                        : "border-gray-300 bg-white hover:bg-gray-50"
                    }`}
                  >
                    <input {...getHtmlInputProps()} />
                    <div className="flex flex-col items-center gap-2 p-4">
                      <UploadCloud className="h-8 w-8 text-slate-400" />
                      <p className="text-sm font-medium text-slate-700">
                        {isHtmlDragActive
                          ? "松开即可上传"
                          : "拖拽或点击上传 HTML 设计稿"}
                      </p>
                      <p className="text-xs text-slate-500">支持 .html / .htm</p>
                    </div>
                  </div>
                )}
              </div>

              {/* 数据源 */}
              <div className="space-y-2">
                <Label>选择数据源（至少一个）</Label>
                <Tabs defaultValue="new">
                  <TabsList>
                    <TabsTrigger value="new">新文件</TabsTrigger>
                    <TabsTrigger value="existing">已有表</TabsTrigger>
                  </TabsList>

                  <TabsContent value="new" className="space-y-3">
                    <div
                      {...getDataRootProps()}
                      className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors cursor-pointer min-h-[100px] ${
                        isDataDragActive
                          ? "border-blue-400 bg-blue-50"
                          : "border-gray-300 bg-white hover:bg-gray-50"
                      }`}
                    >
                      <input {...getDataInputProps()} />
                      <div className="flex flex-col items-center gap-2 p-4">
                        <UploadCloud className="h-6 w-6 text-slate-400" />
                        <p className="text-sm text-slate-600">
                          拖拽或点击上传 Excel / CSV
                        </p>
                      </div>
                    </div>

                    {newFiles.map((f) => (
                      <div
                        key={f.path}
                        className="border rounded-lg p-3 space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <FileSpreadsheet className="h-4 w-4 text-green-600" />
                          <span className="text-sm flex-1 truncate">
                            {f.file.name}
                          </span>
                          <button
                            onClick={() => removeNewFile(f.path)}
                            className="text-slate-400 hover:text-red-500"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-slate-500">目标表名</Label>
                          <Input
                            value={f.targetTable}
                            onChange={(e) =>
                              updateTargetTable(f.path, e.target.value)
                            }
                            className="h-7 text-sm"
                          />
                        </div>
                        {f.loading && (
                          <div className="flex items-center gap-2 text-xs text-slate-400">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            正在解析...
                          </div>
                        )}
                        {f.preview && f.preview.sheets.length > 0 && (
                          <ScrollArea className="max-h-[200px] border rounded">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  {f.preview.sheets[0].columns.map((c, i) => (
                                    <TableHead key={i} className="text-xs">
                                      {c}
                                    </TableHead>
                                  ))}
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {f.preview.sheets[0].preview_data.map(
                                  (row, ri) => (
                                    <TableRow key={ri}>
                                      {row.map((cell, ci) => (
                                        <TableCell
                                          key={ci}
                                          className="text-xs"
                                        >
                                          {cell}
                                        </TableCell>
                                      ))}
                                    </TableRow>
                                  )
                                )}
                              </TableBody>
                            </Table>
                          </ScrollArea>
                        )}
                      </div>
                    ))}
                  </TabsContent>

                  <TabsContent value="existing">
                    {existingTables.length === 0 ? (
                      <p className="text-sm text-slate-500">暂无已有数据表</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {existingTables.map((t) => (
                          <label
                            key={t}
                            className="flex items-center gap-2 rounded-lg border p-2 cursor-pointer hover:bg-slate-50"
                          >
                            <input
                              type="checkbox"
                              checked={selectedTables.has(t)}
                              onChange={() => toggleExistingTable(t)}
                              className="h-4 w-4"
                            />
                            <span className="text-sm">{t}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </div>

              {/* 看板名称 */}
              <div className="space-y-2">
                <Label>看板名称（可选）</Label>
                <Input
                  value={dashboardName}
                  onChange={(e) => setDashboardName(e.target.value)}
                  placeholder="未命名看板"
                />
              </div>
            </>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <CreateDashboardTracker isActive={trackerActive} />
              {createError && (
                <div className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2 text-red-600">
                    <AlertTriangle className="h-4 w-4" />
                    <span className="font-medium">创建失败</span>
                  </div>
                  <pre className="text-xs bg-red-50 border border-red-200 rounded p-2 text-red-700 whitespace-pre-wrap">
                    {createError}
                  </pre>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRollback}
                    >
                      回滚已建表
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setCreateError(null);
                        setStep(1);
                      }}
                    >
                      返回修改
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && result && (
            <div className="text-center space-y-4 py-8">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
              <h3 className="text-lg font-semibold">
                看板「{result.dashboard_name}」创建成功
              </h3>
              <p className="text-sm text-slate-500">
                已新建 {result.created_tables.length} 张数据表
                {result.warnings.length > 0 &&
                  `，${result.warnings.length} 条警告`}
              </p>
              <p className="text-xs text-slate-400">2 秒后自动跳转...</p>
            </div>
          )}
        </div>

        {step === 1 && (
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              取消
            </Button>
            <Button onClick={handleCreate} disabled={!canProceed || creating}>
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> 创建中...
                </>
              ) : (
                "开始创建"
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
