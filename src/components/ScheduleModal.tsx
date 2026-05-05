import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import type { Dashboard, Schedule, ScheduleLog } from "@/lib/AppContext";
import { Clock, Send, Loader2, CheckCircle2, XCircle } from "lucide-react";

interface ScheduleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboard: Dashboard | null;
}

interface FormConfig {
  id: string;
  prompt: string;
  scheduleType: string;
  time: string;
  selectedDays: number[];
  intervalDays: number;
  onceDate: string;
  webhookUrl: string;
  phoneNumber: string;
  enabled: boolean;
  syncMode: "overwrite" | "append";
}

const WEEKDAYS = [
  { label: "一", value: 1 },
  { label: "二", value: 2 },
  { label: "三", value: 3 },
  { label: "四", value: 4 },
  { label: "五", value: 5 },
  { label: "六", value: 6 },
  { label: "日", value: 7 },
];

function scheduleToConfig(s: Schedule): FormConfig {
  let cfg: any = {};
  try {
    cfg = JSON.parse(s.schedule_config || "{}");
  } catch {
    cfg = {};
  }
  return {
    id: s.id,
    prompt: s.prompt,
    scheduleType: s.schedule_type,
    time: cfg.time || "09:00",
    selectedDays: cfg.days || [],
    intervalDays: cfg.interval_days || 1,
    onceDate: cfg.date || "",
    webhookUrl: s.webhook_url,
    phoneNumber: s.phone_number || "",
    enabled: s.enabled,
    syncMode: (s.sync_mode as "overwrite" | "append") || "overwrite",
  };
}

