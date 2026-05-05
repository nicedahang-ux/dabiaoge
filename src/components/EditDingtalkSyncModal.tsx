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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Dashboard } from "@/lib/AppContext";

interface DingtalkFieldInfo {
  name: string;
  field_type: string;
}
interface DingtalkSheetInfo {
  id: string;
  name: string;
  fields: DingtalkFieldInfo[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboard: Dashboard | null;
  onSaved?: () => void;
}

export default function EditDingtalkSyncModal({
  open,
  onOpenChange,
  dashboard,
  onSaved,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sheets, setSheets] = useState<DingtalkSheetInfo[]>([]);
  const [selectedSheetId, setSelectedSheetId] = useState<string>("");
  const [selectedFieldsBySheet, setSelectedFieldsBySheet] = useState<
    Record<string, Set<string>>
  >({});

  useEffect(() => {
    if (!open || !dashboard) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const baseId = dashboard.dingtalk_doc_id || dashboard.dingtalk_doc_url || "";
        const operatorId = dashboard.dingtalk_operator_id || "";
        if (!baseId || !operatorId) {
          toast.error("看板缺少多维表ID或操作人,无法加载");
          return;
        }
        const result = await invoke<DingtalkSheetInfo[]>("list_dingtalk_sheets", {
          baseIdOrUrl: baseId,
          operatorId,
        });
        if (cancelled) return;
        setSheets(result);

        // 解析已保存的字段集
        let savedFields: string[] = [];
        if (dashboard.dingtalk_selected_fields) {
          try {
            const parsed = JSON.parse(dashboard.dingtalk_selected_fields);
            if (Array.isArray(parsed)) savedFields = parsed.map(String);
          } catch {}
        }
        const savedSheetId = dashboard.dingtalk_sheet_id || result[0]?.id || "";

        // 默认每个子表都全选；当前激活的子表用已保存集合(若有)
        const init: Record<string, Set<string>> = {};
        for (const s of result) {
          init[s.id] = new Set(s.fields.map((f) => f.name));
        }
        if (savedSheetId && savedFields.length > 0) {
          // 仅保留仍然存在的字段(避免远端字段被删后仍勾选)
          const currentFieldNames = new Set(
            result.find((s) => s.id === savedSheetId)?.fields.map((f) => f.name) ?? []
          );
          init[savedSheetId] = new Set(
            savedFields.filter((f) => currentFieldNames.has(f))
          );
        }
        setSelectedSheetId(savedSheetId);
        setSelectedFieldsBySheet(init);
      } catch (e) {
        toast.error("加载子表失败: " + String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, dashboard]);

  const toggleField = (sheetId: string, fieldName: string) => {
    setSelectedFieldsBySheet((prev) => {
      const next = { ...prev };
      const set = new Set(next[sheetId] ?? []);
      if (set.has(fieldName)) set.delete(fieldName);
      else set.add(fieldName);
      next[sheetId] = set;
      return next;
    });
  };

  const setAllFields = (sheetId: string, allOn: boolean) => {
    const sheet = sheets.find((s) => s.id === sheetId);
    if (!sheet) return;
    setSelectedFieldsBySheet((prev) => ({
      ...prev,
      [sheetId]: allOn ? new Set(sheet.fields.map((f) => f.name)) : new Set(),
    }));
  };

  const handleSave = async () => {
    if (!dashboard || !selectedSheetId) return;
    const sheet = sheets.find((s) => s.id === selectedSheetId);
    const fields = Array.from(selectedFieldsBySheet[selectedSheetId] ?? []);
    if (fields.length === 0) {
      toast.error("至少要勾选一个字段");
      return;
    }
    setSaving(true);
    try {
      await invoke("update_dingtalk_sync_config", {
        dashboardId: dashboard.id,
        sheetId: selectedSheetId,
        sheetName: sheet?.name,
        selectedFields: fields,
      });
      toast.success("同步配置已保存,下次同步将按此配置执行");
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      toast.error("保存失败: " + String(e));
    } finally {
      setSaving(false);
    }
  };

  const currentSheet = sheets.find((s) => s.id === selectedSheetId);
  const currentSet = selectedFieldsBySheet[selectedSheetId] ?? new Set<string>();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>修改钉钉同步字段</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : sheets.length === 0 ? (
            <p className="text-sm text-slate-500 py-4">无法加载子表</p>
          ) : (
            <>
              <div className="space-y-2">
                <Label>选择子表</Label>
                <div className="flex flex-wrap gap-1">
                  {sheets.map((s) => {
                    const total = s.fields.length;
                    const picked = selectedFieldsBySheet[s.id]?.size ?? 0;
                    const active = selectedSheetId === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSheetId(s.id)}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                          active
                            ? "bg-blue-500 text-white"
                            : "bg-white text-slate-700 hover:bg-slate-100 border border-slate-200"
                        }`}
                      >
                        {s.name}
                        <span
                          className={`ml-1 text-[10px] ${
                            active ? "text-blue-100" : "text-slate-400"
                          }`}
                        >
                          {picked}/{total}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400">
                  提示:切换子表会改变看板关联的数据源。若切换到不同子表,下次同步会用新表头重建本地数据
                </p>
              </div>

              {currentSheet && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>勾选要同步的字段</Label>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setAllFields(selectedSheetId, true)}
                        className="text-xs text-blue-600 hover:underline disabled:text-slate-300"
                        disabled={currentSet.size === currentSheet.fields.length}
                      >
                        全选
                      </button>
                      <span className="text-slate-300">|</span>
                      <button
                        type="button"
                        onClick={() => setAllFields(selectedSheetId, false)}
                        className="text-xs text-blue-600 hover:underline disabled:text-slate-300"
                        disabled={currentSet.size === 0}
                      >
                        全不选
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    共 {currentSheet.fields.length} 个字段,已选 {currentSet.size} 个
                  </p>
                  <ScrollArea className="max-h-[320px] rounded-lg border bg-slate-50 p-2">
                    <div className="grid grid-cols-2 gap-1">
                      {currentSheet.fields.map((f) => {
                        const checked = currentSet.has(f.name);
                        return (
                          <label
                            key={f.name}
                            className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-white cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleField(selectedSheetId, f.name)}
                              className="h-3.5 w-3.5"
                            />
                            <span className="flex-1 truncate">{f.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button onClick={handleSave} disabled={loading || saving || !selectedSheetId}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> 保存中...
              </>
            ) : (
              "保存"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
