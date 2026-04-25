import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Wrench,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";

export interface RepairStep {
  step_number: number;
  status: "running" | "success" | "failed";
  title: string;
  message: string;
  error?: string | null;
  reason?: string | null;
  fix?: string | null;
  sql_preview?: string | null;
  elapsed_seconds: number;
}

interface SqlRepairTrackerProps {
  isActive: boolean;
  onReset?: () => void;
}

export default function SqlRepairTracker({
  isActive,
  onReset,
}: SqlRepairTrackerProps) {
  const [steps, setSteps] = useState<RepairStep[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!isActive) {
      setSteps([]);
      return;
    }
    const unlisten = listen<RepairStep>("dashboard-sql-repair-step", (event) => {
      setSteps((prev) => {
        const next = [...prev];
        const idx = next.findIndex(
          (s) =>
            s.step_number === event.payload.step_number &&
            s.title === event.payload.title
        );
        if (idx >= 0) {
          next[idx] = event.payload;
        } else {
          next.push(event.payload);
        }
        return next;
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [isActive]);

  if (!isActive || steps.length === 0) return null;

  const lastStep = steps[steps.length - 1];
  const allDone =
    lastStep.status === "success" && lastStep.title === "修正成功";
  const allFailed =
    lastStep.status === "failed" && lastStep.title === "无法自动修正";

  const renderIcon = (status: RepairStep["status"]) => {
    if (status === "running")
      return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
    if (status === "success")
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    return <XCircle className="h-4 w-4 text-red-500" />;
  };

  return (
    <div className="border rounded-lg bg-amber-50 border-amber-200 p-3 mb-3 text-sm">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 mb-2"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-amber-700" />
        ) : (
          <ChevronDown className="h-4 w-4 text-amber-700" />
        )}
        <Wrench className="h-4 w-4 text-amber-700" />
        <span className="font-medium text-amber-900">
          {allDone
            ? "看板 SQL 已被 AI 自动修正"
            : allFailed
            ? "AI 自动纠错失败"
            : "AI 正在自动修正看板 SQL"}
        </span>
        <span className="ml-auto text-xs text-amber-700">
          {steps.length} 步 · {lastStep.elapsed_seconds}s
        </span>
        {(allDone || allFailed) && onReset && (
          <span
            className="ml-2 text-xs underline text-amber-700"
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
          >
            关闭
          </span>
        )}
      </button>

      {!collapsed && (
        <ol className="space-y-2 pl-1">
          {steps.map((s, i) => (
            <li
              key={`${s.step_number}-${i}`}
              className="flex gap-2 items-start"
            >
              <div className="mt-0.5">{renderIcon(s.status)}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{s.title}</span>
                  <span className="text-[10px] text-slate-400">
                    {s.elapsed_seconds}s
                  </span>
                </div>
                <div className="text-slate-600 text-xs">{s.message}</div>
                {s.reason && (
                  <div className="mt-1 text-xs bg-white border border-amber-200 rounded p-2">
                    <div className="text-slate-500">
                      <strong>原因:</strong> {s.reason}
                    </div>
                    {s.fix && (
                      <div className="text-slate-500 mt-1">
                        <strong>修正:</strong> {s.fix}
                      </div>
                    )}
                  </div>
                )}
                {s.error && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-red-600 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      错误详情
                    </summary>
                    <pre className="mt-1 p-2 bg-red-50 border border-red-200 rounded text-red-700 whitespace-pre-wrap break-all">
                      {s.error}
                    </pre>
                  </details>
                )}
                {s.sql_preview && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-slate-500">
                      SQL 预览
                    </summary>
                    <pre className="mt-1 p-2 bg-slate-100 rounded text-slate-700 whitespace-pre-wrap break-all">
                      {s.sql_preview}
                    </pre>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
