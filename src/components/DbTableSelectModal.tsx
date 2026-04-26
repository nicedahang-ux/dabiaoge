import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Database, Check } from "lucide-react";
import { toast } from "sonner";

interface DbTableInfo {
  table_name: string;
  remark: string;
  dashboards: string[];
  column_count: number;
  row_count: number;
}

export interface DbTablePreview {
  table_name: string;
  remark: string;
  columns: string[];
  preview_data: string[][];
  column_remarks: Record<string, string>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (previews: DbTablePreview[]) => void;
}

export default function DbTableSelectModal({ open, onClose, onConfirm }: Props) {
  const [tables, setTables] = useState<DbTableInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [editingTable, setEditingTable] = useState<string | null>(null);
  const [remarkInput, setRemarkInput] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    invoke<DbTableInfo[]>("list_db_tables_for_chat")
      .then((data) => {
        setTables(data);
        setSelected(new Set());
      })
      .catch((e) => toast.error("加载数据库表失败: " + String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (selected.size === 0) {
      onClose();
      return;
    }
    setLoading(true);
    try {
      const previews: DbTablePreview[] = [];
      for (const tableName of selected) {
        const [res, columnRemarks] = await Promise.all([
          invoke<{ columns: string[]; rows: string[][] }>("query_table_data", {
            tableName,
            limit: 20,
          }),
          invoke<Record<string, string>>("get_column_remarks", { tableName }).catch(() => ({})),
        ]);
        const info = tables.find((t) => t.table_name === tableName);
        previews.push({
          table_name: tableName,
          remark: info?.remark || "",
          columns: res.columns,
          preview_data: res.rows,
          column_remarks: columnRemarks || {},
        });
      }
      onConfirm(previews);
      onClose();
    } catch (e) {
      toast.error("查询数据库表失败: " + String(e));
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Database className="h-4 w-4 text-blue-600" />
            选择数据库表
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading && tables.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-8">加载中...</div>
          ) : tables.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-8">暂无用户数据表</div>
          ) : (
            tables.map((t) => (
              <label
                key={t.table_name}
                className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                  selected.has(t.table_name)
                    ? "border-blue-300 bg-blue-50"
                    : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <div className="mt-0.5">
                  {selected.has(t.table_name) ? (
                    <Check className="h-4 w-4 text-blue-600" />
                  ) : (
                    <div className="h-4 w-4 rounded border border-slate-300" />
                  )}
                </div>
                <div className="flex-1 min-w-0" onClick={() => toggle(t.table_name)}>
                  <div className="text-sm font-medium truncate">{t.table_name}</div>
                  {editingTable === t.table_name ? (
                    <div className="flex gap-1 mt-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        value={remarkInput}
                        onChange={(e) => setRemarkInput(e.target.value)}
                        className="text-xs border rounded px-1 py-0.5 flex-1"
                        placeholder="输入中文备注"
                      />
                      <button
                        onClick={async () => {
                          try {
                            await invoke("set_table_remark", { tableName: t.table_name, remark: remarkInput });
                            setTables((prev) => prev.map((x) => (x.table_name === t.table_name ? { ...x, remark: remarkInput } : x)));
                            setEditingTable(null);
                          } catch (e) {
                            toast.error("保存备注失败: " + String(e));
                          }
                        }}
                        className="text-xs text-blue-600 px-1"
                      >
                        保存
                      </button>
                    </div>
                  ) : (
                    <>
                      {t.remark && <div className="text-xs text-slate-500 mt-0.5">{t.remark}</div>}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingTable(t.table_name);
                          setRemarkInput(t.remark);
                        }}
                        className="text-xs text-blue-500 mt-0.5"
                      >
                        {t.remark ? "修改备注" : "添加备注"}
                      </button>
                    </>
                  )}
                  <div className="text-xs text-slate-400 mt-1 flex gap-2">
                    <span>{t.column_count} 列</span>
                    <span>{t.row_count} 行</span>
                    {t.dashboards.length > 0 && (
                      <span className="text-blue-500">关联: {t.dashboards.join(", ")}</span>
                    )}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md border hover:bg-slate-50"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading || selected.size === 0}
            className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "查询中..." : `确认选择 (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
