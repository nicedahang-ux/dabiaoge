import { useState } from "react";
import { AlertTriangle, RotateCcw, Download, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PendingDashboard } from "@/lib/AppContext";

interface PendingDashboardCardProps {
  pending: PendingDashboard;
  onRetry: (pending: PendingDashboard) => void;
  onExport: (pending: PendingDashboard) => void;
  onDelete: (pending: PendingDashboard) => void;
}

export default function PendingDashboardCard({
  pending,
  onRetry,
  onExport,
  onDelete,
}: PendingDashboardCardProps) {
  const [showFullError, setShowFullError] = useState(false);
  const errorText = pending.last_error || "";
  const hasLongError = errorText.length > 120;

  return (
    <Card className="border-amber-300 bg-amber-50/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          {pending.name}
          <span className="ml-auto text-[10px] font-normal text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
            {pending.source === "template" ? "模板" : "AI 生成"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {errorText && (
          <div className="text-xs text-amber-900 bg-amber-100/60 border border-amber-200 rounded p-2">
            <div className={showFullError ? "whitespace-pre-wrap break-all" : "line-clamp-2 break-all"}>
              {errorText}
            </div>
            {hasLongError && (
              <button
                className="mt-1 text-[10px] text-amber-700 inline-flex items-center gap-0.5 hover:underline"
                onClick={() => setShowFullError((v) => !v)}
              >
                {showFullError ? (
                  <>
                    收起 <ChevronUp className="h-3 w-3" />
                  </>
                ) : (
                  <>
                    展开 <ChevronDown className="h-3 w-3" />
                  </>
                )}
              </button>
            )}
          </div>
        )}

        <div className="text-[10px] text-slate-500">
          失败时间 {new Date(pending.updated_at).toLocaleString()}
          {pending.new_files.length > 0 && (
            <> · 涉及 {pending.new_files.length} 个新建表</>
          )}
          {pending.existing_tables.length > 0 && (
            <> · 引用 {pending.existing_tables.length} 张已有表</>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="default"
            size="sm"
            className="h-7 gap-1 text-xs flex-1"
            onClick={() => onRetry(pending)}
          >
            <RotateCcw className="h-3 w-3" />
            重试
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => onExport(pending)}
          >
            <Download className="h-3 w-3" />
            导出 HTML
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-red-500 hover:text-red-600 hover:bg-red-50"
            onClick={() => onDelete(pending)}
          >
            <Trash2 className="h-3 w-3" />
            删除
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
