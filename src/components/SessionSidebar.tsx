import { useEffect, useState } from "react";
import { Plus, MessageSquare, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApp } from "@/lib/AppContext";
import { toast } from "sonner";

interface SessionSidebarProps {
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
}

export default function SessionSidebar({
  onNewSession,
  onSelectSession,
}: SessionSidebarProps) {
  const { sessions, currentSessionId, refreshSessions } = useApp();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_session", { sessionId: deleteTarget });
      toast.success("会话已删除");
      refreshSessions();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="w-[220px] border-r bg-slate-50 flex flex-col h-full">
      <div className="p-3 border-b flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">会话历史</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={onNewSession}
        >
          <Plus className="h-3.5 w-3.5" />
          新建对话
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {sessions.length === 0 && (
            <div className="text-xs text-slate-400 text-center py-8">
              暂无会话
              <br />
              点击上方新建对话
            </div>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors group text-left ${
                currentSessionId === session.id
                  ? "bg-blue-100 text-blue-700"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="truncate text-xs font-medium">
                  {session.title}
                </div>
                <div className="text-[10px] text-slate-400 truncate">
                  {session.messages.length} 条消息 ·
                  {session.token_count.toLocaleString()} tokens
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(session.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </button>
          ))}
        </div>
      </ScrollArea>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              确认删除
            </DialogTitle>
            <DialogDescription>
              删除后无法恢复，确定要删除该会话吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={handleDelete}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
