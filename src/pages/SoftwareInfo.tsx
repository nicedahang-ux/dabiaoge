import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress, ProgressTrack, ProgressIndicator } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  Bot,
  FileSpreadsheet,
  Share2,
  Database,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  History,
  ExternalLink,
  Type,
  Minus,
  Plus,
} from "lucide-react";
import { useApp } from "@/lib/AppContext";
import { Input } from "@/components/ui/input";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";

const UPDATE_ENDPOINT = "https://excel.lidani.cn:8990";

const FEATURES = [
  {
    icon: Bot,
    title: "AI 智能分析",
    desc: "基于大语言模型的表格数据分析、SQL 生成与看板构建",
  },
  {
    icon: FileSpreadsheet,
    title: "表格转看板",
    desc: "上传 Excel 文件，一键转换为可视化数据看板",
  },
  {
    icon: Database,
    title: "本地数据库",
    desc: "内置 SQLite 数据库，数据安全存储在本地",
  },
  {
    icon: Share2,
    title: "局域网分享",
    desc: "一键开启局域网分享，移动端实时查看看板",
  },
];

const CHANGELOG = [
  {
    version: "1.0.2",
    date: "2026-04-27",
    items: [
      "新增字体可调整",
      "侧边栏可拖拽宽度",
    ],
  },
  {
    version: "1.0.1",
    date: "2026-04-27",
    items: [
      "优化钉钉回复功能",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-04-26",
    items: [
      "优化HTML生成",
      "支持复制模板",
      "优化分享功能",
    ],
  },  
  {
    version: "0.2.0",
    date: "2026-04-26",
    items: [
      "优化表格处理功能",
      "支持多表格与AI交互",
      "新增在线更新功能",
      "支持历史版本降级安装",
    ],
  },
  { version: "0.1.0", date: "2026-04-26", items: ["初始版本发布"] },
];

interface HistoryVersion {
  version: string;
  date: string;
  notes: string;
  filename: string;
}

export default function SoftwareInfo() {
  const { fontScale, setFontScale } = useApp();
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    body?: string;
    date?: string;
  } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [contentLength, setContentLength] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [historyVersions, setHistoryVersions] = useState<HistoryVersion[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    autoCheck();
    loadHistoryVersions();
  }, []);

  async function autoCheck() {
    try {
      const update = await check();
      if (update) {
        setUpdateInfo({
          version: update.version,
          body: update.body || "",
          date: update.date,
        });
      }
    } catch {
      // 静默失败，不打扰用户
    }
  }

  async function handleCheck() {
    setChecking(true);
    try {
      const update = await check();
      if (update) {
        setUpdateInfo({
          version: update.version,
          body: update.body || "",
          date: update.date,
        });
        toast.success(`发现新版本: ${update.version}`);
      } else {
        setUpdateInfo(null);
        toast.success("当前已是最新版本");
      }
    } catch (e) {
      toast.error("检查更新失败: " + String(e));
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate() {
    if (!updateInfo) return;
    setDownloading(true);
    setProgress(0);
    setDownloadedBytes(0);
    try {
      const update = await check();
      if (!update) {
        toast.error("更新信息已失效");
        setDownloading(false);
        return;
      }

      await update.downloadAndInstall(
        (event: DownloadEvent) => {
          switch (event.event) {
            case "Started":
              if (event.data.contentLength) {
                setContentLength(event.data.contentLength);
              }
              break;
            case "Progress":
              setDownloadedBytes((prev) => {
                const next = prev + event.data.chunkLength;
                if (contentLength > 0) {
                  setProgress(Math.min(100, Math.round((next / contentLength) * 100)));
                }
                return next;
              });
              break;
            case "Finished":
              setProgress(100);
              break;
          }
        }
      );

      toast.success("更新下载完成，即将重启应用");
    } catch (e) {
      toast.error("更新失败: " + String(e));
    } finally {
      setDownloading(false);
    }
  }

  async function loadHistoryVersions() {
    setLoadingHistory(true);
    try {
      const res = await fetch(`${UPDATE_ENDPOINT}/versions.json`, { cache: "no-store" });
      if (res.ok) {
        const data: HistoryVersion[] = await res.json();
        // 过滤掉当前版本及更高版本（只保留可降级的旧版本）
        const older = data.filter((v) => compareVersion(v.version, __APP_VERSION__) < 0);
        setHistoryVersions(older);
      }
    } catch {
      // 静默失败
    } finally {
      setLoadingHistory(false);
    }
  }

  async function handleDownloadOldVersion(filename: string) {
    try {
      const url = `${UPDATE_ENDPOINT}/download/${encodeURIComponent(filename)}`;
      await openUrl(url);
      toast.success("已开始下载，请在浏览器中查看下载进度");
    } catch (e) {
      toast.error("打开下载链接失败: " + String(e));
    }
  }

  function compareVersion(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* 有新版本时顶部持续显示红色提示条 */}
      {updateInfo && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-red-700 text-sm font-medium">
            <AlertCircle className="h-4 w-4" />
            <span>检测到新版本 v{updateInfo.version}，建议立即更新</span>
          </div>
          <Button size="sm" onClick={handleUpdate} disabled={downloading} className="gap-1">
            <Download className="h-3.5 w-3.5" />
            {downloading ? "更新中..." : "立即更新"}
          </Button>
        </div>
      )}

      <div>
        <h1 className="text-2xl font-bold text-slate-900">软件信息</h1>
        <p className="text-sm text-slate-500 mt-1">AI表格转看板 系统功能与版本信息</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <Card key={f.title}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Icon className="h-5 w-5 text-blue-600" />
                  {f.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600">{f.desc}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* 字体大小设置 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Type className="h-5 w-5 text-slate-600" />
            显示设置
          </CardTitle>
          <CardDescription>调整整体字体显示比例</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setFontScale(Math.max(0.5, Math.round((fontScale - 0.1) * 10) / 10))}
              disabled={fontScale <= 0.5}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <div className="flex-1">
              <input
                type="range"
                min="0.5"
                max="5"
                step="0.1"
                value={fontScale}
                onChange={(e) => setFontScale(parseFloat(e.target.value))}
                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
              <div className="flex justify-between text-xs text-slate-400 mt-1">
                <span>0.5x</span>
                <span>1.0x</span>
                <span>2.5x</span>
                <span>5.0x</span>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setFontScale(Math.min(5, Math.round((fontScale + 0.1) * 10) / 10))}
              disabled={fontScale >= 5}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-600">当前缩放:</span>
            <Input
              type="number"
              min={0.5}
              max={5}
              step={0.1}
              value={fontScale}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) setFontScale(val);
              }}
              className="w-24 h-8 text-sm"
            />
            <span className="text-sm text-slate-500">倍</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-slate-400 hover:text-slate-600"
              onClick={() => setFontScale(1)}
            >
              恢复默认
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">版本信息</CardTitle>
          <CardDescription>当前版本与更新状态</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-700">当前版本</p>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">v{__APP_VERSION__}</Badge>
                {updateInfo ? (
                  <Badge variant="destructive" className="flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    有更新 v{updateInfo.version}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="flex items-center gap-1 text-green-600 border-green-600">
                    <CheckCircle2 className="h-3 w-3" />
                    已是最新
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              {updateInfo && !downloading && (
                <Button onClick={handleUpdate} className="gap-1">
                  <Download className="h-4 w-4" />
                  立即更新
                </Button>
              )}
              <Button
                variant="outline"
                onClick={handleCheck}
                disabled={checking || downloading}
                className="gap-1"
              >
                <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
                {checking ? "检查中..." : "检查更新"}
              </Button>
            </div>
          </div>

          {downloading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600">下载进度</span>
                <span className="text-slate-900 font-medium">
                  {progress}% ({formatBytes(downloadedBytes)}
                  {contentLength > 0 ? ` / ${formatBytes(contentLength)}` : ""})
                </span>
              </div>
              <Progress value={progress} className="h-2">
                <ProgressTrack>
                  <ProgressIndicator />
                </ProgressTrack>
              </Progress>
            </div>
          )}

          {updateInfo?.body && (
            <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-700">
              <p className="font-medium mb-1">新版本更新内容:</p>
              <div className="whitespace-pre-wrap">{updateInfo.body}</div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 历史版本降级区域 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <History className="h-5 w-5 text-slate-600" />
            历史版本
          </CardTitle>
          <CardDescription>如新版有问题，可下载旧版本手动降级安装</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingHistory ? (
            <p className="text-sm text-slate-500">加载中...</p>
          ) : historyVersions.length === 0 ? (
            <p className="text-sm text-slate-500">暂无可降级的历史版本</p>
          ) : (
            <div className="space-y-3">
              {historyVersions.map((v) => (
                <div
                  key={v.version}
                  className="flex items-center justify-between bg-slate-50 rounded-lg p-3"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">v{v.version}</Badge>
                      <span className="text-xs text-slate-400">{v.date}</span>
                    </div>
                    <p className="text-sm text-slate-600">{v.notes}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1 shrink-0"
                    onClick={() => handleDownloadOldVersion(v.filename)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    下载安装包
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">更新日志</CardTitle>
          <CardDescription>历史版本变更记录</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {CHANGELOG.map((log) => (
              <div key={log.version}>
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline">v{log.version}</Badge>
                  <span className="text-xs text-slate-400">{log.date}</span>
                </div>
                <ul className="list-disc list-inside text-sm text-slate-600 space-y-0.5">
                  {log.items.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
                <hr className="mt-3 border-slate-200" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
