import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Loader2, Bot, Clock, CheckCircle2, Circle, Zap, FileSpreadsheet, X, Database } from "lucide-react";
import InputArea, { type Attachment } from "@/components/InputArea";
import MessageBubble from "@/components/MessageBubble";
import ExecutionTracker from "@/components/ExecutionTracker";
import AiHtmlBuildOverlay from "@/components/AiHtmlBuildOverlay";
import { useApp, type ChatMessage, type Dashboard } from "@/lib/AppContext";
import { estimateTokens } from "@/lib/thoughtGuideQuestions";
import { formatBeijingTime } from "@/lib/utils";
import { invalidateBySourceTable, invalidateOne } from "@/lib/dashboardHtmlCache";
import DbTableSelectModal, { type DbTablePreview } from "@/components/DbTableSelectModal";

interface StepStatus {
  id: string;
  label: string;
  status: "pending" | "active" | "completed" | "error";
}

interface TablePreviewPayload {
  sheet_name: string;
  columns: string[];
  preview_data: string[][];
}

interface ChatTablePreview {
  file_name: string;
  sheet_name: string;
  columns: string[];
  preview_data: string[][];
}

interface CreateDashboardResult {
  dashboard_id: string;
  dashboard_name: string;
  created_tables: string[];
  warnings: string[];
}

interface ModifyingState {
  status: "idle" | "updating" | "success" | "error";
  dashboardId?: string;
  error?: string;
}

interface AIChatProps {
  sessionId: string | null;
  onSessionChange?: (id: string) => void;
  dashboardTag?: string;
  onClearDashboardTag?: () => void;
}

