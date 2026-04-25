import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type ViewType = "settings" | "workbench" | "boards" | "database";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  durationMs?: number;
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
  created_at: string;
  updated_at: string;
}

interface AppState {
  activeView: ViewType;
  sessions: Session[];
  currentSessionId: string | null;
  dashboards: Dashboard[];
  currentDashboardId: string | null;
  boardsSelectedId: string | null;
  workbenchDashboardTag: string | undefined;
  switchView: (view: ViewType) => void;
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionId: (id: string | null) => void;
  setDashboards: (dashboards: Dashboard[]) => void;
  setCurrentDashboardId: (id: string | null) => void;
  setBoardsSelectedId: (id: string | null) => void;
  setWorkbenchDashboardTag: (tag: string | undefined) => void;
  refreshSessions: () => Promise<void>;
  refreshDashboards: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeView, setActiveView] = useState<ViewType>("workbench");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [currentDashboardId, setCurrentDashboardId] = useState<string | null>(null);
  const [boardsSelectedId, setBoardsSelectedId] = useState<string | null>(null);
  const [workbenchDashboardTag, setWorkbenchDashboardTag] = useState<string | undefined>(undefined);

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

  const switchView = useCallback((view: ViewType) => {
    setActiveView(view);
  }, []);

  return (
    <AppContext.Provider
      value={{
        activeView,
        sessions,
        currentSessionId,
        dashboards,
        currentDashboardId,
        boardsSelectedId,
        workbenchDashboardTag,
        switchView,
        setSessions,
        setCurrentSessionId,
        setDashboards,
        setCurrentDashboardId,
        setBoardsSelectedId,
        setWorkbenchDashboardTag,
        refreshSessions,
        refreshDashboards,
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
