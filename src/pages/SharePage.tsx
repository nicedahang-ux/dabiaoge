import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck, Loader2, BarChart3, PieChart, Table2, RefreshCw } from "lucide-react";
import ReactECharts from "echarts-for-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface BoardData {
  board_id: string;
  data: {
    id: string;
    name: string;
    description?: string;
    sql_template?: string;
    ui_filters?: string;
    charts?: string;
    table_data?: string;
    html_content?: string;
  };
  allow_refresh: boolean;
}

const tokenKey = (boardId: string | undefined) => `share_token_${boardId ?? ""}`;

export default function SharePage() {
  const { id } = useParams();
  const [pin, setPin] = useState("");
  const [token, setToken] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(tokenKey(id)) || "";
  });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [boardData, setBoardData] = useState<BoardData | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const clearToken = () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem(tokenKey(id));
    }
    setToken("");
    setBoardData(null);
  };

  const verify = async () => {
    if (pin.length !== 4) {
      toast.error("请输入 4 位提取码");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/verify_pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const json = await res.json();
      if (json.token) {
        localStorage.setItem(tokenKey(id), json.token);
        setToken(json.token);
        toast.success("验证通过");
      } else {
        toast.error("提取码不正确");
      }
    } catch (e) {
      toast.error("网络错误");
    } finally {
      setLoading(false);
    }
  };

  const fetchBoardData = async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/board_data", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        // token 失效（服务端重启或被清除），回退到输入提取码界面
        clearToken();
        toast.info("登录已过期，请重新输入提取码");
        return;
      }
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        setBoardData(data);
      }
    } catch {
      toast.error("获取数据失败");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    fetchBoardData();
  }, [token]);

  // 自动刷新
  useEffect(() => {
    if (!token || !boardData?.allow_refresh) return;
    const interval = setInterval(fetchBoardData, 30000);
    return () => clearInterval(interval);
  }, [token, boardData?.allow_refresh]);

  if (!token) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <Card className="w-[360px]">
          <CardHeader className="text-center">
            <CardTitle className="flex items-center justify-center gap-2">
              <ShieldCheck className="h-5 w-5 text-blue-600" />
              访问看板
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-500 text-center">
              看板 ID: {id}
            </p>
            <div className="flex justify-center gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Input
                  key={i}
                  maxLength={1}
                  className="w-12 h-12 text-center text-xl font-bold"
                  value={pin[i] || ""}
                  onChange={(e) => {
                    const val = e.target.value.slice(-1);
                    const newPin = pin.split("");
                    newPin[i] = val;
                    setPin(newPin.join(""));
                    if (val && i < 3) {
                      const next = e.target.parentElement?.querySelectorAll("input")[i + 1] as HTMLInputElement;
                      next?.focus();
                    }
                  }}
                />
              ))}
            </div>
            <button className="w-full bg-blue-600 text-white rounded-md py-2 text-sm hover:bg-blue-700 disabled:opacity-50" onClick={verify} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin inline" />}
              确认
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!boardData) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const dashboard = boardData.data;
  let parsedFilters: { id: string; label: string; type: string }[] = [];
  let parsedCharts: string[] = [];
  let tableData: Record<string, string | number>[] = [];

  try {
    parsedFilters = dashboard.ui_filters ? JSON.parse(dashboard.ui_filters) : [];
    parsedCharts = dashboard.charts ? JSON.parse(dashboard.charts) : [];
    tableData = dashboard.table_data ? JSON.parse(dashboard.table_data) : [];
  } catch {
    // ignore
  }

  const chartData = tableData.length > 0
    ? (() => {
        const firstRow = tableData[0];
        const generated: { name: string; value: number }[] = [];
        for (const [key, val] of Object.entries(firstRow)) {
          if (key !== "款式" && key !== "总计" && typeof val === "number") {
            generated.push({ name: key, value: val });
          }
        }
        return generated.length > 0 ? generated : [{ name: "示例", value: 0 }];
      })()
    : [{ name: "示例A", value: 120 }, { name: "示例B", value: 200 }];

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

  return (
    <div className="min-h-screen bg-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between pb-4 border-b">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-blue-600" />
            <h1 className="text-2xl font-bold">{dashboard.name || "共享看板"}</h1>
          </div>
          {boardData?.allow_refresh && (
            <button
              onClick={fetchBoardData}
              disabled={refreshing}
              className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-md text-xs hover:bg-slate-50 disabled:opacity-50"
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              刷新数据
            </button>
          )}
        </div>

        {dashboard.description && (
          <p className="text-sm text-slate-500">{dashboard.description}</p>
        )}

        {dashboard.html_content && (
          <Card>
            <CardContent className="p-0">
              <iframe
                ref={iframeRef}
                srcDoc={dashboard.html_content}
                title={dashboard.name || "看板"}
                sandbox="allow-scripts allow-same-origin"
                className="w-full border-0"
                style={{ minHeight: 600 }}
                onLoad={() => {
                  const iframe = iframeRef.current;
                  if (iframe?.contentDocument?.body) {
                    iframe.style.height = `${iframe.contentDocument.body.scrollHeight + 40}px`;
                  }
                }}
              />
            </CardContent>
          </Card>
        )}

        {!dashboard.html_content && parsedFilters.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">动态筛选</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-4">
              {parsedFilters.map((f) => (
                <div key={f.id} className="flex flex-col gap-1 min-w-[200px]">
                  <label className="text-sm font-medium">{f.label}</label>
                  <Input placeholder={`输入${f.label}`} disabled />
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {!dashboard.html_content && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {parsedCharts.includes("pie") && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
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
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <BarChart3 className="h-4 w-4" /> 柱状图
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ReactECharts option={barOption} style={{ height: 300 }} />
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {!dashboard.html_content && parsedCharts.includes("table") && tableData.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
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
    </div>
  );
}
