import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { X, FolderOpen, Database } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { PendingDashboard, NewFileSpec } from "@/lib/AppContext";

interface DbTableInfo {
  table_name: string;
  remark: string;
  dashboards: string[];
  column_count: number;
  row_count: number;
}

interface Props {
  open: boolean;
  pending: PendingDashboard | null;
  onClose: () => void;
  onConfirm: (newFiles: NewFileSpec[], existingTables: string[]) => void;
}

export default function RetryPendingModal({ open, pending, onClose, onConfirm }: Props) {
  const [newFiles, setNewFiles] = useState<NewFileSpec[]>([]);
  const [existingTables, setExistingTables] = useState<string[]>([]);
  const [allTables, setAllTables] = useState<DbTableInfo[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);

  useEffect(() => {
    if (!open || !pending) return;
    setNewFiles(pending.new_files.map((f) => ({ ...f })));
    setExistingTables([...pending.existing_tables]);
    setLoadingTables(true);
    invoke<DbTableInfo[]>("list_db_tables_for_chat")
      .then((data) => setAllTables(data))
      .catch((e) => toast.error("加载数据库表失败: " + String(e)))
      .finally(() => setLoadingTables(false));
  }, [open, pending]);

  const pickFile = async (idx: number) => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Excel/CSV", extensions: ["xlsx", "xls", "csv"] }],
      });
      if (typeof selected === "string" && selected) {
        setNewFiles((prev) => {
          const next = [...prev];
          next[idx] = { ...next[idx], file_path: selected };
          return next;
        });
      }
    } catch (e) {
      toast.error("选择文件失败: " + String(e));
    }
  };

  const toggleTable = (name: string) => {
    setExistingTables((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]
    );
  };

  if (!open || !pending) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-sm">重试看板创建 · {pending.name}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
          {newFiles.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-700">
                新建表（可重新选择源文件）
              </div>
              {newFiles.map((nf, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 border rounded p-2 bg-slate-50"
                >
                  <div className="text-xs font-mono px-2 py-0.5 bg-blue-100 text-blue-700 rounded shrink-0">
                    {nf.target_table_name}
                  </div>
                  <input
                    className="flex-1 text-xs px-2 py-1 border rounded font-mono"
                    value={nf.file_path}
                    onChange={(e) =>
                      setNewFiles((prev) => {
                        const next = [...prev];
                        next[idx] = { ...next[idx], file_path: e.target.value };
                        return next;
                      })
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs shrink-0"
                    onClick={() => pickFile(idx)}
                  >
                    <FolderOpen className="h-3 w-3" />
                    重新选择
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-700 flex items-center gap-1">
              <Database className="h-3.5 w-3.5" />
              引用已有数据表（多选）
              {loadingTables && <span className="text-slate-400">加载中…</span>}
            </div>
            <div className="border rounded max-h-60 overflow-auto">
              {allTables.length === 0 && !loadingTables && (
                <div className="text-xs text-slate-400 px-3 py-4 text-center">
                  暂无可用数据表
                </div>
              )}
              {allTables.map((t) => (
                <label
                  key={t.table_name}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-slate-50 cursor-pointer border-b last:border-b-0"
                >
                  <input
                    type="checkbox"
                    checked={existingTables.includes(t.table_name)}
                    onChange={() => toggleTable(t.table_name)}
                  />
                  <span className="font-mono">{t.table_name}</span>
                  {t.remark && (
                    <span className="text-slate-500 truncate">— {t.remark}</span>
                  )}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (newFiles.some((f) => !f.file_path.trim())) {
                toast.error("有新建表的源文件路径为空");
                return;
              }
              onConfirm(newFiles, existingTables);
            }}
          >
            开始重试
          </Button>
        </div>
      </div>
    </div>
  );
}
