import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { invoke } from "@tauri-apps/api/core";
import { UploadCloud, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SheetPreview {
  sheet_name: string;
  columns: string[];
  preview_data: string[][];
  is_truncated: boolean;
  truncated_rows: number;
}

interface ParseResult {
  sheets: SheetPreview[];
}

export default function Dropzone() {
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [open, setOpen] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!["xlsx", "xls", "csv"].includes(ext || "")) {
      toast.error("仅支持 xlsx/xls/csv 格式文件");
      return;
    }

    // 由于 Tauri 前端无法直接获取本地绝对路径，我们通过 dropzone 的 path 获取
    // @ts-expect-error electron/tauri specific path property
    const path = file?.path as string | undefined;
    if (!path) {
      toast.error("无法获取文件路径，请直接选择本地文件");
      return;
    }

    setParsing(true);
    invoke<ParseResult>("parse_excel", { path })
      .then((res) => {
        setPreview(res);
        setOpen(true);
        toast.success(`解析成功，共 ${res.sheets.length} 个工作表`);
      })
      .catch((e) => {
        toast.error(String(e));
      })
      .finally(() => {
        setParsing(false);
      });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel": [".xls"],
      "text/csv": [".csv"],
    },
    multiple: false,
  });

  return (
    <div className="w-full">
      <div
        {...getRootProps()}
        className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors cursor-pointer min-h-[240px] ${
          isDragActive
            ? "border-blue-400 bg-blue-50"
            : "border-gray-300 bg-white hover:bg-gray-50"
        }`}
      >
        <input {...getInputProps()} />
        {parsing ? (
          <div className="flex flex-col items-center gap-4 w-full px-8">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-8 w-2/3" />
            <p className="text-sm text-slate-500">正在高速解析表格...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 p-8">
            <UploadCloud className="h-12 w-12 text-slate-400" />
            <p className="text-lg font-medium text-slate-700">
              {isDragActive ? "松开即可上传" : "拖拽或点击上传表格"}
            </p>
            <p className="text-sm text-slate-500">支持 .xlsx / .xls / .csv</p>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              数据预览
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            {preview?.sheets.map((sheet) => (
              <div key={sheet.sheet_name} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">{sheet.sheet_name}</span>
                  {sheet.is_truncated && (
                    <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">
                      已截取前 {sheet.truncated_rows} 行
                    </span>
                  )}
                </div>
                <ScrollArea className="border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {sheet.columns.map((col, i) => (
                          <TableHead key={i}>{col}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sheet.preview_data.map((row, ri) => (
                        <TableRow key={ri}>
                          {row.map((cell, ci) => (
                            <TableCell key={ci}>{cell}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
