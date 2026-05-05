import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export type ViewType = "settings" | "workbench" | "boards" | "database" | "software";

export interface Attachment {
  filename: string;
  mimeType: string;
  data: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  durationMs?: number;
  attachments?: Attachment[];
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  thought_guide_mode: boolean;
  token_count: number;
  dashboard_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Dashboard {
  id: string;
  name: string;
  description?: string;
  sql_template?: string;
  ui_filters?: string;
  charts?: string;
  table_data?: string;
  source_table?: string;
  actions?: string;
  summary_cards?: string;
  html_content?: string;
  source_type?: string;
  dingtalk_doc_url?: string;
  dingtalk_doc_id?: string;
  dingtalk_last_sync?: string;
  dingtalk_operator_id?: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduleConfig {
  time: string;
  days?: number[];
  interval_days?: number;
  date?: string;
}

export interface Schedule {
  id: string;
  dashboard_id: string;
  prompt: string;
  schedule_type: 'once' | 'daily' | 'weekly' | 'monthly' | 'interval';
  schedule_config: string;
  webhook_url: string;
  phone_number: string;
  task_type: 'analysis' | 'sync';
  sync_mode: 'overwrite' | 'append';
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScheduleLog {
  id: number;
  schedule_id: string;
  status: 'success' | 'failed';
  result?: string;
  error?: string;
  created_at: string;
}

export interface NewFileSpec {
  file_path: string;
  target_table_name: string;
}

export interface PendingDashboard {
  id: string;
  name: string;
  html_content: string;
  new_files: NewFileSpec[];
  existing_tables: string[];
  source: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

interface AppState {
  activeView: ViewType;
  sessions: Session[];
  currentSessionId: string | null;
  dashboards: Dashboard[];
  pendingDashboards: PendingDashboard[];
  currentDashboardId: string | null;
  boardsSelectedId: string | null;
  workbenchDashboardTag: string | undefined;
  botStatus: "connected" | "disconnected";
  fontScale: number;
  setFontScale: (scale: number) => void;
  switchView: (view: ViewType) => void;
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionId: (id: string | null) => void;
  setDashboards: (dashboards: Dashboard[]) => void;
  setCurrentDashboardId: (id: string | null) => void;
  setBoardsSelectedId: (id: string | null) => void;
  setWorkbenchDashboardTag: (tag: string | undefined) => void;
  refreshSessions: () => Promise<void>;
  refreshDashboards: () => Promise<void>;
  refreshPendingDashboards: () => Promise<void>;
  refreshBotStatus: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeView, setActiveView] = useState<ViewType>("workbench");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [pendingDashboards, setPendingDashboards] = useState<PendingDashboard[]>([]);
  const [currentDashboardId, setCurrentDashboardId] = useState<string | null>(null);
  const [boardsSelectedId, setBoardsSelectedId] = useState<string | null>(null);
  const [workbenchDashboardTag, setWorkbenchDashboardTag] = useState<string | undefined>(undefined);
  const [botStatus, setBotStatus] = useState<"connected" | "disconnected">("disconnected");
  const [fontScale, setFontScaleState] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("font_scale");
      if (raw) {
        const val = parseFloat(raw);
        if (!isNaN(val) && val >= 0.5 && val <= 5) return Math.round(val * 10) / 10;
      }
    } catch {}
    return 1;
  });

  const refreshSessions = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<Session[]>("get_sessions");
      setSessions(res);
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  }, []);

  const refreshDashboards = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<Dashboard[]>("get_dashboards");
      setDashboards(res);
    } catch (e) {
      console.error("Failed to load dashboards:", e);
    }
  }, []);

  const refreshPendingDashboards = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<PendingDashboard[]>("list_pending_dashboards");
      setPendingDashboards(res);
    } catch (e) {
      console.error("Failed to load pending dashboards:", e);
    }
  }, []);

  const refreshBotStatus = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res: any = await invoke("get_bot_status");
      setBotStatus(res.status === "connected" ? "connected" : "disconnected");
    } catch {
      setBotStatus("disconnected");
    }
  }, []);

  useEffect(() => {
    refreshBotStatus();
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("bot-status-change", (event) => {
        const payload = event.payload as { status: string };
        setBotStatus(payload.status === "connected" ? "connected" : "disconnected");
      });
    };
    setup();
    // 兜底轮询：每 3 秒刷新一次状态，避免事件丢失导致显示不同步
    const interval = setInterval(() => {
      refreshBotStatus();
    }, 3000);
    return () => {
      if (unlisten) unlisten();
      clearInterval(interval);
    };
  }, [refreshBotStatus]);

  const switchView = useCallback((view: ViewType) => {
    setActiveView(view);
  }, []);

  const setFontScale = useCallback((scale: number) => {
    const clamped = Math.max(0.5, Math.min(5, Math.round(scale * 10) / 10));
    setFontScaleState(clamped);
    try {
      localStorage.setItem("font_scale", String(clamped));
    } catch {}
  }, []);

  return (
    <AppContext.Provider
      value={{
        activeView,
        sessions,
        currentSessionId,
        dashboards,
        pendingDashboards,
        currentDashboardId,
        boardsSelectedId,
        workbenchDashboardTag,
        botStatus,
        fontScale,
        setFontScale,
        switchView,
        setSessions,
        setCurrentSessionId,
        setDashboards,
        setCurrentDashboardId,
        setBoardsSelectedId,
        setWorkbenchDashboardTag,
        refreshSessions,
        refreshDashboards,
        refreshPendingDashboards,
        refreshBotStatus,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
