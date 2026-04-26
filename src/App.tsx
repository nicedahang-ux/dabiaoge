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
import SettingsPage from "./pages/Settings";
import WorkbenchPage from "./pages/Workbench";
import DashboardPage from "./pages/Dashboard";
import SharePage from "./pages/SharePage";
import DatabaseView from "./components/DatabaseView";

function ShareButton() {
  const { boardsSelectedId } = useApp();
  const [shareInfo, setShareInfo] = useState<{
    url: string;
    pin: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

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
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MainLayout() {
  const { activeView, switchView, botStatus } = useApp();

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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white">
      <aside className="w-[240px] flex-shrink-0 bg-slate-50 border-r border-slate-200 flex flex-col">
        <div className="p-4 border-b border-slate-200">
          <div className="flex items-center gap-2 font-semibold text-slate-800">
            <Bot className="h-5 w-5 text-blue-600" />
            AI 数据看板
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {[
            { id: "settings" as const, label: "系统配置", icon: Settings },
            { id: "workbench" as const, label: "AI分析助手", icon: Bot },
            { id: "boards" as const, label: "看板列表", icon: FileSpreadsheet },
            { id: "database" as const, label: "数据库", icon: Database },
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
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        <div className="flex justify-end p-4 flex-shrink-0">
          {activeView === "boards" && <ShareButton />}
        </div>
        {activeView === "settings" && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <SettingsPage />
          </div>
        )}
        {activeView === "workbench" && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <WorkbenchPage />
          </div>
        )}
        {activeView === "boards" && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <DashboardPage />
          </div>
        )}
        {activeView === "database" && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <DatabaseView />
          </div>
        )}
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
