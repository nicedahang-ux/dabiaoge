import { BarChart3, Copy, Wrench, ArrowRight, Trash2, Package, Files, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { Dashboard } from "@/lib/AppContext";

interface DashboardCardProps {
  dashboard: Dashboard;
  onView: (dashboard: Dashboard) => void;
  onModify: (dashboard: Dashboard) => void;
  onDelete?: (dashboard: Dashboard) => void;
  onPack?: (dashboard: Dashboard) => void;
  onCopy?: (dashboard: Dashboard) => void;
  onSchedule?: (dashboard: Dashboard) => void;
}

export default function DashboardCard({
  dashboard,
  onView,
  onModify,
  onDelete,
  onPack,
  onCopy,
  onSchedule,
}: DashboardCardProps) {
  const handleCopyId = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(dashboard.id);
      toast.success("看板ID已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const charts = dashboard.charts
    ? (JSON.parse(dashboard.charts) as string[])
    : [];

  return (
    <Card className="relative group hover:shadow-md transition-shadow">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BarChart3 className="h-4 w-4 text-blue-600" />
          {dashboard.name}
          {dashboard.source_type && dashboard.source_type !== 'local' && (
            <Badge variant="outline" className="text-[10px] h-4 px-1">
              {dashboard.source_type === 'dingtalk_sheet' ? '钉钉表' : dashboard.source_type === 'dingtalk_bitable' ? '多维表' : dashboard.source_type}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {dashboard.description && (
          <p className="text-xs text-slate-500 line-clamp-2">
            {dashboard.description}
          </p>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          {charts.map((chart) => (
            <span
              key={chart}
              className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600"
            >
              {chart === "pie" && "饼图"}
              {chart === "bar" && "柱状图"}
              {chart === "line" && "折线图"}
              {chart === "table" && "表格"}
            </span>
          ))}
        </div>
        <p className="text-[10px] text-slate-400">
          创建于 {new Date(dashboard.created_at).toLocaleDateString()}
        </p>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant="default"
            size="sm"
            className="h-7 gap-1 text-xs flex-1 min-w-[4rem]"
            onClick={() => onView(dashboard)}
          >
            进入
            <ArrowRight className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs px-2"
            onClick={handleCopyId}
          >
            <Copy className="h-3 w-3" />
            <span className="hidden sm:inline">复制ID</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs px-2"
            onClick={() => onModify(dashboard)}
          >
            <Wrench className="h-3 w-3" />
            <span className="hidden sm:inline">修改</span>
          </Button>
          {onSchedule && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50 px-2"
              onClick={(e) => {
                e.stopPropagation();
                onSchedule(dashboard);
              }}
            >
              <Clock className="h-3 w-3" />
              <span className="hidden sm:inline">定时</span>
            </Button>
          )}
          {onCopy && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 px-2"
              onClick={(e) => {
                e.stopPropagation();
                onCopy(dashboard);
              }}
            >
              <Files className="h-3 w-3" />
              <span className="hidden sm:inline">复制</span>
            </Button>
          )}
          {onPack && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-blue-500 hover:text-blue-600 hover:bg-blue-50 px-2"
              onClick={(e) => {
                e.stopPropagation();
                onPack(dashboard);
              }}
            >
              <Package className="h-3 w-3" />
              <span className="hidden sm:inline">打包</span>
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 px-2"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(dashboard);
              }}
            >
              <Trash2 className="h-3 w-3" />
              <span className="hidden sm:inline">删除</span>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
