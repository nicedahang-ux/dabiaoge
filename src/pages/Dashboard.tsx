import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactECharts from "echarts-for-react";
import { toPng } from "html-to-image";
import {
  BarChart3,
  PieChart,
  Table2,
  FolderOpen,
  ArrowRight,
  Camera,
  X,
  Save,
  Pencil,
  Database,
  Loader2,
  Plus,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import DashboardCard from "@/components/DashboardCard";
import SqlRepairTracker from "@/components/SqlRepairTracker";
import CreateDashboardModal from "@/components/CreateDashboardModal";
import { useApp, type Dashboard } from "@/lib/AppContext";
import { formatBeijingTime } from "@/lib/utils";
import { estimateTokens } from "@/lib/thoughtGuideQuestions";
import {
  getCached as getCachedHtml,
  setCached as setCachedHtml,
  subscribe as subscribeHtmlCache,
  invalidateBySourceTable,
} from "@/lib/dashboardHtmlCache";

interface ChartData {
  name: string;
  value: number;
}

interface SqlQueryResult {
  columns: string[];
  rows: string[][];
}

function inferChartData(
  data: Record<string, string | number>[],
  columns: string[]
): ChartData[] {
  if (data.length === 0) return [];

  // 模式1：有"款式"列，其他数字列是分类值（旧格式）
  if (data[0].hasOwnProperty("款式")) {
    const firstRow = data[0];
    return Object.entries(firstRow)
      .filter(([key, val]) => key !== "款式" && key !== "总计" && typeof val === "number")
      .map(([key, val]) => ({ name: key, value: val as number }));
  }

  // 模式2：每行是一个数据点（SQL查询结果的常见格式）
  const textCol =
    columns.find((col) => data.some((row) => typeof row[col] === "string" && row[col] !== "")) ||
    columns[0];

  let numCol = columns.find((col) => col !== textCol && typeof data[0][col] === "number");
  if (!numCol) {
    numCol = columns.find((col) => col !== textCol) || columns[1] || columns[0];
  }

  return data.map((row) => ({
    name: String(row[textCol] || "未命名"),
    value: Number(row[numCol]) || 0,
  }));
}

export default function DashboardPage() {
  const {
    dashboards,
    refreshDashboards,
    switchView,
    setCurrentSessionId,
    setCurrentDashboardId,
    setWorkbenchDashboardTag,
    boardsSelectedId,
    setBoardsSelectedId,
  } = useApp();
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [chartData, setChartData] = useState<ChartData[]>([
    { name: "示例A", value: 120 },
    { name: "示例B", value: 200 },
    { name: "示例C", value: 150 },
  ]);
  const [tableData, setTableData] = useState<Record<string, string | number>[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [repairActive, setRepairActive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deletingDashboard, setDeletingDashboard] = useState<Dashboard | null>(null);
  const [deleteMode, setDeleteMode] = useState<"dashboard" | "with_table">("dashboard");
  const [htmlSrcDoc, setHtmlSrcDoc] = useState<string | null>(null);
  const [htmlLoading, setHtmlLoading] = useState(false);
  const [cacheVersion, setCacheVersion] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dashboardDetailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeHtmlCache(() => setCacheVersion((v) => v + 1));
  }, []);

  // 动态调整 iframe 高度，消除滚动条
  const adjustIframeHeight = useCallback(() => {
    const iframe = iframeRef.current;
    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
      const height = iframe.contentDocument.body.scrollHeight;
      iframe.style.height = `${height + 40}px`;
    }
  }, []);

  const selectedDashboard = boardsSelectedId
    ? dashboards.find((d) => d.id === boardsSelectedId) || null
    : null;

  // HTML 看板数据注入：模块级缓存跨页面切换持久；源表数据更新会触发 invalidate 后自动重渲
  useEffect(() => {
    let cancelled = false;
    async function injectHtmlData() {
      if (!selectedDashboard?.html_content) {
        setHtmlSrcDoc(null);
        return;
      }
      const cacheKey = selectedDashboard.id;
      const cached = getCachedHtml(cacheKey);
      if (cached) {
        setHtmlSrcDoc(cached);
        return;
      }
      // 没有 source_table 的看板用静态 html_content 即可，无需拼接数据
      if (!selectedDashboard.source_table) {
        setHtmlSrcDoc(selectedDashboard.html_content);
        setCachedHtml(cacheKey, selectedDashboard.html_content, null);
        return;
      }
      setHtmlLoading(true);
      try {
        const html = await invoke<string>("render_html_dashboard", {
          dashboardId: selectedDashboard.id,
        });
        if (cancelled) return;
        setCachedHtml(cacheKey, html, selectedDashboard.source_table || null);
        setHtmlSrcDoc(html);
      } catch (e) {
        if (cancelled) return;
        console.error("HTML 渲染失败:", e);
        let html = selectedDashboard.html_content;
        const hideCss = `<style>
          .container > .card:first-of-type { display: none !important; }
        </style>`;
        html = html.replace('</head>', hideCss + '</head>');
        setCachedHtml(cacheKey, html, selectedDashboard.source_table || null);
        setHtmlSrcDoc(html);
      } finally {
        if (!cancelled) setHtmlLoading(false);
      }
    }
    injectHtmlData();
    return () => {
      cancelled = true;
    };
  }, [
    selectedDashboard?.id,
    selectedDashboard?.html_content,
    selectedDashboard?.source_table,
    cacheVersion,
  ]);

  useEffect(() => {
    refreshDashboards();
  }, [refreshDashboards]);

  // 初始化筛选器默认值
  useEffect(() => {
    if (!selectedDashboard?.ui_filters) {
      setFilterValues({});
      return;
    }
    try {
      const filters = JSON.parse(selectedDashboard.ui_filters) as { id: string; label: string; type: string; default?: string }[];
      const defaults: Record<string, string> = {};
      filters.forEach((f) => {
        if (f.default) {
          defaults[f.id] = f.default;
        }
      });
      setFilterValues(defaults);
    } catch {
      setFilterValues({});
    }
  }, [selectedDashboard?.id]);

  // 核心修复：当看板有 sql_template 时，实时执行 SQL 查询数据库获取数据
  useEffect(() => {
    async function loadData() {
      if (!selectedDashboard) return;

      // 如果有 sql_template，优先执行SQL获取实时数据
      if (selectedDashboard.sql_template) {
        setDashboardLoading(true);
        try {
          const res = await invoke<SqlQueryResult>("execute_dashboard_sql", {
            sqlTemplate: selectedDashboard.sql_template,
            filterValues: filterValues,
          });

          // 转换为 tableData 格式
          const newTableData = res.rows.map((row) => {
            const obj: Record<string, string | number> = {};
            res.columns.forEach((col, i) => {
              const val = row[i];
              const num = Number(val);
              obj[col] = !isNaN(num) && val !== "" && val !== null ? num : val;
            });
            return obj;
          });

          setTableData(newTableData);

          if (newTableData.length > 0) {
            const generated = inferChartData(newTableData, res.columns);
            if (generated.length > 0) {
              setChartData(generated);
            }
          }
          setDashboardLoading(false);
          return;
        } catch (e) {
          // SQL 执行失败,启动 AI 自动纠错 agent
          console.warn("SQL 执行失败,启动自动纠错:", e);
          setRepairActive(true);
          try {
            const repair = await invoke<{
              query_result: SqlQueryResult | null;
              final_sql: string;
              repaired: boolean;
            }>("execute_dashboard_sql_with_repair", {
              dashboardId: selectedDashboard.id,
              sqlTemplate: selectedDashboard.sql_template,
              filterValues: filterValues,
            });
            if (repair.query_result) {
              const cols = repair.query_result.columns;
              const newTableData = repair.query_result.rows.map((row) => {
                const obj: Record<string, string | number> = {};
                cols.forEach((col, i) => {
                  const val = row[i];
                  const num = Number(val);
                  obj[col] =
                    !isNaN(num) && val !== "" && val !== null ? num : val;
                });
                return obj;
              });
              setTableData(newTableData);
              if (newTableData.length > 0) {
                const generated = inferChartData(newTableData, cols);
                if (generated.length > 0) setChartData(generated);
              }
              if (repair.repaired) {
                toast.success("AI 已自动修正看板 SQL,数据已恢复");
                refreshDashboards();
              }
            } else {
              toast.error("AI 自动纠错失败,正在回退到提问前状态...");
              try {
                await invoke("rollback_dashboard", { id: selectedDashboard.id });
                toast.success("已回退到上一版看板");
                refreshDashboards();
              } catch (rbErr) {
                toast.error("回退失败: " + String(rbErr));
              }
            }
          } catch (repairErr) {
            console.error("自动纠错失败:", repairErr);
            toast.error("看板数据查询失败: " + String(repairErr));
            try {
              await invoke("rollback_dashboard", { id: selectedDashboard.id });
              toast.success("已回退到上一版看板");
              refreshDashboards();
            } catch (rbErr) {
              // ignore rollback error here
            }
          } finally {
            setDashboardLoading(false);
          }
          return;
        }
      }

      // fallback: 从 table_data 解析（兼容旧看板）
      if (selectedDashboard.table_data) {
        try {
          const data = JSON.parse(selectedDashboard.table_data) as Record<string, string | number>[];
          setTableData(data);

          if (data.length > 0) {
            const generated = inferChartData(data, Object.keys(data[0]));
            if (generated.length > 0) {
              setChartData(generated);
            }
            if (data[0]["款式"]) {
              setFilterValues({ style_name: String(data[0]["款式"]) });
            }
          }
        } catch {
          setTableData([]);
        }
      }

      if (selectedDashboard?.charts) {
        try {
          JSON.parse(selectedDashboard.charts) as string[];
        } catch {
          // ignore
        }
      }
    }

    loadData();
  }, [selectedDashboard, filterValues, refreshDashboards]);

  const updateFilter = (id: string, value: string) => {
    setFilterValues((prev) => ({ ...prev, [id]: value }));
  };

  const handleViewDashboard = (dashboard: Dashboard) => {
    setBoardsSelectedId(dashboard.id);
  };

  const handleModifyDashboard = async (dashboard: Dashboard) => {
    try {
      const id = await invoke<string>("create_session", {
        title: `修改看板: ${dashboard.name}`,
        thoughtGuideMode: true,
        dashboardId: dashboard.id,
      });
      setCurrentSessionId(id);
      setCurrentDashboardId(dashboard.id);
      setWorkbenchDashboardTag(dashboard.id);
      switchView("workbench");
      toast.success("已创建修改会话");
    } catch (e) {
      toast.error("创建修改会话失败: " + String(e));
    }
  };

  const handleScreenshot = async () => {
    if (!dashboardDetailRef.current || !selectedDashboard) return;
    try {
      const dataUrl = await toPng(dashboardDetailRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
      });
      if (!dataUrl) {
        toast.error("截图生成失败，未获取到图片数据");
        return;
      }
      const base64 = dataUrl.split(",")[1];
      const id = await invoke<string>("create_session", {
        title: `截图反馈: ${selectedDashboard.name}`,
        thoughtGuideMode: true,
        dashboardId: selectedDashboard.id,
      });
      // 将截图作为用户消息写入会话，让 AI 能看到
      const imageMsg = {
        id: `user-${Date.now()}`,
        role: "user" as const,
        content: `这是我看板「${selectedDashboard.name}」的截图，请帮我分析问题并给出改进建议。`,
        timestamp: formatBeijingTime(new Date()),
        attachments: [
          {
            filename: "screenshot.png",
            mimeType: "image/png",
            data: base64,
          },
        ],
      };
      await invoke("update_session", {
        sessionId: id,
        messages: [imageMsg],
        tokenCount: estimateTokens(imageMsg.content),
      });
      setCurrentSessionId(id);
      setCurrentDashboardId(selectedDashboard.id);
      switchView("workbench");
      toast.success("截图已保存到会话并发送给 AI");
    } catch (e) {
      toast.error("截图失败: " + String(e));
    }
  };

  const handleStartEditName = () => {
    setEditingName(true);
    setEditNameValue(selectedDashboard?.name || "");
  };

  const handleSaveName = async () => {
    if (!selectedDashboard || !editNameValue.trim()) return;
    try {
      await invoke("update_dashboard", {
        id: selectedDashboard.id,
        name: editNameValue.trim(),
      });
      toast.success("看板名称已更新");
      refreshDashboards();
    } catch (e) {
      toast.error("更新失败: " + String(e));
    } finally {
      setEditingName(false);
    }
  };

  const pieOption = {
    title: { text: "销售额分布", left: "center" },
    tooltip: { trigger: "item" },
    series: [
      {
        type: "pie",
        radius: "50%",
        data: chartData,
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
        },
      },
    ],
  };

  const barOption = {
    title: { text: "销售额对比", left: "center" },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: chartData.map((d) => d.name) },
    yAxis: { type: "value" },
    series: [{ data: chartData.map((d) => d.value), type: "bar" }],
  };

  const lineOption = {
    title: { text: "趋势图", left: "center" },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: chartData.map((d) => d.name) },
    yAxis: { type: "value" },
    series: [{ data: chartData.map((d) => d.value), type: "line", smooth: true }],
  };

  interface FilterDef {
    id: string;
    label: string;
    type: string;
    options?: string[];
    default?: string;
    target?: string[];
  }

  let parsedFilters: FilterDef[] = [];
  let parsedCharts: string[] = [];
  let parsedActions: string[] = [];
  let parsedSummaryCards: { title: string; field: string; agg: string }[] = [];
  if (selectedDashboard) {
    try {
      parsedFilters = selectedDashboard.ui_filters
        ? JSON.parse(selectedDashboard.ui_filters)
        : [];
      parsedCharts = selectedDashboard.charts
        ? JSON.parse(selectedDashboard.charts)
        : [];
      parsedActions = selectedDashboard.actions
        ? JSON.parse(selectedDashboard.actions)
        : [];
      parsedSummaryCards = selectedDashboard.summary_cards
        ? JSON.parse(selectedDashboard.summary_cards)
        : [];
    } catch {
      // ignore
    }
  }

  function getFilterOptions(filter: FilterDef): string[] {
    if (filter.options && filter.options.length > 0) return filter.options;
    if (!tableData || tableData.length === 0) return [];
    const values = new Set<string>();
    tableData.forEach((row) => {
      if (row[filter.id] !== undefined) values.add(String(row[filter.id]));
    });
    return Array.from(values);
  }

  function computeAgg(field: string, agg: string): number | string {
    const vals = tableData.map((d) => Number(d[field])).filter((v) => !isNaN(v));
    if (vals.length === 0) return "-";
    switch (agg) {
      case "sum":
        return vals.reduce((a, b) => a + b, 0);
      case "avg":
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      case "count":
        return vals.length;
      case "max":
        return Math.max(...vals);
      case "min":
        return Math.min(...vals);
      default:
        return "-";
    }
  }

  const handleExportCsv = () => {
    if (tableData.length === 0) return;
    const headers = Object.keys(tableData[0]);
    const rows = tableData.map((row) =>
      headers.map((h) => {
        const v = row[h];
        const s = v === null || v === undefined ? "" : String(v);
        if (s.includes(",") || s.includes("\n") || s.includes('"')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      }).join(",")
    );
    const csv = ["﻿" + headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedDashboard?.name || "export"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full overflow-auto"
    >
      <div className="p-6 space-y-6 w-full"
      >
        <div className="flex items-center justify-between"
        >
          <div className="flex items-center gap-2"
          >
            <BarChart3 className="h-6 w-6" />
            <h1 className="text-2xl font-bold">看板列表</h1
            >
          </div
          >
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            创建看板
          </button>
        </div
        >

        {/* Empty State */}
        {dashboards.length === 0 && (
          <Card className="border-dashed"
          >
            <CardContent className="p-8 text-center space-y-4"
            >
              <FolderOpen className="h-12 w-12 mx-auto text-slate-300" />
              <p className="text-slate-500"
              >
                还没有看板，去 AI分析助手 创建你的第一个数据看板吧
              </p
              >
              <button
                onClick={() => switchView("workbench")}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
              >
                前往 AI分析助手
                <ArrowRight className="h-4 w-4" />
              </button
              >
            </CardContent
            >
          </Card>
        )}

        {/* Dashboard Grid */}
        {dashboards.length > 0 && !selectedDashboard && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {dashboards.map((dashboard) => (
              <DashboardCard
                key={dashboard.id}
                dashboard={dashboard}
                onView={handleViewDashboard}
                onModify={handleModifyDashboard}
                onDelete={(d) => {
                  setDeletingDashboard(d);
                  setDeleteMode("dashboard");
                }}
              />
            ))}
          </div
          >
        )}

        {/* Selected Dashboard Detail */}
        {selectedDashboard && (
          <div ref={dashboardDetailRef} className="space-y-6"
          >
            <div className="flex items-center justify-between"
            >
              <div className="flex items-center gap-2"
              >
                <button
                  onClick={() => setBoardsSelectedId(null)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-md text-xs hover:bg-slate-50"
                >
                  <X className="h-3.5 w-3.5" />
                  退出
                </button
                >
                {editingName ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={editNameValue}
                      onChange={(e) => setEditNameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveName();
                        if (e.key === "Escape") setEditingName(false);
                      }}
                      className="text-lg font-semibold border rounded px-2 py-0.5 w-[300px]"
                      autoFocus
                    />
                    <button
                      onClick={handleSaveName}
                      className="inline-flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
                    >
                      <Save className="h-3 w-3" />
                      保存
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">{selectedDashboard.name}</h2>
                    <button
                      onClick={handleStartEditName}
                      className="text-slate-400 hover:text-blue-600"
                      title="修改名称"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {selectedDashboard.source_table && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-600 text-xs">
                    <Database className="h-3 w-3" />
                    关联表: {selectedDashboard.source_table}
                  </span>
                )}
              </div
              >
              <div className="flex items-center gap-2"
              >
                <button
                  onClick={handleScreenshot}
                  className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-md text-xs hover:bg-slate-50"
                >
                  <Camera className="h-3.5 w-3.5" />
                  截图反馈
                </button
                >
                <button
                  onClick={() => handleModifyDashboard(selectedDashboard)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs hover:bg-blue-700"
                >
                  修改看板
                </button
                >
              </div
              >
            </div
            >

            {dashboardLoading && (
              <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 p-3 rounded-md">
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                正在查询看板数据...
              </div>
            )}

            {selectedDashboard.html_content && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">HTML 内容</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="relative" style={{ minHeight: htmlLoading ? 600 : undefined }}>
                    {htmlLoading && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/85 backdrop-blur-[2px] rounded-md">
                        <Loader2 className="h-10 w-10 animate-spin text-blue-500" />
                        <p className="text-base font-medium text-slate-700">看板正在加载中，请稍候…</p>
                        <p className="text-xs text-slate-500">首次加载会执行 SQL 拼装数据，约需 2–10 秒</p>
                      </div>
                    )}
                    <iframe
                      ref={iframeRef}
                      srcDoc={htmlSrcDoc ?? selectedDashboard.html_content}
                      style={{
                        width: "100%",
                        border: "none",
                        opacity: htmlLoading ? 0.2 : 1,
                        transition: "opacity 200ms",
                      }}
                      sandbox="allow-scripts allow-same-origin"
                      title="看板 HTML 内容"
                      onLoad={() => {
                        adjustIframeHeight();
                        // echarts 等异步内容渲染后再调整一次
                        setTimeout(adjustIframeHeight, 500);
                        setTimeout(adjustIframeHeight, 1500);
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            <SqlRepairTracker
              isActive={repairActive}
              onReset={() => setRepairActive(false)}
            />

            {parsedSummaryCards.length > 0 && !selectedDashboard.html_content && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {parsedSummaryCards.map((card, idx) => (
                  <Card key={idx}>
                    <CardContent className="p-4">
                      <p className="text-xs text-slate-500">{card.title}</p>
                      <p className="text-xl font-semibold text-slate-800">
                        {computeAgg(card.field, card.agg)}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {parsedFilters.length > 0 && !selectedDashboard.html_content && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">动态筛选</CardTitle>
                    {parsedActions.includes("export_csv") && (
                      <button
                        onClick={handleExportCsv}
                        className="inline-flex items-center gap-1 px-2 py-1 border rounded-md text-xs hover:bg-slate-50"
                      >
                        <Download className="h-3 w-3" /> 导出 CSV
                      </button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-4">
                  {parsedFilters.map((f) => (
                    <div key={f.id} className="flex flex-col gap-1 min-w-[200px]">
                      <label className="text-sm font-medium">{f.label}</label>
                      {f.type === "select" ? (
                        <Select
                          value={filterValues[f.id] || ""}
                          onValueChange={(v) => updateFilter(f.id, v || "")}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                          <SelectContent>
                            {getFilterOptions(f).map((opt) => (
                              <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : f.type === "multi_select" ? (
                        <div className="flex flex-wrap gap-2">
                          {getFilterOptions(f).map((opt) => {
                            const current = filterValues[f.id] || "";
                            const selected = current.split(",").filter(Boolean);
                            const checked = selected.includes(opt);
                            return (
                              <label key={opt} className="inline-flex items-center gap-1 text-xs cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    const vals = e.target.checked
                                      ? [...selected, opt]
                                      : selected.filter((s) => s !== opt);
                                    updateFilter(f.id, vals.join(","));
                                  }}
                                  className="accent-blue-600"
                                />
                                <span>{opt}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : f.type === "date_range" ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="date"
                            value={filterValues[`${f.id}_start`] || ""}
                            onChange={(e) => updateFilter(`${f.id}_start`, e.target.value)}
                            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <span className="text-xs text-slate-400">至</span>
                          <input
                            type="date"
                            value={filterValues[`${f.id}_end`] || ""}
                            onChange={(e) => updateFilter(`${f.id}_end`, e.target.value)}
                            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                          />
                        </div>
                      ) : (
                        <input
                          placeholder={`输入${f.label}`}
                          value={filterValues[f.id] || ""}
                          onChange={(e) => updateFilter(f.id, e.target.value)}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {!selectedDashboard.html_content && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6"
            >
              {parsedCharts.includes("pie") && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm"
                    >
                      <PieChart className="h-4 w-4" /> 饼图
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ReactECharts option={pieOption} style={{ height: 300 }} />
                  </CardContent>
                </Card>
              )}
              {parsedCharts.includes("bar") && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm"
                    >
                      <BarChart3 className="h-4 w-4" /> 柱状图
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ReactECharts option={barOption} style={{ height: 300 }} />
                  </CardContent>
                </Card>
              )}
              {parsedCharts.includes("line") && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm"
                    >
                      <BarChart3 className="h-4 w-4" /> 折线图
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ReactECharts option={lineOption} style={{ height: 300 }} />
                  </CardContent>
                </Card>
              )}
            </div
            >
            )}

            {parsedCharts.includes("table") && tableData.length > 0 && !selectedDashboard.html_content && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm"
                  >
                    <Table2 className="h-4 w-4" /> 明细数据
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {Object.keys(tableData[0]).map((k) => (
                          <TableHead key={k}>{k}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableData.map((row, i) => (
                        <TableRow key={i}>
                          {Object.values(row).map((v, j) => (
                            <TableCell key={j}>{v}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        )}

      </div>

      <CreateDashboardModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          setBoardsSelectedId(id);
          refreshDashboards();
        }}
      />

      {/* 删除看板确认弹窗 */}
      <Dialog open={!!deletingDashboard} onOpenChange={(open) => !open && setDeletingDashboard(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              确认删除看板"{deletingDashboard?.name}"
            </DialogTitle>
            <DialogDescription>
              此操作不可恢复。请选择删除方式：
            </DialogDescription>
          </DialogHeader>

          {(() => {
            if (!deletingDashboard) return null;
            const linkedTable = deletingDashboard.source_table || "";
            const otherDashboardsUsingTable = dashboards.filter(
              (d) =>
                d.id !== deletingDashboard.id &&
                ((d.source_table && d.source_table === linkedTable) ||
                  (d.sql_template && d.sql_template.includes(linkedTable)))
            );
            const canDropTable = !!linkedTable && otherDashboardsUsingTable.length === 0;

            return (
              <div className="space-y-3 py-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="delete-mode"
                    className="mt-1 accent-blue-600"
                    checked={deleteMode === "dashboard"}
                    onChange={() => setDeleteMode("dashboard")}
                  />
                  <div className="text-sm">
                    <p className="font-medium">仅删除看板</p>
                    <p className="text-xs text-slate-500">看板配置被移除，数据库表不受影响</p>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-2 ${canDropTable ? "cursor-pointer" : "opacity-50 cursor-not-allowed"}`}
                >
                  <input
                    type="radio"
                    name="delete-mode"
                    className="mt-1 accent-red-600"
                    disabled={!canDropTable}
                    checked={deleteMode === "with_table"}
                    onChange={() => canDropTable && setDeleteMode("with_table")}
                  />
                  <div className="text-sm">
                    <p className="font-medium">同时删除底层数据表{linkedTable ? `（${linkedTable}）` : ""}</p>
                    <p className="text-xs text-slate-500">
                      {canDropTable
                        ? "看板和对应的数据库表将一起被永久删除"
                        : !linkedTable
                        ? "该看板未关联任何数据库表"
                        : `此表还被 ${otherDashboardsUsingTable.length} 个看板引用，先删除它们才能删除此表`}
                    </p>
                  </div>
                </label>
              </div>
            );
          })()}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeletingDashboard(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deletingDashboard) return;
                try {
                  await invoke("delete_dashboard", { id: deletingDashboard.id });
                  if (deleteMode === "with_table" && deletingDashboard.source_table) {
                    await invoke("drop_user_table", {
                      tableName: deletingDashboard.source_table,
                    });
                    invalidateBySourceTable(deletingDashboard.source_table);
                  }
                  toast.success("看板已删除");
                  setDeletingDashboard(null);
                  setBoardsSelectedId(null);
                  refreshDashboards();
                } catch (e) {
                  toast.error("删除失败: " + String(e));
                }
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
