import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle, Database, FileSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { invalidateBySourceTable } from "@/lib/dashboardHtmlCache";

interface ProgressPayload {
  percent: number;
  step: string;
  error_rows: number;
}

interface IngestModalProps {
  filePath: string;
  cleanSql: string;
  tableName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const steps = [
  { id: 1, label: "大文件切割清洗", icon: FileSearch },
  { id: 2, label: "生成知识库摘要", icon: Database },
  { id: 3, label: "向量化入库", icon: CheckCircle },
];

export default function IngestModal({
  filePath,
  cleanSql,
  tableName,
  open,
  onOpenChange,
}: IngestModalProps) {
  const [percent, setPercent] = useState(0);
  const [stepText, setStepText] = useState("准备中...");
  const [errorRows, setErrorRows] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPercent(0);
    setStepText("准备中...");
    setErrorRows(0);
    setDone(false);

    const unlisten = listen<ProgressPayload>("ingest-progress", (event) => {
      setPercent(event.payload.percent);
      setStepText(event.payload.step);
      setErrorRows(event.payload.error_rows);
      if (event.payload.percent >= 100) {
        setDone(true);
      }
    });

    invoke("ingest_full_data", { filePath, cleanSql, tableName })
      .then(() => {
        invalidateBySourceTable(tableName);
        toast.success("全量入库完成");
        if (errorRows > 0) {
          toast.info(`入库成功，但跳过了 ${errorRows} 行异常数据`);
        }
      })
      .catch((e) => {
        toast.error(String(e));
        setStepText(`失败: ${e}`);
      });

    return () => {
      unlisten.then((f) => f());
    };
  }, [open]);

  const activeStep = percent < 50 ? 1 : percent < 85 ? 2 : 3;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>全量数据入库</DialogTitle>
        </DialogHeader>
        <div className="space-y-6 py-4">
          <Progress value={percent} className="h-2" />
          <p className="text-sm text-slate-600">{stepText}</p>

          <div className="space-y-3">
            {steps.map((s) => {
              const Icon = s.icon;
              const isActive = activeStep === s.id;
              const isDone = activeStep > s.id || done;
              return (
                <div key={s.id} className="flex items-center gap-3">
                  <Icon
                    className={`h-5 w-5 ${
                      isDone
                        ? "text-green-500"
                        : isActive
                        ? "text-blue-600 animate-pulse"
                        : "text-slate-300"
                    }`}
                  />
                  <span
                    className={`text-sm ${
                      isActive ? "font-bold text-blue-700" : ""
                    } ${isDone ? "text-green-600" : ""}`}
                  >
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>

          {done && (
            <div className="text-xs text-slate-500 bg-slate-50 p-3 rounded">
              后续直接上传同名表格可自动追加数据
            </div>
          )}

          {done && (
            <Button className="w-full" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
