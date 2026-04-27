import { useState, useEffect } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import {
  Settings,
  FileSpreadsheet,
  Bot,
  Share2,
  Copy,
  Check,
  Database,
  Info,
} from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import { AppProvider, useApp } from "@/lib/AppContext";
import { invalidateBySourceTable } from "@/lib/dashboardHtmlCache";
import SettingsPage from "./pages/Settings";
import WorkbenchPage from "./pages/Workbench";
import DashboardPage from "./pages/Dashboard";
import SharePage from "./pages/SharePage";
import DatabaseView from "./components/DatabaseView";
import SoftwareInfo from "./pages/SoftwareInfo";

function ShareButton() {
  const { boardsSelectedId } = useApp();
  const [shareInfo, setShareInfo] = useState<{
    url: string;
    pin: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // 组件挂载时查询当前分享状态
  useEffect(() => {
    async function checkStatus() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const status = await invoke<{
          board_id: string;
          url: string;
          pin: string;
        } | null>("get_share_status");
        if (status && status.board_id === boardsSelectedId) {
          setShareInfo({ url: status.url, pin: status.pin });
        } else {
          setShareInfo(null);
        }
      } catch {
        // 静默失败
      }
    }
    checkStatus();
  }, [boardsSelectedId]);

  const handleShare = async () => {
    if (!boardsSelectedId) {
      toast.error("请先选择一个看板");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<{ url: string; pin: string }>(
        "start_share_server",
        {
          boardId: boardsSelectedId,
          allowRefresh: false,
        }
      );
      setShareInfo(info);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleStopShare = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("stop_share_server");
      setShareInfo(null);
      toast.success("分享已停止");
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Popover>
      <PopoverTrigger>
        <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer">
          <Share2 className="h-4 w-4" /> 分享看板
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3">
        <div className="space-y-2">
          <p className="text-sm font-medium">局域网分享</p>
          {!shareInfo ? (
            <Button className="w-full" onClick={handleShare}>
              开启分享
            </Button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 bg-slate-50 p-2 rounded text-xs break-all">
                {shareInfo.url}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">
                  提取码: <strong>{shareInfo.pin}</strong>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(shareInfo.url);
                    setCopied(true);
                    toast.success("复制成功");
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full text-red-500 hover:text-red-600 hover:bg-red-50"
                onClick={handleStopShare}
              >
                停止分享
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MainLayout() {
  const { activeView, switchView, botStatus, fontScale } = useApp();
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const raw = localStorage.getItem("main_sidebar_width");
      return raw ? Math.max(180, Math.min(500, parseInt(raw, 10))) : 240;
    } catch {
      return 240;
    }
  });

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let currentWidth = startWidth;

    const onMove = (e: MouseEvent) => {
      currentWidth = Math.max(180, Math.min(500, startWidth + e.clientX - startX));
      setSidebarWidth(currentWidth);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("main_sidebar_width", String(currentWidth));
      } catch {}
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontScale * 100}%`;
  }, [fontScale]);

  useEffect(() => {
    async function autoStartBot() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const config = await invoke<{ ding_app_key?: string; ding_app_secret?: string }>("load_config");
        if (config.ding_app_key && config.ding_app_secret) {
          await invoke("start_bot");
        }
      } catch {
        // 静默失败，不打扰用户
      }
    }
    autoStartBot();
  }, []);

  // 轮询检测外部Python入库后的刷新信号
  useEffect(() => {
    let cancelled = false;

    async function pollRefreshSignals() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const tableNames = await invoke<string[]>("check_refresh_signals");
        if (cancelled) return;

        if (tableNames.length > 0) {
          for (const tableName of tableNames) {
            invalidateBySourceTable(tableName);
          }
          toast.info(`检测到外部数据更新，已自动刷新 ${tableNames.length} 个关联看板`);
        }
      } catch {
        // 静默失败，避免轮询报错打扰用户
      }
    }

    pollRefreshSignals();
    const interval = setInterval(pollRefreshSignals, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white">
      <aside className="flex-shrink-0 bg-slate-50 border-r border-slate-200 flex flex-col relative" style={{ width: sidebarWidth }}>
        <div className="p-4 border-b border-slate-200">
          <div className="flex items-center gap-2 font-semibold text-slate-800">
            <Bot className="h-5 w-5 text-blue-600" />
            AI表格转看板
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {[
            { id: "settings" as const, label: "系统配置", icon: Settings },
            { id: "workbench" as const, label: "AI分析助手", icon: Bot },
            { id: "boards" as const, label: "看板列表", icon: FileSpreadsheet },
            { id: "database" as const, label: "数据库", icon: Database },
            { id: "software" as const, label: "软件信息", icon: Info },
          ].map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => switchView(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-50 text-blue-700"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="p-4 border-t border-slate-200 space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <div className={`h-2 w-2 rounded-full ${botStatus === "connected" ? "bg-green-500" : "bg-red-500"}`} />
            {botStatus === "connected" ? "钉钉服务监听中..." : "钉钉服务未连接"}
          </div>
        </div>
        {/* 拖拽调整宽度 */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400 active:bg-blue-600 transition-colors z-10"
          onMouseDown={handleResizeStart}
          title="拖拽调整宽度"
        />
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        <div className="flex justify-end p-4 flex-shrink-0">
          {activeView === "boards" && <ShareButton />}
        </div>
        <div className={`flex-1 overflow-hidden flex flex-col ${activeView !== "settings" ? "hidden" : ""}`}>
          <SettingsPage />
        </div>
        <div className={`flex-1 overflow-hidden flex flex-col ${activeView !== "workbench" ? "hidden" : ""}`}>
          <WorkbenchPage />
        </div>
        <div className={`flex-1 overflow-hidden flex flex-col ${activeView !== "boards" ? "hidden" : ""}`}>
          <DashboardPage />
        </div>
        <div className={`flex-1 overflow-hidden flex flex-col ${activeView !== "database" ? "hidden" : ""}`}>
          <DatabaseView />
        </div>
        <div className={`flex-1 overflow-hidden flex flex-col ${activeView !== "software" ? "hidden" : ""}`}>
          <SoftwareInfo />
        </div>
      </main>
      <Toaster position="top-right" richColors />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<MainLayout />} />
          <Route path="/share/:id" element={<SharePage />} />
        </Routes>
      </HashRouter>
    </AppProvider>
  );
}

export default App;
