import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Loader2, Bot, Clock, CheckCircle2, Circle, Zap, FileSpreadsheet, X, Database } from "lucide-react";
import InputArea, { type Attachment } from "@/components/InputArea";
import MessageBubble from "@/components/MessageBubble";
import ExecutionTracker from "@/components/ExecutionTracker";
import { useApp, type ChatMessage, type Dashboard } from "@/lib/AppContext";
import { estimateTokens } from "@/lib/thoughtGuideQuestions";
import { formatBeijingTime } from "@/lib/utils";
import IngestModal from "@/components/IngestModal";
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

interface IngestSuggestion {
  table_name: string;
  clean_sql: string;
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
  const [suggestion, setSuggestion] = useState<IngestSuggestion | null>(null);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [_modifyTrackerActive, _setModifyTrackerActive] = useState(false);
  const [modifyingState, setModifyingState] = useState<ModifyingState>({ status: "idle" });
  const [steps, setSteps] = useState<StepStatus[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [nodePositions, setNodePositions] = useState<{ id: string; top: number; preview: string }[]>([]);
  const [dbSelectOpen, setDbSelectOpen] = useState(false);
  const [dbTablePreviews, setDbTablePreviews] = useState<DbTablePreview[]>([]);
  const [retryStatus, setRetryStatus] = useState<{ active: boolean; attempt: number; total: number }>({
    active: false,
    attempt: 0,
    total: 3,
  });

  const currentSession = sessions.find((s) => s.id === sessionId);
  const [dashboardContext, setDashboardContext] = useState<string | null>(null);

  useEffect(() => {
    if (dashboardTag) {
      invoke<Dashboard>("get_dashboard", { id: dashboardTag })
        .then((d) => {
          let ctx = `当前正在修改的看板信息：\n- 名称：${d.name}\n- 描述：${d.description || "无"}\n- SQL模板：${d.sql_template || "无"}\n- 筛选器配置：${d.ui_filters || "[]"}\n- 图表配置：${d.charts || "[]"}\n`;
          if (d.summary_cards) {
            try { ctx += `- 摘要卡片：${d.summary_cards}\n`; } catch {}
          }
          if (d.actions) {
            try { ctx += `- 操作按钮：${d.actions}\n`; } catch {}
          }
          if (d.table_data) {
            try {
              const rows = JSON.parse(d.table_data) as Record<string, unknown>[];
              if (rows.length > 0) {
                const preview = rows.slice(0, 10);
                ctx += `- 明细数据前 ${preview.length} 行：\n${JSON.stringify(preview, null, 2)}\n`;
              }
            } catch {}
          }
          ctx += `请基于以上看板信息进行修改和优化。`;
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

  // 去除 markdown 代码块
  const stripMarkdownCodeBlocks = useCallback((content: string): string => {
    return content.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  }, []);

  // 从 AI 回复中提取 action JSON
  const extractActionJson = useCallback((content: string): { action: string; dashboard?: any; table_name?: string; clean_sql?: string; sql?: string } | null => {
    const cleaned = stripMarkdownCodeBlocks(content);
    // 策略1：精确匹配 action 字段
    const patterns = [
      /\{\s*"action"\s*:\s*"create_dashboard"[\s\S]*?\}(?![\s\S]*\{\s*"action"\s*:)/,
      /\{\s*"action"\s*:\s*"update_dashboard"[\s\S]*?\}(?![\s\S]*\{\s*"action"\s*:)/,
      /\{\s*"action"\s*:\s*"ingest"[\s\S]*?\}(?![\s\S]*\{\s*"action"\s*:)/,
      /\{\s*"action"\s*:\s*"run_sql"[\s\S]*?\}(?![\s\S]*\{\s*"action"\s*:)/,
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

  // 规范化 AI 返回的 action JSON，处理常见字段名不匹配问题
  const normalizeActionJson = useCallback((raw: any): any => {
    if (!raw || !raw.action) return raw;
    const normalized = { ...raw };

    // 处理 create_dashboard / update_dashboard
    if (["create_dashboard", "update_dashboard"].includes(raw.action)) {
      let dashboard = raw.dashboard;

      // AI 经常漏掉 dashboard 包装层，把字段直接放在顶层
      if (!dashboard && (raw.name || raw.title || raw.sql_template || raw.filters || raw.charts)) {
        const { action: _, ...rest } = raw;
        dashboard = rest;
        normalized.dashboard = dashboard;
      }

      if (dashboard && typeof dashboard === "object") {
        // 字段名映射：AI 常犯的错误
        if (dashboard.title && !dashboard.name) dashboard.name = dashboard.title;
        if (dashboard.sheet_name && !dashboard.source_table) dashboard.source_table = dashboard.sheet_name;
        if (dashboard.filters && !dashboard.ui_filters) dashboard.ui_filters = dashboard.filters;

        // charts 可能是对象数组（AI 常犯错误），需要提取 type 字段转成字符串数组
        if (Array.isArray(dashboard.charts)) {
          const chartArray = dashboard.charts;
          if (chartArray.length > 0 && typeof chartArray[0] === "object" && chartArray[0].type) {
            dashboard.charts = chartArray
              .map((c: any) => c.type)
              .filter((t: string) => ["pie", "bar", "line", "table"].includes(t));
          }
        }

        // 确保 sql_template 至少有值（AI 有时会漏掉）
        if (!dashboard.sql_template) {
          dashboard.sql_template = `SELECT * FROM ${dashboard.source_table || "temp_table"}`;
        }
      }
    }

    return normalized;
  }, []);

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
      if ("actions" in dashboardConfig) payload.actions = JSON.stringify(dashboardConfig.actions || []);
      if ("summary_cards" in dashboardConfig) payload.summaryCards = JSON.stringify(dashboardConfig.summary_cards || []);
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

      const callChat = async (hist: typeof history): Promise<string> => {
        return await invoke<string>("chat_workbench", {
          messages: hist,
          tablePreview: effectivePreview,
          dbTablePreviews: dbTablePreviews.length > 0 ? dbTablePreviews : null,
          chatAttachmentPreviews: allTablePreviews.length > 0 ? allTablePreviews : null,
          thoughtGuideMode,
          modifyingDashboard: !!dashboardTag,
        });
      };

      // 抽出的局部函数：执行一次 AI 调用（含 run_sql 二轮）
      const tryGetDashboard = async (
        hist: typeof history,
        currentMessages: ChatMessage[],
        currentTokenCount: number
      ): Promise<{ res: string; nextMessages: ChatMessage[]; nextTokenCount: number }> => {
        let res = await callChat(hist);
        const firstAction = normalizeActionJson(extractActionJson(res));
        if (firstAction?.action === "run_sql" && firstAction.sql) {
          try {
            const sqlRes = await invoke<{ columns: string[]; rows: string[][] }>("run_sql_query_for_chat", {
              sql: firstAction.sql,
            });
            const sqlResultText = `SQL 查询结果：\n列: ${JSON.stringify(sqlRes.columns)}\n数据: ${JSON.stringify(sqlRes.rows.slice(0, 20))}`;
            const firstAssistantMsg: ChatMessage = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: sanitizeAssistantContent(res.replace(JSON.stringify(firstAction), "").trim()) || res.replace(JSON.stringify(firstAction), "").trim(),
              timestamp: formatBeijingTime(new Date()),
              durationMs: Date.now() - reqStartTime,
            };
            const midMessages = [...currentMessages, firstAssistantMsg];
            setMessages(midMessages);
            const midTokenCount = currentTokenCount + estimateTokens(res);
            setTokenCount(midTokenCount);
            await persistSession(midMessages, midTokenCount);

            let secondHistory: { role: string; content: string }[] = midMessages.map((m) => ({ role: m.role, content: m.content }));
            secondHistory.push({ role: "system", content: sqlResultText });
            if (dashboardContext) {
              secondHistory = [{ role: "system", content: dashboardContext }, ...secondHistory];
            }
            res = await callChat(secondHistory);
            return { res, nextMessages: midMessages, nextTokenCount: midTokenCount };
          } catch (sqlErr) {
            toast.error("AI 自动查库失败: " + String(sqlErr));
          }
        }
        return { res, nextMessages: currentMessages, nextTokenCount: currentTokenCount };
      };

      // 初始调用
      let currentMessages = newMessages;
      let currentTokenCount = newTokenCount;
      let { res, nextMessages, nextTokenCount } = await tryGetDashboard(history, currentMessages, currentTokenCount);
      currentMessages = nextMessages;
      currentTokenCount = nextTokenCount;

      // 兜底重试循环
      const TARGET_ACTIONS = ["create_dashboard", "update_dashboard"];
      const isDashboardAction = (a: any) => a && TARGET_ACTIONS.includes(a.action);
      let retries = 0;
      const MAX_RETRY = 3;
      const userAnswerRounds = currentMessages.filter((m) => m.role === "user").length;

      while (!isDashboardAction(normalizeActionJson(extractActionJson(res)))) {
        const extractedNow = normalizeActionJson(extractActionJson(res));
        // AI 还在合理提问 → break
        if (res.includes("【关键提问】") && userAnswerRounds < 5) break;
        // 合法 ingest 动作 → break
        if (extractedNow && extractedNow.action === "ingest") break;

        retries++;
        if (retries > MAX_RETRY) {
          toast.error(`AI 在 ${MAX_RETRY} 次重试后仍未生成看板，请检查信息是否充分`);
          break;
        }

        setRetryStatus({ active: true, attempt: retries, total: MAX_RETRY });

        // 移除上一轮 escalation，避免堆叠
        if (retries > 1 && (history[history.length - 1] as any)?._isEscalation) {
          history.pop();
        }

        const escalation =
          retries === 1
            ? "请基于以上对话内容，直接输出可执行的 create_dashboard JSON。禁止再使用 run_sql，禁止再提问，信息不足时合理推测填充。JSON 必须严格符合系统提示中的格式要求。特别注意：必须有 dashboard 包装层，字段名必须是 name/sql_template/ui_filters/charts/source_table，严禁使用 title/filters/sheet_name 等字段名。"
            : retries === 2
            ? '【系统强制】你必须立即输出纯文本 JSON，格式如下（严禁 markdown 代码块，禁止任何其它文字）：\n{"action":"create_dashboard","dashboard":{"name":"看板名称","sql_template":"SELECT * FROM 表名","ui_filters":[],"charts":["pie","bar"],"source_table":"表名"}}\n注意：dashboard 对象内字段名必须是 name/sql_template/ui_filters/charts/source_table，charts 必须是字符串数组（如 ["pie","bar"]），严禁使用 title/filters/sheet_name/calculated_fields。'
            : '【最后一次机会】严格输出以下格式，任何偏差都将导致失败：\n{"action":"create_dashboard","dashboard":{"name":"...","description":"...","sql_template":"...","ui_filters":[],"charts":["pie","bar","line","table"],"actions":[],"summary_cards":[],"source_table":"..."}}';

        const escMsg: any = { role: "user", content: escalation, _isEscalation: true };
        history.push(escMsg);
        ({ res, nextMessages, nextTokenCount } = await tryGetDashboard(history, currentMessages, currentTokenCount));
        currentMessages = nextMessages;
        currentTokenCount = nextTokenCount;
      }

      setRetryStatus({ active: false, attempt: 0, total: MAX_RETRY });

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

      const extractedAction = normalizeActionJson(extractActionJson(res));

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
              actions: JSON.stringify(parsedDashboard.actions || []),
              summaryCards: JSON.stringify(parsedDashboard.summary_cards || []),
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
      setRetryStatus({ active: false, attempt: 0, total: 3 });
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

      {/* Retry Status */}
      {retryStatus.active && (
        <div className="px-4 pb-2 max-w-4xl mx-auto w-full">
          <div className="border border-orange-200 bg-orange-50 rounded-lg p-4 flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-orange-600" />
            <span className="text-sm font-medium text-orange-800">
              AI 沉默中，正在第 {retryStatus.attempt}/{retryStatus.total} 次强制重试...
            </span>
          </div>
        </div>
      )}

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

      <DbTableSelectModal
        open={dbSelectOpen}
        onClose={() => setDbSelectOpen(false)}
        onConfirm={(previews) => setDbTablePreviews(previews)}
      />
    </div
    >
  );
}
