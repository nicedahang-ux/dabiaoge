import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  FileCode2,
  Database,
  Sparkles,
  Table2,
  Save,
} from "lucide-react";

export interface CreateProgressPayload {
  stage: string;
  message: string;
  detail: unknown;
}

const stageOrder = [
  "parse_html",
  "read_data",
  "ai_design_tables",
  "create_tables",
  "ai_design_dashboard",
  "finalize",
  "done",
];

const stageMeta: Record<
  string,
  { label: string; icon: React.ReactNode }
> = {
  parse_html: { label: "解析 HTML", icon: <FileCode2 className="h-4 w-4" /> },
  read_data: { label: "读取数据", icon: <Database className="h-4 w-4" /> },
  ai_design_tables: {
    label: "AI 设计表结构",
    icon: <Sparkles className="h-4 w-4" />,
  },
  create_tables: {
    label: "创建数据表",
    icon: <Table2 className="h-4 w-4" />,
  },
  ai_design_dashboard: {
    label: "AI 设计看板",
    icon: <Sparkles className="h-4 w-4" />,
  },
  finalize: { label: "保存看板", icon: <Save className="h-4 w-4" /> },
  done: { label: "完成", icon: <CheckCircle2 className="h-4 w-4" /> },
};

interface CreateDashboardTrackerProps {
  isActive: boolean;
}

export default function CreateDashboardTracker({
  isActive,
}: CreateDashboardTrackerProps) {
  const [steps, setSteps] = useState<CreateProgressPayload[]>([]);

  useEffect(() => {
    if (!isActive) {
      setSteps([]);
      return;
    }
    const unlisten = listen<CreateProgressPayload>(
      "create-dashboard-progress",
      (event) => {
        setSteps((prev) => {
          const next = [...prev];
          const idx = next.findIndex((s) => s.stage === event.payload.stage);
          if (idx >= 0) {
            next[idx] = event.payload;
          } else {
            next.push(event.payload);
          }
          return next;
        });
      }
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [isActive]);

  if (!isActive || steps.length === 0) return null;

  const last = steps[steps.length - 1];
  const isError = last.stage === "error";
  const isDone = last.stage === "done";

  return (
    <div className="border rounded-lg bg-slate-50 p-4 space-y-3 text-sm">
      <div className="flex items-center gap-2">
        {isError ? (
          <XCircle className="h-4 w-4 text-red-500" />
        ) : isDone ? (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        )}
        <span className="font-medium">
          {isError
            ? "创建失败"
            : isDone
            ? "创建完成"
            : "AI 正在生成看板..."}
        </span>
      </div>

      <ol className="space-y-2">
        {stageOrder.map((stage) => {
          const step = steps.find((s) => s.stage === stage);
          if (!step) return null;
          const meta = stageMeta[stage] || {
            label: step.message,
            icon: null,
          };
          const isCurrent = last.stage === stage && !isDone && !isError;
          return (
            <li
              key={stage}
              className={`flex items-center gap-2 ${
                isCurrent ? "text-blue-700" : "text-slate-600"
              }`}
            >
              {isCurrent ? (
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              )}
              <div className="flex items-center gap-1.5">
                {meta.icon}
                <span className="font-medium">{meta.label}</span>
              </div>
              <span className="text-xs text-slate-400">{step.message}</span>
            </li>
          );
        })}
        {isError && (
          <li className="flex items-start gap-2 text-red-600">
            <XCircle className="h-4 w-4 mt-0.5" />
            <span className="text-xs">{last.message}</span>
          </li>
        )}
      </ol>
    </div>
  );
}