export default function ScheduleModal({
  open,
  onOpenChange,
  dashboard,
}: ScheduleModalProps) {
  const [logs, setLogs] = useState<ScheduleLog[]>([]);
  const [testing, setTesting] = useState(false);
  const [testingPrivate, setTestingPrivate] = useState(false);
  const [saving, setSaving] = useState(false);

  const [activeType, setActiveType] = useState<"analysis" | "sync">("analysis");

  const [configs, setConfigs] = useState<{
    analysis: FormConfig;
    sync: FormConfig;
  }>({
    analysis: {
      id: "",
      prompt: "",
      scheduleType: "daily",
      time: "09:00",
      selectedDays: [],
      intervalDays: 1,
      onceDate: "",
      webhookUrl: "",
      phoneNumber: "",
      enabled: true,
      syncMode: "overwrite",
    },
    sync: {
      id: "",
      prompt: "",
      scheduleType: "daily",
      time: "07:00",
      selectedDays: [],
      intervalDays: 1,
      onceDate: "",
      webhookUrl: "",
      phoneNumber: "",
      enabled: true,
      syncMode: "overwrite",
    },
  });

  const current = configs[activeType];

  const updateCurrent = useCallback(
    (updates: Partial<FormConfig>) => {
      setConfigs((prev) => ({
        ...prev,
        [activeType]: { ...prev[activeType], ...updates },
      }));
    },
    [activeType]
  );

  const resetAll = useCallback(() => {
    setConfigs({
      analysis: {
        id: "",
        prompt: "",
        scheduleType: "daily",
        time: "09:00",
        selectedDays: [],
        intervalDays: 1,
        onceDate: "",
        webhookUrl: "",
        phoneNumber: "",
        enabled: true,
        syncMode: "overwrite",
      },
      sync: {
        id: "",
        prompt: "",
        scheduleType: "daily",
        time: "07:00",
        selectedDays: [],
        intervalDays: 1,
        onceDate: "",
        webhookUrl: "",
        phoneNumber: "",
        enabled: true,
        syncMode: "overwrite",
      },
    });
    setActiveType("analysis");
    setLogs([]);
  }, []);

  const loadSchedules = useCallback(async () => {
    if (!dashboard) return;
    try {
      const res = await invoke<Schedule[]>("get_schedules", {
        dashboardId: dashboard.id,
      });

      const analysisSched = res.find((s) => s.task_type === "analysis");
      const syncSched = res.find((s) => s.task_type === "sync");

      setConfigs({
        analysis: analysisSched
          ? scheduleToConfig(analysisSched)
          : {
              id: "",
              prompt: "",
              scheduleType: "daily",
              time: "09:00",
              selectedDays: [],
              intervalDays: 1,
              onceDate: "",
              webhookUrl: "",
              phoneNumber: "",
              enabled: true,
              syncMode: "overwrite",
            },
        sync: syncSched
          ? scheduleToConfig(syncSched)
          : {
              id: "",
              prompt: "",
              scheduleType: "daily",
              time: "07:00",
              selectedDays: [],
              intervalDays: 1,
              onceDate: "",
              webhookUrl: "",
              phoneNumber: "",
              enabled: true,
              syncMode: "overwrite",
            },
      });

      // 加载两种任务的日志并合并
      const logPromises = res.map((s) =>
        invoke<ScheduleLog[]>("get_schedule_logs", {
          scheduleId: s.id,
          limit: 5,
        })
      );
      const allLogs = (await Promise.all(logPromises)).flat();
      allLogs.sort(
        (a, b) =>
          new Date(b.created_at).getTime() -
          new Date(a.created_at).getTime()
      );
      setLogs(allLogs.slice(0, 10));
    } catch (e) {
      console.error("Failed to load schedules:", e);
    }
  }, [dashboard]);

  useEffect(() => {
    if (open && dashboard) {
      loadSchedules();
    }
  }, [open, dashboard, loadSchedules]);

  useEffect(() => {
    if (!open) {
      resetAll();
    }
  }, [open, resetAll]);

  const handleSave = async () => {
    if (!dashboard) return;
    const cfg = current;
    const scheduleConfig = {
      time: cfg.time,
      days:
        cfg.scheduleType === "weekly" || cfg.scheduleType === "monthly"
          ? cfg.selectedDays
          : undefined,
      interval_days:
        cfg.scheduleType === "interval" ? cfg.intervalDays : undefined,
      date: cfg.scheduleType === "once" ? cfg.onceDate : undefined,
    };

    setSaving(true);
    try {
      if (cfg.id) {
        await invoke("update_schedule", {
          id: cfg.id,
          prompt: cfg.prompt,
          scheduleType: cfg.scheduleType,
          scheduleConfig: JSON.stringify(scheduleConfig),
          webhookUrl: cfg.webhookUrl,
          phoneNumber: cfg.phoneNumber,
          enabled: cfg.enabled,
          taskType: activeType,
          syncMode: cfg.syncMode,
        });
        toast.success(
          `${activeType === "analysis" ? "AI分析" : "数据同步"}任务已更新`
        );
      } else {
        const newId = await invoke<string>("create_schedule", {
          dashboardId: dashboard.id,
          prompt: cfg.prompt,
          scheduleType: cfg.scheduleType,
          scheduleConfig: JSON.stringify(scheduleConfig),
          webhookUrl: cfg.webhookUrl,
          phoneNumber: cfg.phoneNumber,
          taskType: activeType,
          syncMode: cfg.syncMode,
        });
        updateCurrent({ id: newId });
        toast.success(
          `${activeType === "analysis" ? "AI分析" : "数据同步"}任务已创建`
        );
      }
      loadSchedules();
    } catch (e) {
      toast.error("保存失败", { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  // 监听后端同步进度事件
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen("sync-progress", (event) => {
      const payload = event.payload as {
        current: number;
        total: number;
        table: string;
        done?: boolean;
      };
      if (payload.done) {
        toast.success(`同步完成，共写入 ${payload.total} 条记录`, {
          id: "sync-progress",
        });
      } else {
        toast.loading(
          `正在同步 ${payload.table}… ${payload.current}/${payload.total}`,
          { id: "sync-progress" }
        );
      }
    }).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const handleTest = async () => {
    if (!dashboard) return;
    const cfg = current;

    setTesting(true);
    try {
      const result = await invoke<string>("test_schedule_run", {
        dashboardId: dashboard.id,
        prompt: cfg.prompt,
        webhookUrl: cfg.webhookUrl,
        phoneNumber: cfg.phoneNumber,
        taskType: activeType,
        syncMode: cfg.syncMode,
      });
      toast.success(result);
    } catch (e) {
      toast.error("测试执行失败", { description: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const parsePhones = (raw: string): string[] => {
    return raw
      .split(/[,\s\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  const handleTestPrivate = async () => {
    const phones = parsePhones(current.phoneNumber);
    if (phones.length === 0) {
      toast.error("请先填写接收人手机号");
      return;
    }
    setTestingPrivate(true);
    try {
      const results: string[] = [];
      for (const phone of phones) {
        const result = await invoke<string>("test_private_message", {
          phoneNumber: phone,
          content: "",
        });
        results.push(`${phone}: ${result}`);
      }
      toast.success(results.join("\n"));
    } catch (e) {
      toast.error("私聊测试失败", { description: String(e) });
    } finally {
      setTestingPrivate(false);
    }
  };

  const toggleDay = (day: number) => {
    updateCurrent({
      selectedDays: current.selectedDays.includes(day)
        ? current.selectedDays.filter((d) => d !== day)
        : [...current.selectedDays, day],
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            定时任务设置
            {dashboard && (
              <span className="text-xs font-normal text-slate-500">
                - {dashboard.name}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-2">
          <div className="space-y-4">
            {/* 任务类型切换 - 颜色区分 */}
            <div className="space-y-2">
              <Label>任务类型</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setActiveType("analysis")}
                  className={`flex-1 rounded-lg border p-2.5 text-sm font-medium transition-colors ${
                    activeType === "analysis"
                      ? "bg-blue-500 text-white border-blue-500 shadow-sm"
                      : "border-slate-200 text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200"
                  }`}
                >
                  AI 分析 + 推送
                </button>
                <button
                  type="button"
                  onClick={() => setActiveType("sync")}
                  className={`flex-1 rounded-lg border p-2.5 text-sm font-medium transition-colors ${
                    activeType === "sync"
                      ? "bg-emerald-500 text-white border-emerald-500 shadow-sm"
                      : "border-slate-200 text-slate-600 hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200"
                  }`}
                >
                  数据同步入库
                </button>
              </div>
            </div>

            {/* AI 分析专属字段 */}
            {activeType === "analysis" && (
              <div className="space-y-2">
                <Label>分析提示词</Label>
                <Textarea
                  placeholder="例如：每天统计各店铺销售额，找出TOP3和需要关注的低销量店铺"
                  value={current.prompt}
                  onChange={(e) => updateCurrent({ prompt: e.target.value })}
                  rows={3}
                />
              </div>
            )}

            {/* 数据同步专属字段 */}
            {activeType === "sync" && (
              <div className="space-y-2">
                <Label>同步模式</Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => updateCurrent({ syncMode: "overwrite" })}
                    className={`flex-1 rounded-lg border p-2 text-sm font-medium transition-colors ${
                      current.syncMode === "overwrite"
                        ? "bg-amber-500 text-white border-amber-500 shadow-sm"
                        : "border-slate-200 text-slate-600 hover:bg-amber-50 hover:text-amber-600 hover:border-amber-200"
                    }`}
                  >
                    覆盖入库
                  </button>
                  <button
                    type="button"
                    onClick={() => updateCurrent({ syncMode: "append" })}
                    className={`flex-1 rounded-lg border p-2 text-sm font-medium transition-colors ${
                      current.syncMode === "append"
                        ? "bg-cyan-500 text-white border-cyan-500 shadow-sm"
                        : "border-slate-200 text-slate-600 hover:bg-cyan-50 hover:text-cyan-600 hover:border-cyan-200"
                    }`}
                  >
                    追加入库
                  </button>
                </div>
                <p className="text-[11px] text-slate-400">
                  覆盖：每次同步先清空本地表再写入；追加：保留已有数据，追加新数据
                </p>
              </div>
            )}

            {/* 定时规则 - 各自独立 */}
            <div className="space-y-2 border-t pt-4">
              <Label>
                {activeType === "analysis"
                  ? "AI 分析定时规则"
                  : "数据同步定时规则"}
              </Label>
              <Tabs
                value={current.scheduleType}
                onValueChange={(v) => updateCurrent({ scheduleType: v })}
              >
                <TabsList className="grid grid-cols-5">
                  <TabsTrigger value="once">单次</TabsTrigger>
                  <TabsTrigger value="daily">每天</TabsTrigger>
                  <TabsTrigger value="weekly">每周</TabsTrigger>
                  <TabsTrigger value="monthly">每月</TabsTrigger>
                  <TabsTrigger value="interval">间隔</TabsTrigger>
                </TabsList>

                <TabsContent value="once" className="space-y-2 pt-2">
                  <div className="flex items-center gap-2">
                    <Label className="w-12 shrink-0">日期</Label>
                    <Input
                      type="date"
                      value={current.onceDate}
                      onChange={(e) =>
                        updateCurrent({ onceDate: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="w-12 shrink-0">时间</Label>
                    <Input
                      type="time"
                      value={current.time}
                      onChange={(e) =>
                        updateCurrent({ time: e.target.value })
                      }
                    />
                  </div>
                </TabsContent>

                <TabsContent value="daily" className="space-y-2 pt-2">
                  <div className="flex items-center gap-2">
                    <Label className="w-12 shrink-0">时间</Label>
                    <Input
                      type="time"
                      value={current.time}
                      onChange={(e) =>
                        updateCurrent({ time: e.target.value })
                      }
                    />
                  </div>
                </TabsContent>

                <TabsContent value="weekly" className="space-y-2 pt-2">
                  <div className="flex items-center gap-2">
                    <Label className="w-12 shrink-0">时间</Label>
                    <Input
                      type="time"
                      value={current.time}
                      onChange={(e) =>
                        updateCurrent({ time: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {WEEKDAYS.map((d) => (
                      <Button
                        key={d.value}
                        type="button"
                        variant={
                          current.selectedDays.includes(d.value)
                            ? "default"
                            : "outline"
                        }
                        size="sm"
                        className="h-8 w-8 p-0 text-xs"
                        onClick={() => toggleDay(d.value)}
                      >
                        {d.label}
                      </Button>
                    ))}
                  </div>
                </TabsContent>

                <TabsContent value="monthly" className="space-y-2 pt-2">
                  <div className="flex items-center gap-2">
                    <Label className="w-12 shrink-0">时间</Label>
                    <Input
                      type="time"
                      value={current.time}
                      onChange={(e) =>
                        updateCurrent({ time: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <Button
                        key={d}
                        type="button"
                        variant={
                          current.selectedDays.includes(d)
                            ? "default"
                            : "outline"
                        }
                        size="sm"
                        className="h-7 w-7 p-0 text-[10px]"
                        onClick={() => toggleDay(d)}
                      >
                        {d}
                      </Button>
                    ))}
                  </div>
                </TabsContent>

                <TabsContent value="interval" className="space-y-2 pt-2">
                  <div className="flex items-center gap-2">
                    <Label className="w-12 shrink-0">时间</Label>
                    <Input
                      type="time"
                      value={current.time}
                      onChange={(e) =>
                        updateCurrent({ time: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="w-12 shrink-0">间隔</Label>
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      value={current.intervalDays}
                      onChange={(e) =>
                        updateCurrent({
                          intervalDays: Number(e.target.value),
                        })
                      }
                      className="w-20"
                    />
                    <span className="text-sm text-slate-500">天</span>
                  </div>
                </TabsContent>
              </Tabs>
            </div>

            {/* 手机号 */}
            <div className="space-y-2">
              <Label>接收人手机号（支持多个）</Label>
              <Textarea
                placeholder="13800138000,13900139000&#10;支持逗号、换行或空格分隔多个手机号"
                value={current.phoneNumber}
                onChange={(e) =>
                  updateCurrent({ phoneNumber: e.target.value })
                }
                rows={2}
              />
              <p className="text-[11px] text-slate-400">
                填写后分析报告将通过钉钉私聊发送给这些用户，可与群 Webhook 同时使用
              </p>
            </div>

            {/* Webhook */}
            <div className="space-y-2">
              <Label>
                {activeType === "analysis"
                  ? "钉钉 Webhook 地址（支持多个）"
                  : "钉钉 Webhook 地址（可选，同步成功后推送通知，支持多个）"}
              </Label>
              <Textarea
                placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxx&#10;支持逗号、换行或空格分隔多个群地址"
                value={current.webhookUrl}
                onChange={(e) =>
                  updateCurrent({ webhookUrl: e.target.value })
                }
                rows={2}
              />
              <p className="text-[11px] text-slate-400">
                {activeType === "analysis"
                  ? "在钉钉群设置中添加机器人，复制Webhook地址粘贴到这里，支持同时发送到多个群"
                  : "填写后每次同步完成会发送一条通知到这些钉钉群"}
              </p>
            </div>

            {/* 执行日志 */}
            {logs.length > 0 && (
              <div className="space-y-2">
                <Label>最近执行记录</Label>
                <div className="space-y-1">
                  {logs.map((log) => (
                    <div
                      key={log.id}
                      className="flex items-center gap-2 text-xs rounded bg-slate-50 p-2"
                    >
                      {log.status === "success" ? (
                        <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                      )}
                      <span className="text-slate-500 shrink-0">
                        {new Date(log.created_at).toLocaleString()}
                      </span>
                      <span className="truncate text-slate-700">
                        {log.error ||
                          log.result?.slice(0, 50) ||
                          "执行完成"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing}
            className="gap-1"
          >
            {testing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            {activeType === "analysis" ? "测试分析" : "测试同步"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestPrivate}
            disabled={testingPrivate || !current.phoneNumber}
            className="gap-1"
          >
            {testingPrivate ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            测试私聊
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateCurrent({ enabled: !current.enabled })}
          >
            {current.enabled ? "禁用" : "启用"}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
