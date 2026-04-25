import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, CheckCircle, Clock } from "lucide-react";
import { Progress } from "@/components/ui/progress";

interface ModifyProgressPayload {
  step: number;
  total: number;
  plan: string;
  elapsed_seconds: number;
}

interface ExecutionTrackerProps {
  isActive: boolean;
}

export default function ExecutionTracker({ isActive }: ExecutionTrackerProps) {
  const [progress, setProgress] = useState<ModifyProgressPayload | null>(null);
  const [history, setHistory] = useState<ModifyProgressPayload[]>([]);

  useEffect(() => {
    if (!isActive) {
      setProgress(null);
      setHistory([]);
      return;
    }

    const unlisten = listen<ModifyProgressPayload>("modify-progress", (event) => {
      setProgress(event.payload);
      setHistory((prev) => [...prev, event.payload]);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [isActive]);

  if (!isActive || !progress) return null;

  const percent = Math.min((progress.step / progress.total) * 100, 100);
  const minutes = Math.floor(progress.elapsed_seconds / 60);
  const seconds = progress.elapsed_seconds % 60;

  return (
    <div className="border rounded-lg bg-slate-50 p-4 space-y-3"
    >
      <div className="flex items-center justify-between"
      >
        <div className="flex items-center gap-2"
        >
          <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
          <span className="text-sm font-medium"
          >AI 正在执行修改</span
          >
        </div
        >
        <div className="flex items-center gap-1 text-xs text-slate-500"
        >
          <Clock className="h-3 w-3" />
          已用时 {minutes}分{seconds}秒
        </div
        >
      </div
      >

      <Progress value={percent} className="h-2" />

      <div className="text-xs text-slate-600"
      >
        步骤 {progress.step} / {progress.total}: {progress.plan}
      </div
      >

      {history.length > 1 && (
        <div className="space-y-1"
        >
          <p className="text-[10px] text-slate-400 font-medium"
          >执行历史</p
          >
          {history.slice(0, -1).map((h, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-slate-500"
            >
              <CheckCircle className="h-3 w-3 text-green-500" />
              步骤 {h.step}: {h.plan.slice(0, 50)}
              {h.plan.length > 50 ? "..." : ""}
            </div
            >
          ))}
        </div
        >
      )}
    </div
    >
  );
}
