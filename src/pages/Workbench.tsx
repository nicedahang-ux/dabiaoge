import { Bot } from "lucide-react";
import AIChat from "@/components/AIChat";
import SessionSidebar from "@/components/SessionSidebar";
import { useApp } from "@/lib/AppContext";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";

export default function Workbench() {
  const {
    currentSessionId,
    setCurrentSessionId,
    setCurrentDashboardId,
    workbenchDashboardTag,
    setWorkbenchDashboardTag,
  } = useApp();

  const handleNewSession = async () => {
    try {
      const id = await invoke<string>("create_session", {
        title: "新对话",
        thoughtGuideMode: true,
        dashboardId: workbenchDashboardTag || null,
      });
      setCurrentSessionId(id);
      setWorkbenchDashboardTag(undefined);
    } catch (e) {
      toast.error("创建会话失败: " + String(e));
    }
  };

  const handleSelectSession = (id: string) => {
    setCurrentSessionId(id);
  };

  const handleClearDashboardTag = () => {
    setWorkbenchDashboardTag(undefined);
    setCurrentDashboardId(null);
  };

  return (
    <div className="flex h-full"
    >
      <SessionSidebar
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
      />
      <div className="flex-1 flex flex-col h-full overflow-hidden"
      >
        <div className="px-6 pt-4 pb-2 flex-shrink-0 flex items-center gap-2"
        >
          <Bot className="h-6 w-6 text-blue-600" />
          <h1 className="text-xl font-bold">AI分析助手</h1
          >
        </div
        >
        <AIChat
          sessionId={currentSessionId}
          onSessionChange={setCurrentSessionId}
          dashboardTag={workbenchDashboardTag}
          onClearDashboardTag={handleClearDashboardTag}
        />
      </div
      >
    </div
    >
  );
}
