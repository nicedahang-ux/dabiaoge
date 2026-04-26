import { BarChart3, Copy, Wrench, ArrowRight, Trash2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import type { Dashboard } from "@/lib/AppContext";

interface DashboardCardProps {
  dashboard: Dashboard;
  onView: (dashboard: Dashboard) => void;
  onModify: (dashboard: Dashboard) => void;
  onDelete?: (dashboard: Dashboard) => void;
  onPack?: (dashboard: Dashboard) => void;
}

export default function DashboardCard({
  dashboard,
  onView,
  onModify,
  onDelete,
  onPack,
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

        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="default"
            size="sm"
            className="h-7 gap-1 text-xs flex-1"
            onClick={() => onView(dashboard)}
          >
            进入
            <ArrowRight className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={handleCopyId}
          >
            <Copy className="h-3 w-3" />
            复制ID
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => onModify(dashboard)}
          >
            <Wrench className="h-3 w-3" />
            修改
          </Button>
          {onPack && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-blue-500 hover:text-blue-600 hover:bg-blue-50"
              onClick={(e) => {
                e.stopPropagation();
                onPack(dashboard);
              }}
            >
              <Package className="h-3 w-3" />
              打包
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-red-500 hover:text-red-600 hover:bg-red-50"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(dashboard);
              }}
            >
              <Trash2 className="h-3 w-3" />
              删除
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
