import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Loader2, Bot, Clock, CheckCircle2, Circle, Zap, FileSpreadsheet, X } from "lucide-react";
import InputArea, { type Attachment } from "@/components/InputArea";
import MessageBubble from "@/components/MessageBubble";
import ExecutionTracker from "@/components/ExecutionTracker";
import { useApp, type ChatMessage, type Dashboard } from "@/lib/AppContext";
import { estimateTokens } from "@/lib/thoughtGuideQuestions";
import IngestModal from "@/components/IngestModal";

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

interface IngestSuggestion {
  table_name: string;
  clean_sql: string;
}

interface ModifyingState {
  status: "idle" | "updating" | "success" | "error";
  dashboardId?: string;
  error?: string;
}

function formatBeijingTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
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
  const [suggestion, setSuggestion] = useState<IngestSuggestion | null>(null);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [_modifyTrackerActive, _setModifyTrackerActive] = useState(false);
  const [modifyingState, setModifyingState] = useState<ModifyingState>({ status: "idle" });
  const [steps, setSteps] = useState<StepStatus[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const [dashboardContext, setDashboardContext] = useState<string | null>(null);

  useEffect(() => {
    if (dashboardTag) {
      invoke<Dashboard>("get_dashboard", { id: dashboardTag })
        .then((d) => {
          const ctx = `当前正在修改的看板信息：\n- 名称：${d.name}\n- 描述：${d.description || "无"}\n- SQL模板：${d.sql_template || "无"}\n- 筛选器配置：${d.ui_filters || "[]"}\n- 图表配置：${d.charts || "[]"}\n请基于以上看板信息进行修改和优化。`;
          setDashboardContext(ctx);
        })
        .catch(() => setDashboardContext(null));
    } else {
      setDashboardContext(null);
    }
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

  // 去除 markdown 代码块
  const stripMarkdownCodeBlocks = useCallback((content: string): string => {
    return content.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  }, []);

  // 从 AI 回复中提取 action JSON
  const extractActionJson = useCallback((content: string): { action: string; dashboard?: any; table_name?: string; clean_sql?: string } | null => {
    const cleaned = stripMarkdownCodeBlocks(content);
    // 策略1：精确匹配 action 字段
    const patterns = [
      /\{\s*"action"\s*:\s*"create_dashboard"[\s\S]*?\}(?![\s\S]*\{\s*"action"\s*:)/,
      /\{\s*"action"\s*:\s*"update_dashboard"[\s\S]*?\}(?![\s\S]*\{\s*"action"\s*:)/,
      /\{\s*"action"\s*:\s*"ingest"[\s\S]*?\}(?![\s\S]*\{\s*"action"\s*:)/,
    ];
    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.action) return parsed;
        } catch {
          // 策略2：尝试用更宽松的贪婪匹配
          const looseMatch = cleaned.match(/\{[\s\S]*"action"\s*:\s*"[^"]+"[\s\S]*\}/);
          if (looseMatch) {
            try {
              const parsed = JSON.parse(looseMatch[0]);
              if (parsed.action) return parsed;
            } catch {
              // ignore
            }
          }
        }
      }
    }
    // 策略3：直接搜索最后出现的 { ... }
    const allJsonLike = cleaned.match(/\{[\s\S]*?\}/g);
    if (allJsonLike) {
      for (let i = allJsonLike.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(allJsonLike[i]);
          if (parsed.action) return parsed;
        } catch {
          // ignore
        }
      }
    }
    return null;
  }, [stripMarkdownCodeBlocks]);

  // 自动更新看板 — 只传 AI 明确给出的字段，防止清空现有数据
  // 特别注意：table_data 由系统从数据库自动查询填充，绝不从前端/AI 更新覆盖
  const autoUpdateDashboard = useCallback(async (dashboardConfig: any) => {
    if (!dashboardTag) return;
    setModifyingState({ status: "updating" });
    try {
      const payload: Record<string, any> = { id: dashboardTag };
      if ("name" in dashboardConfig) payload.name = dashboardConfig.name;
      if ("description" in dashboardConfig) payload.description = dashboardConfig.description || "";
      if ("sql_template" in dashboardConfig) payload.sqlTemplate = dashboardConfig.sql_template || "";
      if ("ui_filters" in dashboardConfig) payload.uiFilters = JSON.stringify(dashboardConfig.ui_filters || []);
      if ("charts" in dashboardConfig) payload.charts = JSON.stringify(dashboardConfig.charts || []);
      // 严禁传递 table_data，防止 AI 误清空看板数据
      // if ("table_data" in dashboardConfig) payload.tableData = ...
      if ("source_table" in dashboardConfig) payload.sourceTable = dashboardConfig.source_table || "";
      await invoke("update_dashboard", payload);
      setModifyingState({ status: "success", dashboardId: dashboardTag });
      refreshDashboards();
    } catch (e) {
      setModifyingState({ status: "error", error: String(e) });
    }
  }, [dashboardTag, refreshDashboards]);

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

    // 表格附件：取第一份做 20 行预览,覆盖工具条加载的预览(如有)
    let effectivePreview = filePreview;
    let effectivePath = filePath;
    let appendedNote = "";
    const tableAttachments = files.filter(
      (f) => f.isTable && !!f.path && TABLE_EXTS.includes(((f.path || "").split(".").pop() || "").toLowerCase())
    );
    if (tableAttachments.length > 0) {
      const ta = tableAttachments[0];
      try {
        setParsingFile(true);
        const preview = await parseTablePreview(ta.path!);
        if (preview) {
          effectivePreview = preview;
          effectivePath = ta.path!;
          setFilePreview(preview);
          setFilePath(ta.path!);
          toast.success(
            `表格附件已处理: ${preview.sheet_name}（${preview.columns.length}列, 取前 ${preview.preview_data.length} 行送 AI）`
          );
        }
      } catch (e) {
        toast.error("解析表格附件失败: " + String(e));
      } finally {
        setParsingFile(false);
      }
      if (tableAttachments.length > 1) {
        toast.info(`检测到 ${tableAttachments.length} 个表格附件,本次仅使用第一个: ${ta.displayName}`);
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

      let displayContent = res;
      let parsedDashboard: any = null;

      // 使用鲁棒的 JSON 提取器解析 AI 回复中的 action
      const extractedAction = extractActionJson(res);

      if (extractedAction) {
        const jsonRaw = JSON.stringify(extractedAction);
        displayContent = sanitizeAssistantContent(res.replace(jsonRaw, "").trim()) || res.replace(jsonRaw, "").trim();

        if (extractedAction.action === "create_dashboard" && extractedAction.dashboard) {
          parsedDashboard = extractedAction.dashboard;
          setModifyingState({ status: "updating" });
          try {
            const newId = await invoke<string>("create_dashboard", {
              name: parsedDashboard.name,
              description: parsedDashboard.description || "",
              sqlTemplate: parsedDashboard.sql_template || "",
              uiFilters: JSON.stringify(parsedDashboard.ui_filters || []),
              charts: JSON.stringify(parsedDashboard.charts || []),
              tableData: JSON.stringify(parsedDashboard.table_data || []),
              sourceTable: parsedDashboard.source_table || "",
            });
            setModifyingState({ status: "success", dashboardId: newId });
            refreshDashboards();
          } catch (e) {
            setModifyingState({ status: "error", error: String(e) });
          }
        }

        if (extractedAction.action === "update_dashboard" && extractedAction.dashboard) {
          parsedDashboard = extractedAction.dashboard;
          if (dashboardTag) {
            await autoUpdateDashboard(parsedDashboard);
          } else {
            setModifyingState({ status: "updating" });
            try {
              const newId = await invoke<string>("create_dashboard", {
                name: parsedDashboard.name,
                description: parsedDashboard.description || "",
                sqlTemplate: parsedDashboard.sql_template || "",
                uiFilters: JSON.stringify(parsedDashboard.ui_filters || []),
                charts: JSON.stringify(parsedDashboard.charts || []),
                tableData: JSON.stringify(parsedDashboard.table_data || []),
                sourceTable: parsedDashboard.source_table || "",
              });
              setModifyingState({ status: "success", dashboardId: newId });
              refreshDashboards();
            } catch (e) {
              setModifyingState({ status: "error", error: String(e) });
            }
          }
        }

        if (extractedAction.action === "ingest") {
          setSuggestion({
            table_name: extractedAction.table_name || "t_data",
            clean_sql: extractedAction.clean_sql || "",
          });
        }
      } else if (dashboardTag) {
        // 处于修改模式但未提取到 JSON，给出提示
        displayContent = res + "\n\n【系统提示】未检测到可执行的操作指令，请尝试更明确地描述修改需求（例如：把饼图改成显示百分比）";
      }

      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: displayContent || "已为您处理请求。",
        timestamp: formatBeijingTime(new Date()),
        durationMs: Date.now() - reqStartTime,
      };

      const finalMessages = [...newMessages, assistantMsg];
      setMessages(finalMessages);

      const finalTokenCount = newTokenCount + estimateTokens(res);
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
          {!filePreview && (
            <span className="text-xs text-slate-400">
              选择 xlsx/xls/csv 后,AI 才能看到表头与样例数据来生成看板
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 px-4 overflow-y-auto overflow-x-hidden min-h-0" ref={scrollRef}>
        <div className="space-y-4 py-4 max-w-4xl mx-auto">
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              thoughtGuideMode={thoughtGuideMode}
              isSubmitted={submittedMessageIds.has(msg.id)}
              onSubmitAnswers={handleThoughtSubmit}
              isLatestAssistant={msg.id === latestAssistantId}
            />
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

      {/* Dashboard Action Area */}
      {modifyingState.status === "updating" && (
        <div className="px-4 pb-2 max-w-4xl mx-auto w-full">
          <div className="border border-amber-200 bg-amber-50 rounded-lg p-4 flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
            <span className="text-sm font-medium text-amber-800">正在为您修改看板，请稍候...</span>
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

      <IngestModal
        filePath={filePath}
        cleanSql={suggestion?.clean_sql || ""}
        tableName={suggestion?.table_name || "t_data"}
        open={ingestOpen}
        onOpenChange={setIngestOpen}
      />
    </div
    >
  );
}