export default function AIChat({
  sessionId,
  onSessionChange,
  dashboardTag,
  onClearDashboardTag,
}: AIChatProps) {
  const { sessions, refreshSessions, refreshDashboards, switchView, setBoardsSelectedId } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [thoughtGuideMode, setThoughtGuideMode] = useState(true);
  const [tokenCount, setTokenCount] = useState(0);
  const [submittedMessageIds, setSubmittedMessageIds] = useState<Set<string>>(new Set());
  const [filePreview, setFilePreview] = useState<TablePreviewPayload | null>(null);
  const [filePath, setFilePath] = useState("");
  const [parsingFile, setParsingFile] = useState(false);
  const [_modifyTrackerActive, _setModifyTrackerActive] = useState(false);
  const [modifyingState, setModifyingState] = useState<ModifyingState>({ status: "idle" });
  const [htmlBuildActive, setHtmlBuildActive] = useState(false);
  const [steps, setSteps] = useState<StepStatus[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [nodePositions, setNodePositions] = useState<{ id: string; top: number; preview: string }[]>([]);
  const [dbSelectOpen, setDbSelectOpen] = useState(false);
  const [dbTablePreviews, setDbTablePreviews] = useState<DbTablePreview[]>([]);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const [dashboardContext, setDashboardContext] = useState<string | null>(null);

  useEffect(() => {
    if (!dashboardTag) {
      setDashboardContext(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await invoke<Dashboard>("get_dashboard", { id: dashboardTag });
        let ctx = `当前正在修改的看板信息：\n- 名称：${d.name}\n- 描述：${d.description || "无"}\n`;
        if (d.source_table) {
          ctx += `- 源数据表：${d.source_table}\n`;
        }
        if (d.html_content) {
          ctx += `\n【当前看板完整 HTML 源码（修改时务必输出新的完整 HTML，保留 window.rawExcelData / runAnalysisLogic / 中文列名 key）】\n${d.html_content}\n`;
        }
        if (d.source_table) {
          try {
            const sql = `SELECT * FROM "${d.source_table}" LIMIT 20`;
            const sqlRes = await invoke<{ columns: string[]; rows: string[][] }>(
              "run_sql_query_for_chat",
              { sql }
            );
            const previewRows = sqlRes.rows.map((row) => {
              const obj: Record<string, string> = {};
              sqlRes.columns.forEach((c, i) => {
                obj[c] = row[i] ?? "";
              });
              return obj;
            });
            ctx += `\n【源表 ${d.source_table} 前 ${previewRows.length} 行预览】\n${JSON.stringify(previewRows, null, 2)}\n`;
          } catch {
            // 静默忽略：无源表预览不影响修改
          }
        }
        ctx += `\n请基于以上看板信息进行修改，并在回复最末尾输出完整新 HTML 代码块。`;
        if (!cancelled) setDashboardContext(ctx);
      } catch {
        if (!cancelled) setDashboardContext(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboardTag]);

  useEffect(() => {
    if (loading && startTime) {
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTime);
      }, 100);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setElapsedMs(0);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [loading, startTime]);

  // 计算用户消息节点位置
  useEffect(() => {
    const update = () => {
      const container = scrollRef.current;
      if (!container) return;
      const nodes: { id: string; top: number; preview: string }[] = [];
      container.querySelectorAll("[data-role='user']").forEach((el) => {
        const htmlEl = el as HTMLElement;
        nodes.push({
          id: htmlEl.dataset.msgId || "",
          top: htmlEl.offsetTop + htmlEl.offsetHeight / 2,
          preview: (htmlEl.dataset.preview || "").slice(0, 30),
        });
      });
      setNodePositions(nodes);
    };
    update();
    const el = scrollRef.current;
    const ro = new ResizeObserver(update);
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [messages]);

  useEffect(() => {
    if (currentSession) {
      setMessages(currentSession.messages);
      setThoughtGuideMode(currentSession.thought_guide_mode);
      setTokenCount(currentSession.token_count);
    } else {
      setMessages([
        {
          id: "welcome",
          role: "assistant",
          content:
            "你好！我是AI分析助手。请描述你的数据分析需求，我会帮你梳理思路、设计看板。\n\n当前已开启【帮我梳理】模式，我会先确认需求细节再给出方案。",
        },
      ]);
      setThoughtGuideMode(true);
      setTokenCount(0);
    }
    setSubmittedMessageIds(new Set());
  }, [sessionId, currentSession]);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  const TABLE_PREVIEW_LIMIT = 20;
  const TABLE_EXTS = ["xlsx", "xls", "csv"];

  // 把任意磁盘上的表格文件解析为 chat 用的预览(只取前 20 行)
  const parseTablePreview = async (filePath: string): Promise<TablePreviewPayload | null> => {
    const result = await invoke<{ sheets: { sheet_name: string; columns: string[]; preview_data: string[][] }[] }>(
      "parse_excel",
      { path: filePath }
    );
    const first = result.sheets[0];
    if (!first) return null;
    return {
      sheet_name: first.sheet_name,
      columns: first.columns,
      preview_data: first.preview_data.slice(0, TABLE_PREVIEW_LIMIT),
    };
  };

  // 加载表格预览,把数据注入到 AI 聊天上下文
  const handleLoadTable = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "表格文件", extensions: ["xlsx", "xls", "csv"] }],
      });
      if (!selected || typeof selected !== "string") return;
      setParsingFile(true);
      try {
        const preview = await parseTablePreview(selected);
        if (!preview) {
          toast.error("表格未解析到任何工作表");
          return;
        }
        setFilePath(selected);
        setFilePreview(preview);
        toast.success(
          `已加载表格: ${preview.sheet_name}（${preview.columns.length} 列, 预览 ${preview.preview_data.length} 行）`
        );
      } catch (e) {
        toast.error("解析表格失败: " + String(e));
      } finally {
        setParsingFile(false);
      }
    } catch (e) {
      toast.error("选择文件失败: " + String(e));
    }
  };

  const handleClearTable = () => {
    setFilePreview(null);
    setFilePath("");
  };

  // 清洗 AI 返回内容，去除重复的诊断反馈段落
  const sanitizeAssistantContent = useCallback((content: string): string => {
    const marker = "【诊断反馈】";
    const indices: number[] = [];
    let idx = content.indexOf(marker);
    while (idx !== -1) {
      indices.push(idx);
      idx = content.indexOf(marker, idx + marker.length);
    }
    if (indices.length > 1) {
      // 保留最后一个【诊断反馈】及其后的内容
      return content.slice(indices[indices.length - 1]).trim();
    }
    return content.trim();
  }, []);

  // 从 AI 回复中提取 ```html ...``` 代码块；找不到返回 null
  const extractHtmlBlock = useCallback((content: string): string | null => {
    const re = /```html\s*\n([\s\S]*?)```/i;
    const match = content.match(re);
    if (match && match[1]) {
      const html = match[1].trim();
      if (html.toLowerCase().includes("<!doctype html") || html.toLowerCase().includes("<html")) {
        return html;
      }
    }
    return null;
  }, []);

  // 把 AI 回复里的 ```html ...``` 代码块替换为轻提示，保留前置解释文字
  const stripHtmlBlockForBubble = useCallback((content: string, mode: "create" | "modify"): string => {
    const replacement =
      mode === "modify"
        ? "✅ 已生成完整看板新 HTML，正在为你替换看板源码…"
        : "✅ 已生成完整看板 HTML，正在为你创建数据表与看板…";
    const re = /```html\s*\n[\s\S]*?```/i;
    const replaced = content.replace(re, replacement).trim();
    return replaced || replacement;
  }, []);

  const persistSession = useCallback(
    async (newMessages: ChatMessage[], newTokenCount: number, newTitle?: string) => {
      if (!sessionId) return;
      try {
        await invoke("update_session", {
          sessionId,
          messages: newMessages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            duration_ms: m.durationMs,
            attachments: m.attachments,
          })),
          tokenCount: newTokenCount,
          title: newTitle,
          thoughtGuideMode,
        });
        refreshSessions();
      } catch (e) {
        console.error("Failed to persist session:", e);
      }
    },
    [sessionId, thoughtGuideMode, refreshSessions]
  );

  const handleSend = async (text: string, files: Attachment[]) => {
    if ((!text.trim() && files.length === 0) || loading) return;

    let effectivePreview = filePreview;
    let effectivePath = filePath;
    let appendedNote = "";
    const allTablePreviews: ChatTablePreview[] = [];

    // 表格附件：遍历所有表格做 20 行预览
    const tableAttachments = files.filter(
      (f) => f.isTable && !!f.path && TABLE_EXTS.includes(((f.path || "").split(".").pop() || "").toLowerCase())
    );
    if (tableAttachments.length > 0) {
      setParsingFile(true);
      for (const ta of tableAttachments) {
        try {
          const preview = await parseTablePreview(ta.path!);
          if (preview) {
            allTablePreviews.push({
              file_name: ta.path!.split(/[\\/]/).pop() ?? ta.path!,
              sheet_name: preview.sheet_name,
              columns: preview.columns,
              preview_data: preview.preview_data,
            });
          }
        } catch (e) {
          toast.error(`解析表格附件失败(${ta.displayName}): ` + String(e));
        }
      }
      setParsingFile(false);
      if (allTablePreviews.length > 0) {
        toast.success(
          `表格附件已处理: 共 ${allTablePreviews.length} 份表格（各取前 20 行送 AI）`
        );
      }
    }

    // 非表格附件：附加到用户消息中作为引用(目前仅文件名/路径)
    const otherAttachments = files.filter((f) => !f.isTable);
    if (otherAttachments.length > 0) {
      appendedNote =
        "\n\n[附件]\n" +
        otherAttachments
          .map((f) => `- ${f.displayName}${f.path ? ` (${f.path})` : ""}`)
          .join("\n");
    }

    void effectivePath;

    const reqStartTime = Date.now();
    setStartTime(reqStartTime);
    setSteps([
      { id: "prepare", label: "准备请求", status: "completed" },
      { id: "connect", label: "连接AI服务", status: "active" },
      { id: "wait", label: "等待AI回复", status: "pending" },
      { id: "process", label: "处理结果", status: "pending" },
    ]);

    const userText = text + appendedNote;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: userText,
      timestamp: formatBeijingTime(new Date()),
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setTimeout(scrollToBottom, 100);

    const newTokenCount = tokenCount + estimateTokens(userText);
    setTokenCount(newTokenCount);

    if (!sessionId) {
      try {
        const newSessionId = await invoke<string>("create_session", {
          title: text.slice(0, 30),
          thoughtGuideMode,
          dashboardId: dashboardTag || null,
        });
        onSessionChange?.(newSessionId);
        await invoke("update_session", {
          sessionId: newSessionId,
          messages: newMessages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            duration_ms: m.durationMs,
          })),
          tokenCount: newTokenCount,
          thoughtGuideMode,
        });
        refreshSessions();
      } catch (e) {
        toast.error("创建会话失败: " + String(e));
        setSteps((prev) =>
          prev.map((s) => (s.id === "connect" ? { ...s, status: "error" } : s))
        );
        setLoading(false);
        return;
      }
    } else {
      await persistSession(newMessages, newTokenCount);
    }

    try {
      setSteps((prev) =>
        prev.map((s) =>
          s.id === "connect"
            ? { ...s, status: "completed" }
            : s.id === "wait"
            ? { ...s, status: "active" }
            : s
        )
      );

      let history: { role: string; content: string }[] = newMessages.map((m) => ({ role: m.role, content: m.content }));
      if (dashboardContext) {
        history = [{ role: "system", content: dashboardContext }, ...history];
      }

      const res = await invoke<string>("chat_workbench", {
        messages: history,
        tablePreview: effectivePreview,
        dbTablePreviews: dbTablePreviews.length > 0 ? dbTablePreviews : null,
        chatAttachmentPreviews: allTablePreviews.length > 0 ? allTablePreviews : null,
        thoughtGuideMode,
        modifyingDashboard: !!dashboardTag,
      });

      setSteps((prev) =>
        prev.map((s) =>
          s.id === "wait"
            ? { ...s, status: "completed" }
            : s.id === "process"
            ? { ...s, status: "active" }
            : s
        )
      );

      const html = extractHtmlBlock(res);
      let displayContent: string;

      if (html) {
        const mode: "create" | "modify" = dashboardTag ? "modify" : "create";
        displayContent = stripHtmlBlockForBubble(res, mode);
        setHtmlBuildActive(true);
        setModifyingState({ status: "updating" });

        try {
          if (mode === "modify" && dashboardTag) {
            await invoke("update_dashboard", {
              id: dashboardTag,
              htmlContent: html,
            });
            invalidateOne(dashboardTag);
            try {
              const d = await invoke<Dashboard>("get_dashboard", { id: dashboardTag });
              if (d.source_table) invalidateBySourceTable(d.source_table);
            } catch {
              // 静默忽略
            }
            setModifyingState({ status: "success", dashboardId: dashboardTag });
            refreshDashboards();
          } else {
            // 创建模式：把当前预览的单文件 + 聊天附件表格 → NewFileSpec[]
            const newFiles: { file_path: string; target_table_name: string }[] = [];
            const seen = new Set<string>();
            const toTargetName = (p: string, idx: number): string => {
              const fname = p.split(/[\\/]/).pop() || `file_${idx}`;
              const baseName = fname.replace(/\.(xlsx|xls|csv)$/i, "");
              return baseName.toLowerCase().replace(/[^a-z0-9_]/g, "_") || `t_data_${idx}`;
            };
            if (filePath) {
              newFiles.push({ file_path: filePath, target_table_name: toTargetName(filePath, 0) });
              seen.add(filePath);
            }
            tableAttachments.forEach((ta, idx) => {
              if (!ta.path || seen.has(ta.path)) return;
              newFiles.push({ file_path: ta.path, target_table_name: toTargetName(ta.path, idx + 1) });
              seen.add(ta.path);
            });
            const existingTables = dbTablePreviews.map((p) => p.table_name);

            if (newFiles.length === 0 && existingTables.length === 0) {
              throw new Error("缺少数据来源：请在工作台先选择数据库表或上传表格");
            }

            const result = await invoke<CreateDashboardResult>("create_dashboard_from_ai_html", {
              htmlContent: html,
              newFiles,
              existingTables,
              dashboardName: null,
            });
            result.created_tables.forEach((t) => invalidateBySourceTable(t));
            existingTables.forEach((t) => invalidateBySourceTable(t));
            setModifyingState({ status: "success", dashboardId: result.dashboard_id });
            refreshDashboards();
          }
        } catch (e) {
          setModifyingState({ status: "error", error: String(e) });
          toast.error(String(e));
        } finally {
          setHtmlBuildActive(false);
        }
      } else {
        // 没有 HTML 代码块 → 普通对话（追问 / 闲聊）
        displayContent = sanitizeAssistantContent(res) || res;
      }

      const currentMessages = newMessages;
      const currentTokenCount = newTokenCount;

      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: displayContent || "已为您处理请求。",
        timestamp: formatBeijingTime(new Date()),
        durationMs: Date.now() - reqStartTime,
      };

      const finalMessages = [...currentMessages, assistantMsg];
      setMessages(finalMessages);

      const finalTokenCount = currentTokenCount + estimateTokens(res);
      setTokenCount(finalTokenCount);
      await persistSession(finalMessages, finalTokenCount);

      setSteps((prev) =>
        prev.map((s) => (s.id === "process" ? { ...s, status: "completed" } : s))
      );
      setTimeout(scrollToBottom, 100);
    } catch (e) {
      setSteps((prev) =>
        prev.map((s) =>
          s.status === "active" ? { ...s, status: "error" } : s
        )
      );
      toast.error(String(e));
    } finally {
      setLoading(false);
      setStartTime(null);
    }
  };

  const handleThoughtSubmit = async (formattedText: string) => {
    const targetMsg = findLatestThoughtTarget();
    if (!targetMsg) return;

    setSubmittedMessageIds((prev) => new Set(prev).add(targetMsg.id));
    await handleSend(formattedText, []);
  };

  const findLatestThoughtTarget = (): ChatMessage | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        msg.role === "assistant" &&
        !submittedMessageIds.has(msg.id) &&
        msg.content.includes("【关键提问】")
      ) {
        return msg;
      }
    }
    return null;
  };

  const handleJumpToDashboard = () => {
    if (modifyingState.dashboardId) {
      setBoardsSelectedId(modifyingState.dashboardId);
      switchView("boards");
      setModifyingState({ status: "idle" });
    }
  };

  const handleClearDbTables = () => {
    setDbTablePreviews([]);
  };

  const latestAssistantId =
    messages.length > 0 && messages[messages.length - 1].role === "assistant"
      ? messages[messages.length - 1].id
      : null;

  return (
    <div className="flex flex-col h-full overflow-hidden"
    >
      {/* 表格加载工具条 */}
      <div className="px-4 py-2 border-b bg-slate-50/60 flex-shrink-0">
        <div className="max-w-4xl mx-auto flex items-center gap-2">
          <button
            onClick={handleLoadTable}
            disabled={parsingFile || loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-white text-xs hover:bg-slate-50 disabled:opacity-50"
          >
            {parsingFile ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
            ) : (
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
            )}
            {filePreview ? "更换表格" : "加载表格供 AI 分析"}
          </button>
          <button
            onClick={() => setDbSelectOpen(true)}
            disabled={parsingFile || loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-white text-xs hover:bg-slate-50 disabled:opacity-50"
          >
            <Database className="h-3.5 w-3.5 text-blue-600" />
            {dbTablePreviews.length > 0 ? "更换数据库" : "选择数据库"}
          </button>
          {filePreview && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">
              <FileSpreadsheet className="h-3 w-3" />
              <span className="max-w-[260px] truncate">
                {filePath ? filePath.split(/[\\/]/).pop() : filePreview.sheet_name}
              </span>
              <span className="text-emerald-600/80">
                · {filePreview.columns.length}列 / 预览{filePreview.preview_data.length}行
              </span>
              <button
                onClick={handleClearTable}
                className="ml-1 hover:text-emerald-900"
                title="清除"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {dbTablePreviews.length > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
              <Database className="h-3 w-3" />
              <span>已选 {dbTablePreviews.length} 张表</span>
              <button
                onClick={handleClearDbTables}
                className="ml-1 hover:text-blue-900"
                title="清除"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {!filePreview && dbTablePreviews.length === 0 && (
            <span className="text-xs text-slate-400">
              选择 xlsx/xls/csv 或数据库表后,AI 才能看到数据来生成看板
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 relative">
        <div className="absolute inset-0 overflow-y-auto overflow-x-hidden px-4 pr-7" ref={scrollRef}>
          <div className="space-y-4 py-4 max-w-4xl mx-auto">
            {messages.map((msg) => (
              <div
                key={msg.id}
                ref={(el) => { messageRefs.current[msg.id] = el; }}
                data-role={msg.role}
                data-msg-id={msg.id}
                data-preview={msg.content.slice(0, 30)}
              >
                <MessageBubble
                  message={msg}
                  thoughtGuideMode={thoughtGuideMode}
                  isSubmitted={submittedMessageIds.has(msg.id)}
                  onSubmitAnswers={handleThoughtSubmit}
                  isLatestAssistant={msg.id === latestAssistantId}
                />
              </div>
            ))}

            {_modifyTrackerActive && (
              <ExecutionTracker isActive={_modifyTrackerActive} />
            )}

            {loading && !_modifyTrackerActive && (
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="bg-slate-100 rounded-lg px-4 py-3 space-y-2 min-w-[280px]">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                    <span className="text-sm font-medium text-slate-700">
                      AI 正在处理...
                    </span>
                    <span className="text-xs text-slate-400 ml-auto flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {(elapsedMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {steps.map((step) => (
                      <div key={step.id} className="flex items-center gap-2 text-xs">
                        {step.status === "completed" ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        ) : step.status === "active" ? (
                          <Zap className="h-3.5 w-3.5 text-blue-500 animate-pulse" />
                        ) : step.status === "error" ? (
                          <Circle className="h-3.5 w-3.5 text-red-400" />
                        ) : (
                          <Circle className="h-3.5 w-3.5 text-slate-300" />
                        )}
                        <span
                          className={
                            step.status === "active"
                              ? "text-blue-600 font-medium"
                              : step.status === "completed"
                              ? "text-slate-600"
                              : step.status === "error"
                              ? "text-red-500"
                              : "text-slate-400"
                          }
                        >
                          {step.label}
                          {step.status === "active" && "..."}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* User message nodes */}
        {nodePositions.length > 0 && (
          <div className="absolute right-2 top-0 bottom-0 w-3 pointer-events-none">
            {nodePositions.map((node) => (
              <button
                key={node.id}
                className="absolute -translate-y-1/2 w-2 h-2 rounded-full bg-blue-400 hover:bg-blue-600 pointer-events-auto transition-colors"
                style={{ top: `${node.top}px` }}
                onClick={() => {
                  const el = messageRefs.current[node.id];
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                title={node.preview}
              />
            ))}
          </div>
        )}
      </div>

      {/* HTML 看板生成进度 */}
      <AiHtmlBuildOverlay
        isActive={htmlBuildActive}
        mode={dashboardTag ? "modify" : "create"}
      />

      {/* Dashboard Action Area */}
      {modifyingState.status === "updating" && !htmlBuildActive && (
        <div className="px-4 pb-2 max-w-4xl mx-auto w-full">
          <div className="border border-amber-200 bg-amber-50 rounded-lg p-4 flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
            <span className="text-sm font-medium text-amber-800">正在为您处理看板，请稍候...</span>
          </div>
        </div>
      )}
      {modifyingState.status === "success" && modifyingState.dashboardId && (
        <div className="px-4 pb-2 max-w-4xl mx-auto w-full">
          <div className="border border-green-200 bg-green-50 rounded-lg p-4 space-y-3">
            <p className="text-sm font-medium text-green-800">看板已处理完成！</p>
            <button
              onClick={handleJumpToDashboard}
              className="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700 flex items-center gap-1"
            >
              立即查看看板效果 →
            </button>
          </div>
        </div>
      )}
      {modifyingState.status === "error" && (
        <div className="px-4 pb-2 max-w-4xl mx-auto w-full">
          <div className="border border-red-200 bg-red-50 rounded-lg p-4">
            <p className="text-sm font-medium text-red-800">看板处理失败：{modifyingState.error}</p>
          </div>
        </div>
      )}

      <InputArea
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={() => setLoading(false)}
        loading={loading}
        thoughtGuideMode={thoughtGuideMode}
        onThoughtGuideChange={setThoughtGuideMode}
        tokenCount={tokenCount}
        dashboardTag={dashboardTag}
        onClearDashboardTag={onClearDashboardTag}
      />

      <DbTableSelectModal
        open={dbSelectOpen}
        onClose={() => setDbSelectOpen(false)}
        onConfirm={(previews) => setDbTablePreviews(previews)}
      />
    </div
    >
  );
}
