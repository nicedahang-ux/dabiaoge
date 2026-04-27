import { useState, useRef, useCallback, useEffect } from "react";
import { ArrowUp, Square, Paperclip, X, FileText, FileSpreadsheet } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { estimateTokens } from "@/lib/thoughtGuideQuestions";
import { toast } from "sonner";

const TABLE_EXTENSIONS = ["xlsx", "xls", "csv"];

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export interface Attachment {
  file?: File;
  previewUrl?: string;
  // Tauri 对话框选取的真实磁盘路径（用于表格解析等需要后端读取的场景）
  path?: string;
  // 显示用的文件名（path 模式没有 File 对象时使用）
  displayName: string;
  // 是否是表格类（xlsx/xls/csv）
  isTable: boolean;
}

interface InputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string, files: Attachment[]) => void;
  onStop?: () => void;
  loading?: boolean;
  thoughtGuideMode?: boolean;
  onThoughtGuideChange?: (enabled: boolean) => void;
  tokenCount?: number;
  dashboardTag?: string;
  onClearDashboardTag?: () => void;
}

export default function InputArea({
  value,
  onChange,
  onSend,
  onStop,
  loading = false,
  thoughtGuideMode = true,
  onThoughtGuideChange,
  tokenCount = 0,
  dashboardTag,
  onClearDashboardTag,
}: InputAreaProps) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 全局粘贴监听：无论焦点在哪个输入框，只要剪贴板里有文件就捕获到附件
  useEffect(() => {
    const handleDocPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pastedFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file") {
          const file = items[i].getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        const dt = new DataTransfer();
        pastedFiles.forEach((f) => dt.items.add(f));
        handleFiles(dt.files);
        // 聚焦回主输入框，方便用户继续打字
        textareaRef.current?.focus();
      }
    };
    document.addEventListener("paste", handleDocPaste);
    return () => document.removeEventListener("paste", handleDocPaste);
  }, []);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    adjustHeight();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if (loading) {
      onStop?.();
      return;
    }
    const trimmed = value.trim();
    if (!trimmed && files.length === 0) return;
    onSend(trimmed, files);
    onChange("");
    setFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleFileSelect = async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        // 不设 filters：用户想要"大多数文件直传 AI"
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newAttachments: Attachment[] = paths.map((p) => {
        const name = p.split(/[\\/]/).pop() || p;
        const ext = getExtension(name);
        return {
          path: p,
          displayName: name,
          isTable: TABLE_EXTENSIONS.includes(ext),
        };
      });
      setFiles((prev) => [...prev, ...newAttachments]);
    } catch (e) {
      toast.error("选择文件失败: " + String(e));
    }
  };

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const newFiles: Attachment[] = Array.from(fileList).map((file) => {
      const ext = getExtension(file.name);
      // Tauri webview 拖拽文件时会携带本地绝对路径
      // @ts-expect-error tauri specific path property
      const path = file.path as string | undefined;
      return {
        file,
        path,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        displayName: file.name,
        isTable: TABLE_EXTENSIONS.includes(ext),
      };
    });
    setFiles((prev) => [...prev, ...newFiles]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => {
      const removed = prev[index];
      if (removed.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const currentInputTokens = estimateTokens(value);
  const totalTokens = tokenCount + currentInputTokens;
  const maxTokens = 1_000_000;
  const tokenWarning = totalTokens > maxTokens * 0.9;

  return (
    <div className="border-t bg-white p-4">
      <div className="max-w-4xl mx-auto space-y-2">
        {/* Dashboard Tag */}
        {dashboardTag && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-medium">
              <FileText className="h-3 w-3" />
              看板ID: {dashboardTag}
              <button
                onClick={onClearDashboardTag}
                className="ml-1 hover:text-amber-900"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        )}

        {/* File Preview */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((att, index) => (
              <div
                key={`${att.displayName}-${index}`}
                className={`flex items-center gap-2 border rounded-md px-2 py-1 text-xs group ${
                  att.isTable
                    ? "bg-emerald-50 border-emerald-200"
                    : "bg-slate-100 border-slate-200"
                }`}
                title={att.path || att.displayName}
              >
                {att.previewUrl ? (
                  <button
                    onClick={() => setPreviewImage(att.previewUrl!)}
                    className="flex-shrink-0"
                  >
                    <img
                      src={att.previewUrl}
                      alt="preview"
                      className="h-6 w-6 rounded object-cover"
                    />
                  </button>
                ) : att.isTable ? (
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                ) : (
                  <FileText className="h-4 w-4 text-slate-400 flex-shrink-0" />
                )}
                <span className="max-w-[150px] truncate">{att.displayName}</span>
                {att.isTable && (
                  <span className="text-[10px] text-emerald-700 bg-emerald-100 rounded px-1">
                    表格·前20行
                  </span>
                )}
                <button
                  onClick={() => removeFile(index)}
                  className="text-slate-400 hover:text-red-500"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input Row */}
        <div className="flex items-end gap-2">
          <div className="flex items-center gap-1 flex-shrink-0 pb-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={handleFileSelect}
              title="添加附件"
            >
              <Paperclip className="h-4 w-4 text-slate-500" />
            </Button>
          </div>

          <div
            className={`flex-1 relative rounded-lg border transition-all ${
              isDragging
                ? "border-blue-400 ring-4 ring-blue-50"
                : "border-slate-200 focus-within:border-slate-300 focus-within:ring-4 focus-within:ring-gray-50"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder="问点什么... (Enter 换行, Cmd/Ctrl + Enter 发送)"
              className="w-full min-h-[60px] max-h-[200px] px-3 py-2 bg-transparent resize-none outline-none text-sm"
              disabled={loading}
              rows={1}
            />
            {isDragging && (
              <div className="absolute inset-0 flex items-center justify-center bg-blue-50/80 rounded-lg text-sm text-blue-600 pointer-events-none">
                松开即可上传文件
              </div>
            )}
          </div>

          <button
            className={`self-end h-10 w-10 flex items-center justify-center rounded-full flex-shrink-0 transition-all duration-300 ${
              loading
                ? "bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-500/30 animate-pulse"
                : value.trim() || files.length > 0
                ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/30 hover:scale-105"
                : "bg-slate-200 text-slate-400 cursor-not-allowed"
            }`}
            onClick={handleSend}
            disabled={!loading && !value.trim() && files.length === 0}
          >
            {loading ? (
              <Square className="h-4 w-4 rounded-sm" />
            ) : (
              <ArrowUp className="h-5 w-5" />
            )}
          </button>
        </div>

        {/* Bottom Bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {onThoughtGuideChange && (
              <div className="flex items-center gap-2">
                <Switch
                  checked={thoughtGuideMode}
                  onCheckedChange={onThoughtGuideChange}
                  id="thought-guide"
                />
                <label
                  htmlFor="thought-guide"
                  className="text-xs text-slate-600 cursor-pointer select-none"
                >
                  🤔 帮我梳理
                </label>
              </div>
            )}
          </div>

          <div
            className={`text-xs ${
              tokenWarning ? "text-red-500 font-medium" : "text-slate-400"
            }`}
          >
            Tokens: {totalTokens.toLocaleString()} / {maxTokens.toLocaleString()}
            {tokenWarning && " (接近上限)"}
          </div>
        </div>
      </div>

      {/* Image Preview Modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <img
              src={previewImage}
              alt="preview"
              className="max-w-full max-h-[90vh] rounded-lg"
            />
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-3 -right-3 bg-white rounded-full p-1 shadow-lg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
