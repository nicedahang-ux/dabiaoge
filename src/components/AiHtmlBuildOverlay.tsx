import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Database,
  Sparkles,
  Table2,
  Save,
  Wand2,
} from "lucide-react";

export interface AiHtmlBuildProgress {
  stage: string;
  message: string;
  detail: unknown;
}

const stageOrder = [
  "read_data",
  "ai_design_tables",
  "create_tables",
  "finalize",
  "done",
];

const stageMeta: Record<string, { label: string; icon: React.ReactNode }> = {
  read_data: { label: "读取上传文件", icon: <Database className="h-4 w-4" /> },
  ai_design_tables: {
    label: "AI 设计表结构",
    icon: <Sparkles className="h-4 w-4" />,
  },
  create_tables: { label: "创建数据表", icon: <Table2 className="h-4 w-4" /> },
  finalize: { label: "保存看板", icon: <Save className="h-4 w-4" /> },
  done: { label: "完成", icon: <CheckCircle2 className="h-4 w-4" /> },
};

interface AiHtmlBuildOverlayProps {
  isActive: boolean;
  mode: "create" | "modify";
}

export default function AiHtmlBuildOverlay({
  isActive,
  mode,
}: AiHtmlBuildOverlayProps) {
  const [steps, setSteps] = useState<AiHtmlBuildProgress[]>([]);

  useEffect(() => {
    if (!isActive) {
      setSteps([]);
      return;
    }
    const unlisten = listen<AiHtmlBuildProgress>(
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

  if (!isActive) return null;

  const last = steps[steps.length - 1];
  const isError = last?.stage === "error";
  const isDone = last?.stage === "done";

  const headerLabel =
    mode === "modify"
      ? isDone
        ? "看板已更新"
        : isError
        ? "更新看板失败"
        : "正在为你更新看板..."
      : isDone
      ? "看板已生成"
      : isError
      ? "创建看板失败"
      : "正在为你创建看板...";

  return (
    <div className="px-4 pb-2 max-w-4xl mx-auto w-full">
      <div className="border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex items-center gap-3">
          {isError ? (
            <XCircle className="h-6 w-6 text-red-500" />
          ) : isDone ? (
            <CheckCircle2 className="h-6 w-6 text-green-500" />
          ) : (
            <div className="relative">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
              <Wand2 className="h-3 w-3 absolute -right-0.5 -bottom-0.5 text-indigo-500" />
            </div>
          )}
          <div className="flex-1">
            <div className="font-semibold text-slate-800">{headerLabel}</div>
            {!isDone && !isError && (
              <div className="text-xs text-slate-500 mt-0.5">
                AI 已生成完整 HTML，正在
                {mode === "modify" ? "替换看板源码" : "导入数据并保存看板"}，请稍候…
              </div>
            )}
          </div>
        </div>

        {steps.length > 0 && (
          <ol className="space-y-2">
            {stageOrder.map((stage) => {
              const step = steps.find((s) => s.stage === stage);
              if (!step) return null;
              const meta = stageMeta[stage] || {
                label: step.message,
                icon: null,
              };
              const isCurrent =
                last?.stage === stage && !isDone && !isError;
              return (
                <li
                  key={stage}
                  className={`flex items-center gap-2 text-sm ${
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
                  <span className="text-xs text-slate-400 truncate">
                    {step.message}
                  </span>
                </li>
              );
            })}
            {isError && last && (
              <li className="flex items-start gap-2 text-red-600">
                <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span className="text-xs">{last.message}</span>
              </li>
            )}
          </ol>
        )}
      </div>
    </div>
  );
}
