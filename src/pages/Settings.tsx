import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Settings as SettingsIcon, MessageSquare, Bot, Power, MonitorUp } from "lucide-react";
import { toast } from "sonner";
import { isEnabled, enable, disable } from "@tauri-apps/plugin-autostart";
import { useApp } from "@/lib/AppContext";

interface AppConfig {
  ai_url: string;
  ai_key: string;
  ai_model: string;
  query_model: string;
  ding_app_key: string;
  ding_app_secret: string;
}

const defaultConfig: AppConfig = {
  ai_url: "",
  ai_key: "",
  ai_model: "deepseek-chat",
  query_model: "",
  ding_app_key: "",
  ding_app_secret: "",
};

export default function Settings() {
  const { botStatus, refreshBotStatus } = useApp();
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [botLoading, setBotLoading] = useState(false);
  const [autoStart, setAutoStart] = useState(false);

  useEffect(() => {
    loadConfig();
    loadAutoStart();
    refreshBotStatus().catch(() => {});
  }, [refreshBotStatus]);

  async function loadAutoStart() {
    try {
      const enabled = await isEnabled();
      setAutoStart(enabled);
    } catch {
      // 不支持开机自启的平台会报错，忽略
    }
  }

  async function handleAutoStartChange(enabled: boolean) {
    try {
      if (enabled) {
        await enable();
        toast.success("已开启开机自启");
      } else {
        await disable();
        toast.success("已关闭开机自启");
      }
      setAutoStart(enabled);
    } catch (e) {
      toast.error("设置开机自启失败", { description: String(e) });
    }
  }

  async function loadConfig() {
    try {
      const data = await invoke<AppConfig>("load_config");
      if (data && data.ai_url) {
        setConfig(data);
      }
    } catch (e) {
      toast.error("加载配置失败", {
        description: String(e),
      });
    } finally {
      setLoaded(true);
    }
  }

  function validate(): boolean {
    if (!config.ai_url.trim()) {
      toast.error("AI 接口地址不能为空");
      return false;
    }
    if (!config.ai_key.trim()) {
      toast.error("AI API Key 不能为空");
      return false;
    }
    if (!config.ding_app_key.trim()) {
      toast.error("钉钉 AppKey 不能为空");
      return false;
    }
    if (!config.ding_app_secret.trim()) {
      toast.error("钉钉 AppSecret 不能为空");
      return false;
    }
    return true;
  }

  function validateDing(): boolean {
    if (!config.ding_app_key.trim()) {
      toast.error("钉钉 AppKey 不能为空");
      return false;
    }
    if (!config.ding_app_secret.trim()) {
      toast.error("钉钉 AppSecret 不能为空");
      return false;
    }
    return true;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    try {
      await invoke("save_config", { config });
      toast.success("配置保存成功", {
        description: "系统配置已持久化到本地存储",
      });
    } catch (e) {
      toast.error("保存失败", {
        description: String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!validateDing()) return;
    setTesting(true);
    try {
      await invoke("save_config", { config });
      const result = await invoke<string>("test_dingtalk_conn");
      toast.success("连接测试成功", {
        description: result,
      });
    } catch (e) {
      const msg = String(e);
      if (msg.includes("网络") || msg.includes("connect")) {
        toast.error("本地网络连接失败，请检查网络设置");
      } else if (msg.includes("Key") || msg.includes("密钥") || msg.includes("token")) {
        toast.error("钉钉凭证错误，请检查 AppKey 和 AppSecret 是否填写正确");
      } else {
        toast.error(msg);
      }
    } finally {
      setTesting(false);
    }
  }

  function updateField<K extends keyof AppConfig>(field: K, value: AppConfig[K]) {
    setConfig((prev) => ({ ...prev, [field]: value }));
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-6 h-full overflow-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-6 w-6" />
          <h1 className="text-2xl font-bold">系统配置</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <div
              className={`h-3 w-3 rounded-full ${
                botStatus === "connected" ? "bg-green-500" : "bg-red-500"
              }`}
            />
            {botStatus === "connected"
              ? "钉钉服务监听中..."
              : "钉钉服务未连接"}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              setBotLoading(true);
              try {
                await invoke("start_bot");
                toast.success("机器人启动成功，钉钉服务已连接");
                await refreshBotStatus();
              } catch (e) {
                const msg = String(e);
                if (msg.includes("Stream") || msg.includes("gateway") || msg.includes("endpoint") || msg.includes("WebSocket")) {
                  toast.error("钉钉 Stream 连接失败", {
                    description: msg,
                  });
                } else if (msg.includes("AppKey") || msg.includes("AppSecret")) {
                  toast.error("钉钉配置错误", {
                    description: msg,
                  });
                } else {
                  toast.error("启动失败", {
                    description: msg,
                  });
                }
              } finally {
                setBotLoading(false);
              }
            }}
            disabled={botLoading || botStatus === "connected"}
          >
            {botLoading && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            <Power className="h-3 w-3 mr-1" /> {botStatus === "connected" ? "已启动" : "启动"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            AI 大模型配置
          </CardTitle>
          <CardDescription>
            配置 DeepSeek 或其他兼容 OpenAI 接口的大模型服务
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="ai_url">接口地址 (Base URL)</Label>
            <Input
              id="ai_url"
              placeholder="https://api.deepseek.com/v1"
              value={config.ai_url}
              onChange={(e) => updateField("ai_url", e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai_key">API Key</Label>
            <Input
              id="ai_key"
              type="password"
              placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={config.ai_key}
              onChange={(e) => updateField("ai_key", e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai_model">模型名称</Label>
            <Input
              id="ai_model"
              placeholder="deepseek-chat"
              value={config.ai_model}
              onChange={(e) => updateField("ai_model", e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="query_model">查询模型（可选）</Label>
            <Input
              id="query_model"
              placeholder="例如：deepseek-chat-lite，留空则使用主模型"
              value={config.query_model}
              onChange={(e) => updateField("query_model", e.target.value)}
            />
            <p className="text-xs text-slate-500">
              用于数据库查询、看板匹配等场景，建议填写速度更快的模型
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            钉钉机器人配置
          </CardTitle>
          <CardDescription>
            填写钉钉开放平台的应用凭证即可连接 Stream 模式
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="ding_app_key">AppKey (Client ID)</Label>
            <Input
              id="ding_app_key"
              placeholder="dingxxxxxxxxxxxxxxxx"
              value={config.ding_app_key}
              onChange={(e) => updateField("ding_app_key", e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ding_app_secret">AppSecret (Client Secret)</Label>
            <Input
              id="ding_app_secret"
              type="password"
              placeholder="输入 AppSecret"
              value={config.ding_app_secret}
              onChange={(e) => updateField("ding_app_secret", e.target.value)}
            />
          </div>
          <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
            请确保钉钉应用已开启相关权限：单聊机器人使用管理权限、钉钉群基础信息管理权限、钉钉群基础信息读权限、群文件发送权限、个人手机号信息、企业员工手机号信息、通讯录个人信息读权限、成员信息读权限、企业内机器人发送消息权限
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MonitorUp className="h-5 w-5" />
            启动设置
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="auto-start">开机自启</Label>
              <p className="text-xs text-slate-500">系统登录时自动启动本应用</p>
            </div>
            <button
              id="auto-start"
              onClick={() => handleAutoStartChange(!autoStart)}
              className={`px-4 py-1.5 rounded-md text-sm text-white font-medium transition-colors ${
                autoStart
                  ? "bg-green-500 hover:bg-green-600"
                  : "bg-red-500 hover:bg-red-600"
              }`}
            >
              {autoStart ? "已开启" : "已关闭"}
            </button>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-4">
        <Button onClick={handleSave} disabled={saving || testing}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          保存配置
        </Button>
        <Button variant="outline" onClick={handleTest} disabled={saving || testing}>
          {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          保存并测试连接
        </Button>
      </div>
    </div>
  );
}
