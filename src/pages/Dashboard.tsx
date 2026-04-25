import { useEffect, useState, useRef } from "react";
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
import DashboardCard from "@/components/DashboardCard";
import SqlRepairTracker from "@/components/SqlRepairTracker";
import CreateDashboardModal from "@/components/CreateDashboardModal";
import { useApp, type Dashboard } from "@/lib/AppContext";

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
  const dashboardDetailRef = useRef<HTMLDivElement>(null);

  const selectedDashboard = boardsSelectedId
    ? dashboards.find((d) => d.id === boardsSelectedId) || null
    : null;

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
              toast.error("AI 自动纠错失败,请检查 SQL");
            }
          } catch (repairErr) {
            console.error("自动纠错失败:", repairErr);
            toast.error("看板数据查询失败: " + String(repairErr));
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
      await toPng(dashboardDetailRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
      });
      const id = await invoke<string>("create_session", {
        title: `截图反馈: ${selectedDashboard.name}`,
        thoughtGuideMode: true,
        dashboardId: selectedDashboard.id,
      });
      setCurrentSessionId(id);
      setCurrentDashboardId(selectedDashboard.id);
      switchView("workbench");
      toast.success("截图已保存到会话");
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

  let parsedFilters: { id: string; label: string; type: string }[] = [];
  let parsedCharts: string[] = [];
  if (selectedDashboard) {
    try {
      parsedFilters = selectedDashboard.ui_filters
        ? JSON.parse(selectedDashboard.ui_filters)
        : [];
      parsedCharts = selectedDashboard.charts
        ? JSON.parse(selectedDashboard.charts)
        : [];
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex flex-col h-full overflow-auto"
    >
      <div className="p-6 space-y-6 max-w-7xl mx-auto w-full"
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

            <SqlRepairTracker
              isActive={repairActive}
              onReset={() => setRepairActive(false)}
            />

            {parsedFilters.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm"
                  >动态筛选</CardTitle
                  >
                </CardHeader>
                <CardContent className="flex flex-wrap gap-4"
                >
                  {parsedFilters.map((f) => (
                    <div key={f.id} className="flex flex-col gap-1 min-w-[200px]"
                    >
                      <label className="text-sm font-medium"
                      >{f.label}</label
                      >
                      {f.type === "select" ? (
                        <Select
                          value={filterValues[f.id] || ""}
                          onValueChange={(v) => updateFilter(f.id, v || "")}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="option1"
                            >选项一</SelectItem
                            >
                            <SelectItem value="option2"
                            >选项二</SelectItem
                            >
                          </SelectContent>
                        </Select>
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
            </div
            >

            {parsedCharts.includes("table") && tableData.length > 0 && (
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
    </div>
  );
}
