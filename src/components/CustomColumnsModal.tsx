import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Trash2, Calculator } from "lucide-react";
import { toast } from "sonner";

interface CustomColumn {
  id: string;
  table_name: string;
  column_name: string;
  sql_expression: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableName: string;
  onApplied?: () => void;
}

export default function CustomColumnsModal({
  open,
  onOpenChange,
  tableName,
  onApplied,
}: Props) {
  const [columns, setColumns] = useState<CustomColumn[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [newColumnName, setNewColumnName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [previewExpression, setPreviewExpression] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!open || !tableName) return;
    loadColumns();
  }, [open, tableName]);

  const loadColumns = async () => {
    setLoading(true);
    try {
      const res = await invoke<CustomColumn[]>("list_custom_columns", {
        tableName,
      });
      setColumns(res);
    } catch (e) {
      toast.error("加载公式列失败: " + String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!newColumnName.trim() || !newPrompt.trim()) {
      toast.error("请填写列名和自然语言描述");
      return;
    }
    setGenerating(true);
    try {
      const result = await invoke<CustomColumn>("add_custom_column", {
        tableName,
        columnName: newColumnName.trim(),
        description: newDescription.trim(),
        prompt: newPrompt.trim(),
      });
      setPreviewExpression(result.sql_expression);
      setColumns((prev) => [...prev, result]);
      setNewColumnName("");
      setNewDescription("");
      setNewPrompt("");
      toast.success(`公式列「${result.column_name}」已添加`);
      onApplied?.();
    } catch (e) {
      toast.error("添加失败: " + String(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (columnName: string) => {
    setDeleting(columnName);
    try {
      await invoke("delete_custom_column", { tableName, columnName });
      setColumns((prev) => prev.filter((c) => c.column_name !== columnName));
      toast.success(`列「${columnName}」已删除`);
      onApplied?.();
    } catch (e) {
      toast.error("删除失败: " + String(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5" />
            管理公式列 — {tableName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4">
          {/* 已有列列表 */}
          <div className="space-y-2">
            <Label>已有公式列</Label>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            ) : columns.length === 0 ? (
              <p className="text-sm text-slate-400 py-2">暂无公式列</p>
            ) : (
              <ScrollArea className="h-[160px] rounded-lg border bg-slate-50">
                <div className="p-2 space-y-2">
                  {columns.map((col) => (
                    <div
                      key={col.id}
                      className="flex items-center justify-between rounded-md bg-white border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{col.column_name}</div>
                        {col.description && (
                          <div className="text-xs text-slate-500">{col.description}</div>
                        )}
                        <div className="text-[11px] text-slate-400 font-mono truncate">
                          {col.sql_expression}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-red-500 hover:text-red-600 hover:bg-red-50 shrink-0"
                        onClick={() => handleDelete(col.column_name)}
                        disabled={deleting === col.column_name}
                      >
                        {deleting === col.column_name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>

          {/* 添加新列 */}
          <div className="space-y-3 border-t pt-4">
            <Label>添加新公式列</Label>

            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="text-xs text-slate-500">列名</Label>
                  <Input
                    placeholder="例如：进度"
                    value={newColumnName}
                    onChange={(e) => setNewColumnName(e.target.value)}
                  />
                </div>
                <div className="flex-1">
                  <Label className="text-xs text-slate-500">描述（可选）</Label>
                  <Input
                    placeholder="例如：计算销售进度"
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs text-slate-500">自然语言描述（AI 生成 SQL）</Label>
                <textarea
                  placeholder="例如：当前销量除以销量目标，乘以100%，保留两位小数"
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                />
              </div>

              <Button
                onClick={handleGenerate}
                disabled={generating || !newColumnName.trim() || !newPrompt.trim()}
                className="w-full"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    AI 生成并添加中...
                  </>
                ) : (
                  "AI 生成并添加公式列"
                )}
              </Button>
            </div>

            {previewExpression && (
              <div className="rounded-md bg-blue-50 border border-blue-200 p-3 space-y-1">
                <div className="text-xs text-blue-600 font-medium">生成的 SQL 表达式</div>
                <code className="text-xs text-blue-800 font-mono block whitespace-pre-wrap">
                  {previewExpression}
                </code>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
