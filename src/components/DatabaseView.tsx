import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invalidateBySourceTable } from "@/lib/dashboardHtmlCache";
import {
  Database,
  Table2,
  Trash2,
  Pencil,
  RefreshCw,
  Loader2,
  Columns3,
  Rows3,
  FileSpreadsheet,
  Save,
  X,
  Upload,
  Code,
  CheckSquare,
  Square,
  SquarePen,
  MessageSquare,
  BarChart3,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronsRight,
  Shield,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import TableUploadModal from "./TableUploadModal";
import PythonCodeModal from "./PythonCodeModal";
import CustomColumnsModal from "./CustomColumnsModal";
import { Calculator } from "lucide-react";

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

interface QueryResult {
  columns: string[];
  rows: string[][];
  rowids: string[];
  primary_key: string;
  total_count: number;
}

interface DashboardInfo {
  id: string;
  name: string;
  source_table?: string;
  sql_template?: string;
}

interface CustomColumn {
  id: string;
  table_name: string;
  column_name: string;
  sql_expression: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

const SYSTEM_TABLES: Record<string, { label: string; description: string }> = {
  chat_sessions: { label: "系统", description: "AI对话记录" },
  kb_docs: { label: "系统", description: "知识库文档" },
  bot_chat_memory: { label: "系统", description: "钉钉机器人记忆" },
  dashboards: { label: "系统", description: "看板配置" },
  table_column_remarks: { label: "系统", description: "字段备注配置" },
  table_upload_mappings: { label: "系统", description: "表格上传映射配置" },
  dashboard_revisions: { label: "系统", description: "看板版本历史" },
  table_remarks: { label: "系统", description: "表备注配置" },
  _detabu_refresh_signals: { label: "系统", description: "刷新信号队列" },
};

export default function DatabaseView() {
  const [tables, setTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>("");
  const [schema, setSchema] = useState<ColumnInfo[]>([]);
  const [data, setData] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTable, setDeleteTable] = useState<string>("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dashboards, setDashboards] = useState<DashboardInfo[]>([]);

  // Edit states
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchColumn, setBatchColumn] = useState("");
  const [batchValue, setBatchValue] = useState("");

  // Remark states
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [editingRemark, setEditingRemark] = useState<string>("");
  const [remarkValue, setRemarkValue] = useState("");

  // Table-level remark states
  const [tableRemarks, setTableRemarks] = useState<Record<string, string>>({});
  const [tableRemarkOpen, setTableRemarkOpen] = useState(false);
  const [tableRemarkTarget, setTableRemarkTarget] = useState("");
  const [tableRemarkValue, setTableRemarkValue] = useState("");

  // Modal states
  const [uploadOpen, setUploadOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [customColumnsOpen, setCustomColumnsOpen] = useState(false);
  const [customColumns, setCustomColumns] = useState<CustomColumn[]>([]);

  // 表结构折叠 + 数据预览分页
  const PAGE_SIZE = 30;
  const [schemaExpanded, setSchemaExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [jumpPageInput, setJumpPageInput] = useState("");

  // 左侧列表宽度 + 拖拽
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const raw = localStorage.getItem("db_sidebar_width");
      return raw ? Math.max(180, Math.min(500, parseInt(raw, 10))) : 240;
    } catch {
      return 240;
    }
  });

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let currentWidth = startWidth;

    const onMove = (e: MouseEvent) => {
      currentWidth = Math.max(180, Math.min(500, startWidth + e.clientX - startX));
      setSidebarWidth(currentWidth);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("db_sidebar_width", String(currentWidth));
      } catch {}
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  const loadTables = async () => {
    setRefreshing(true);
    try {
      const [res, dbs] = await Promise.all([
        invoke<string[]>("get_db_tables"),
        invoke<DashboardInfo[]>("get_dashboards"),
      ]);
      setTables(res);
      setDashboards(dbs);
      if (res.length > 0 && !selectedTable) {
        setSelectedTable(res[0]);
      }
      // 加载表级备注
      const remarksMap: Record<string, string> = {};
      await Promise.all(
        res.map(async (t) => {
          try {
            const r = await invoke<string>("get_table_remark", { tableName: t });
            if (r) remarksMap[t] = r;
          } catch {
            // ignore
          }
        })
      );
      setTableRemarks(remarksMap);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRemarks = async (tableName: string) => {
    try {
      const res = await invoke<Record<string, string>>("get_column_remarks", {
        tableName,
      });
      setRemarks(res || {});
    } catch (e) {
      console.error("加载备注失败:", e);
    }
  };

  const loadTableDetail = useCallback(async () => {
    if (!selectedTable) return;
    setLoading(true);
    try {
      const [schemaRes, dataRes, customCols] = await Promise.all([
        invoke<ColumnInfo[]>("get_table_schema", { tableName: selectedTable }),
        invoke<QueryResult>("query_table_data", {
          tableName: selectedTable,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        }),
        invoke<CustomColumn[]>("list_custom_columns", { tableName: selectedTable }).catch(() => [] as CustomColumn[]),
      ]);
      setSchema(schemaRes);
      setData(dataRes);
      setCustomColumns(customCols);
      setSelectedRows(new Set());
      loadRemarks(selectedTable);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedTable, page]);

  useEffect(() => {
    loadTableDetail();
  }, [loadTableDetail]);

  const handleDelete = async () => {
    if (!deleteTable) return;
    try {
      await invoke("drop_user_table", { tableName: deleteTable });
      invalidateBySourceTable(deleteTable);
      toast.success(`表 ${deleteTable} 已删除`);
      setTables((prev) => prev.filter((t) => t !== deleteTable));
      if (selectedTable === deleteTable) {
        setSelectedTable("");
        setSchema([]);
        setData(null);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleteOpen(false);
      setDeleteTable("");
    }
  };

  const confirmDelete = (tableName: string) => {
    setDeleteTable(tableName);
    setDeleteOpen(true);
  };

  const handleCellDoubleClick = (rowIndex: number, colIndex: number, value: string) => {
    setEditingCell({ row: rowIndex, col: colIndex });
    setEditValue(value);
  };

  const handleSaveCell = async () => {
    if (!editingCell || !data || !selectedTable) return;
    const colName = data.columns[editingCell.col];
    const pkName = data.primary_key;

    let pkValue: string | undefined;
    if (pkName === "rowid") {
      pkValue = data.rowids[editingCell.row];
    } else {
      const pkIndex = data.columns.indexOf(pkName);
      if (pkIndex === -1) {
        toast.error(`无法找到主键列 "${pkName}"，请刷新后重试`);
        setEditingCell(null);
        return;
      }
      pkValue = data.rows[editingCell.row][pkIndex];
    }

    if (pkValue === undefined || pkValue === null) {
      toast.error("无法确定主键值");
      setEditingCell(null);
      return;
    }

    try {
      await invoke("update_table_row", {
        tableName: selectedTable,
        rowData: { [colName]: editValue },
        primaryKey: pkName,
        primaryValue: pkValue,
      });
      invalidateBySourceTable(selectedTable);
      toast.success("修改已保存");
      const updated = { ...data };
      updated.rows = updated.rows.map((r, i) =>
        i === editingCell.row
          ? r.map((c, j) => (j === editingCell.col ? editValue : c))
          : r
      );
      setData(updated);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setEditingCell(null);
    }
  };

  const handleSaveRemark = async (colName: string) => {
    if (!selectedTable) return;
    try {
      await invoke("set_column_remark", {
        tableName: selectedTable,
        columnName: colName,
        remark: remarkValue,
      });
      setRemarks((prev) => ({ ...prev, [colName]: remarkValue }));
      setEditingRemark("");
      toast.success("备注已保存");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const toggleRow = (rowIndex: number) => {
    const next = new Set(selectedRows);
    if (next.has(rowIndex)) {
      next.delete(rowIndex);
    } else {
      next.add(rowIndex);
    }
    setSelectedRows(next);
  };

  const toggleAll = () => {
    if (!data) return;
    if (selectedRows.size === data.rows.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(data.rows.map((_, i) => i)));
    }
  };

  const handleBatchUpdate = async () => {
    if (!selectedTable || !data || selectedRows.size === 0 || !batchColumn) {
      toast.error("请选择行和目标列");
      return;
    }

    const pkName = data.primary_key;
    let pkColIndex = -1;
    if (pkName !== "rowid") {
      pkColIndex = data.columns.indexOf(pkName);
      if (pkColIndex === -1) {
        toast.error(`无法找到主键列 "${pkName}"，请刷新后重试`);
        return;
      }
    }
    const pkValues = data.rows.map((_, i) =>
      pkName === "rowid" ? data.rowids[i] : data.rows[i][pkColIndex]
    );
    const rowIndices = Array.from(selectedRows);

    try {
      const updated = await invoke<number>("batch_update_rows", {
        tableName: selectedTable,
        column: batchColumn,
        value: batchValue,
        rowIndices,
        primaryKey: pkName,
        primaryValues: pkValues,
      });
      if (updated === 0) {
        toast.warning("没有行被更新，请检查主键值是否正确");
      } else {
        invalidateBySourceTable(selectedTable);
        toast.success(`成功更新 ${updated} 行`);
      }
      setBatchOpen(false);
      setBatchColumn("");
      setBatchValue("");
      setSelectedRows(new Set());
      loadTableDetail();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="flex h-full">
      {/* 左侧表列表 */}
      <div className="border-r bg-slate-50 flex flex-col relative" style={{ width: sidebarWidth }}>
        <div className="p-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Database className="h-4 w-4 text-blue-600" />
            数据表 ({tables.length})
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={loadTables}
            disabled={refreshing}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {tables.length === 0 && (
              <div className="text-xs text-slate-400 text-center py-8">
                暂无数据表
                <br />
                请先在工作台入库数据
              </div>
            )}
            {tables.map((table) => {
              const linked = dashboards.filter(
                (d) =>
                  d.source_table === table ||
                  (d.sql_template && d.sql_template.includes(table))
              );
              const sysInfo = SYSTEM_TABLES[table];
              const isSystem = !!sysInfo;
              const isLocked = table.startsWith("_board_");
              return (
                <button
                  key={table}
                  onClick={() => {
                    setSelectedTable(table);
                    setPage(1);
                  }}
                  className={`w-full flex flex-col gap-0.5 px-3 py-2 rounded-md text-sm transition-colors group ${
                    selectedTable === table
                      ? "bg-blue-100 text-blue-700"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <Table2 className="h-4 w-4 flex-shrink-0" />
                    <span className="flex-1 text-left truncate">{table}</span>
                    {isSystem ? (
                      <span className="inline-flex items-center gap-1 text-[0.625rem] text-red-600 font-medium">
                        <Shield className="h-3 w-3" />
                        {sysInfo.label}
                      </span>
                    ) : isLocked ? (
                      <span className="inline-flex items-center gap-1 text-[0.625rem] text-amber-600 font-medium">
                        <Shield className="h-3 w-3" />
                        锁定
                      </span>
                    ) : (
                      tableRemarks[table] && (
                        <span className="text-[0.625rem] text-slate-400 italic truncate max-w-[120px]">
                          {tableRemarks[table]}
                        </span>
                      )
                    )}
                    {!isSystem && !isLocked && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            setTableRemarkTarget(table);
                            setTableRemarkValue(tableRemarks[table] || "");
                            setTableRemarkOpen(true);
                          }}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-600 hover:bg-red-50"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(table);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    )}
                  </div>
                  {isSystem && (
                    <div className="flex items-center gap-1 pl-6">
                      <Shield className="h-3 w-3 text-red-500" />
                      <span className="text-[0.625rem] text-red-500 truncate">
                        {sysInfo.description}（系统表，不可删除）
                      </span>
                    </div>
                  )}
                  {isLocked && (
                    <div className="flex items-center gap-1 pl-6">
                      <Shield className="h-3 w-3 text-amber-500" />
                      <span className="text-[0.625rem] text-amber-500 truncate">
                        看板数据锁定表，禁止编辑和上传，删除看板时自动删除
                      </span>
                    </div>
                  )}
                  {!isSystem && !isLocked && linked.length > 0 && (
                    <div className="flex items-center gap-1 pl-6">
                      <BarChart3 className="h-3 w-3 text-amber-500" />
                      <span className="text-[0.625rem] text-slate-400 truncate">
                        关联看板: {linked.map((d) => d.name).join(", ")}
                      </span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
        {/* 拖拽调整宽度 */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400 active:bg-blue-600 transition-colors z-10"
          onMouseDown={handleResizeStart}
          title="拖拽调整宽度"
        />
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedTable && (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <div className="text-center space-y-2">
              <FileSpreadsheet className="h-12 w-12 mx-auto text-slate-300" />
              <p className="text-sm">选择左侧数据表查看详情</p>
            </div>
          </div>
        )}

        {selectedTable && loading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
          </div>
        )}

        {selectedTable && !loading && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 工具栏 */}
            <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-2 flex-shrink-0">
              <Button variant="outline" size="sm" onClick={loadTableDetail}>
                <RefreshCw className="mr-1 h-3 w-3" /> 刷新
              </Button>
              {!SYSTEM_TABLES[selectedTable] && !selectedTable.startsWith("_board_") && (
                <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)}>
                  <Upload className="mr-1 h-3 w-3" /> 上传表格
                </Button>
              )}
              {!SYSTEM_TABLES[selectedTable] && (
                <Button variant="outline" size="sm" onClick={() => setCodeOpen(true)}>
                  <Code className="mr-1 h-3 w-3" /> Python代码
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setCustomColumnsOpen(true)}>
                <Calculator className="mr-1 h-3 w-3" /> 公式列
                {customColumns.length > 0 && (
                  <span className="ml-1 text-[10px] bg-blue-100 text-blue-700 px-1 rounded">
                    {customColumns.length}
                  </span>
                )}
              </Button>
              {selectedRows.size > 0 && !selectedTable.startsWith("_board_") && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setBatchOpen(true)}>
                    <SquarePen className="mr-1 h-3 w-3" />
                    批量修改 ({selectedRows.size})
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedRows(new Set())}
                  >
                    <X className="mr-1 h-3 w-3" /> 取消选择
                  </Button>
                </>
              )}
            </div>

            {/* 表结构 */}
            <div className="border-b flex-shrink-0">
              <button
                type="button"
                onClick={() => setSchemaExpanded((v) => !v)}
                className="w-full px-4 py-3 flex items-center gap-2 text-sm font-medium bg-slate-50 hover:bg-slate-100 transition-colors"
              >
                {schemaExpanded ? (
                  <ChevronDown className="h-4 w-4 text-slate-500" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-slate-500" />
                )}
                <Columns3 className="h-4 w-4 text-slate-500" />
                <span>表结构：{selectedTable}</span>
                <span className="text-xs text-slate-400 font-normal">
                  ({schema.length} 列)
                </span>
                <span className="ml-auto text-xs text-slate-400 font-normal">
                  {schemaExpanded ? "点击收起" : "点击展开"}
                </span>
              </button>
              {schemaExpanded && (
                <div className="overflow-y-auto max-h-[300px] border-t">
                  <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">CID</TableHead>
                      <TableHead>字段名</TableHead>
                      <TableHead className="w-[200px]">中文备注</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>可空</TableHead>
                      <TableHead>默认值</TableHead>
                      <TableHead>主键</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {schema.map((col) => (
                      <TableRow key={col.cid}>
                        <TableCell className="text-xs text-slate-500">
                          {col.cid}
                        </TableCell>
                        <TableCell className="font-medium text-sm">
                          {col.name}
                        </TableCell>
                        <TableCell>
                          {editingRemark === col.name ? (
                            <div className="flex items-center gap-1">
                              <input
                                autoFocus
                                className="flex-1 rounded border px-1 py-0.5 text-xs"
                                placeholder="输入中文备注"
                                value={remarkValue}
                                onChange={(e) => setRemarkValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveRemark(col.name);
                                  if (e.key === "Escape") setEditingRemark("");
                                }}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 w-5 p-0"
                                onClick={() => handleSaveRemark(col.name)}
                              >
                                <Save className="h-3 w-3 text-green-600" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 w-5 p-0"
                                onClick={() => setEditingRemark("")}
                              >
                                <X className="h-3 w-3 text-red-500" />
                              </Button>
                            </div>
                          ) : (
                            <button
                              className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600"
                              onClick={() => {
                                setEditingRemark(col.name);
                                setRemarkValue(remarks[col.name] || "");
                              }}
                            >
                              <MessageSquare className="h-3 w-3" />
                              {remarks[col.name] || (
                                <span className="text-slate-300 italic">点击添加备注</span>
                              )}
                            </button>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className="text-[0.625rem]">
                              {col.type || "TEXT"}
                            </Badge>
                            {customColumns.find((c) => c.column_name === col.name) && (
                              <Badge className="text-[0.625rem] bg-purple-100 text-purple-700 hover:bg-purple-100">
                                公式
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {col.notnull ? (
                            <span className="text-xs text-red-500">NOT NULL</span>
                          ) : (
                            <span className="text-xs text-slate-400">NULL</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500">
                          {col.dflt_value || "-"}
                        </TableCell>
                        <TableCell>
                          {col.pk && (
                            <Badge className="text-[0.625rem] bg-amber-100 text-amber-700 hover:bg-amber-100">
                              PK
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
            </div>

            {/* 数据预览 */}
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              <div className="px-4 py-3 flex items-center gap-2 text-sm font-medium border-b bg-slate-50 flex-shrink-0">
                <Rows3 className="h-4 w-4 text-slate-500" />
                数据预览
                {data && (
                  <span className="text-xs text-slate-400 font-normal">
                    共 {data.total_count} 行 · 第 {page} / {Math.max(1, Math.ceil(data.total_count / PAGE_SIZE))} 页
                    {selectedRows.size > 0 && `，已选 ${selectedRows.size} 行`}
                  </span>
                )}
              </div>
              <ScrollArea className="flex-1 min-h-0">
                {data && data.rows.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <button onClick={toggleAll} className="flex items-center">
                            {selectedRows.size === data.rows.length ? (
                              <CheckSquare className="h-4 w-4 text-blue-600" />
                            ) : (
                              <Square className="h-4 w-4 text-slate-400" />
                            )}
                          </button>
                        </TableHead>
                        {data.columns.map((col) => (
                          <TableHead key={col}>
                            <div className="flex flex-col">
                              <span>{col}</span>
                              {remarks[col] && (
                                <span className="text-[0.625rem] text-slate-400 font-normal">
                                  {remarks[col]}
                                </span>
                              )}
                            </div>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.rows.map((row, ri) => (
                        <TableRow
                          key={ri}
                          className={selectedRows.has(ri) ? "bg-blue-50" : ""}
                        >
                          <TableCell>
                            <button onClick={() => toggleRow(ri)}>
                              {selectedRows.has(ri) ? (
                                <CheckSquare className="h-4 w-4 text-blue-600" />
                              ) : (
                                <Square className="h-4 w-4 text-slate-400" />
                              )}
                            </button>
                          </TableCell>
                          {row.map((cell, ci) => (
                            <TableCell
                              key={ci}
                              className={`max-w-[200px] truncate text-xs ${
                                !selectedTable.startsWith("_board_")
                                  ? "cursor-pointer hover:text-blue-600"
                                  : ""
                              }`}
                              onDoubleClick={() => {
                                if (!selectedTable.startsWith("_board_")) {
                                  handleCellDoubleClick(ri, ci, cell);
                                }
                              }}
                            >
                              {editingCell?.row === ri &&
                              editingCell?.col === ci ? (
                                <div className="flex items-center gap-1">
                                  <input
                                    autoFocus
                                    className="w-full min-w-[80px] rounded border px-1 py-0.5 text-xs"
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") handleSaveCell();
                                      if (e.key === "Escape")
                                        setEditingCell(null);
                                    }}
                                  />
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-5 w-5 p-0"
                                    onClick={handleSaveCell}
                                  >
                                    <Save className="h-3 w-3 text-green-600" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-5 w-5 p-0"
                                    onClick={() => setEditingCell(null)}
                                  >
                                    <X className="h-3 w-3 text-red-500" />
                                  </Button>
                                </div>
                              ) : (
                                <span className="cursor-pointer hover:text-blue-600">
                                  {cell}
                                </span>
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="text-center py-8 text-sm text-slate-400">
                    暂无数据
                  </div>
                )}
              </ScrollArea>
              {/* 分页栏 */}
              {data && data.total_count > PAGE_SIZE && (
                <div className="px-4 py-2 border-t bg-slate-50 flex items-center justify-between text-xs text-slate-500 flex-shrink-0">
                  <span>
                    每页 {PAGE_SIZE} 条 · 共 {data.total_count} 条 · {Math.max(1, Math.ceil(data.total_count / PAGE_SIZE))} 页
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="h-3 w-3" />
                      上一页
                    </Button>
                    <span>
                      第 {page} / {Math.max(1, Math.ceil(data.total_count / PAGE_SIZE))} 页
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={page >= Math.ceil(data.total_count / PAGE_SIZE)}
                      onClick={() =>
                        setPage((p) =>
                          Math.min(Math.ceil(data.total_count / PAGE_SIZE), p + 1)
                        )
                      }
                    >
                      下一页
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                    <div className="flex items-center gap-1">
                      <span className="text-slate-400">前往</span>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, Math.ceil(data.total_count / PAGE_SIZE))}
                        className="w-12 h-7 rounded border border-input bg-transparent px-1 py-0.5 text-xs text-center"
                        placeholder="页码"
                        value={jumpPageInput}
                        onChange={(e) => setJumpPageInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const target = parseInt(jumpPageInput, 10);
                            const totalPages = Math.max(1, Math.ceil(data.total_count / PAGE_SIZE));
                            if (!isNaN(target) && target >= 1 && target <= totalPages) {
                              setPage(target);
                              setJumpPageInput("");
                            } else {
                              toast.error(`请输入 1-${totalPages} 之间的页码`);
                            }
                          }
                        }}
                      />
                      <span className="text-slate-400">页</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() =>
                        setPage(Math.max(1, Math.ceil(data.total_count / PAGE_SIZE)))
                      }
                    >
                      尾页
                      <ChevronsRight className="h-3 w-3 ml-0.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除确认</DialogTitle>
            <DialogDescription>
              确定要删除数据表 <strong>{deleteTable}</strong> 吗？
              此操作不可恢复，表中的所有数据将被永久删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量修改弹窗 */}
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>批量修改</DialogTitle>
            <DialogDescription>
              已选择 {selectedRows.size} 行，请选择要修改的列和新值。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium">目标列</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={batchColumn}
                onChange={(e) => setBatchColumn(e.target.value)}
              >
                <option value="">选择列</option>
                {data?.columns.map((col) => (
                  <option key={col} value={col}>
                    {col} {remarks[col] ? `(${remarks[col]})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">新值</label>
              <input
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                placeholder="输入新值"
                value={batchValue}
                onChange={(e) => setBatchValue(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button onClick={handleBatchUpdate}>
              <Save className="mr-2 h-4 w-4" />
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 表备注编辑弹窗 */}
      <Dialog open={tableRemarkOpen} onOpenChange={setTableRemarkOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑表备注</DialogTitle>
            <DialogDescription>
              为数据表 <strong>{tableRemarkTarget}</strong> 添加中文备注，便于识别和展示。
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <input
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              placeholder="输入中文备注（如：销售订单表）"
              value={tableRemarkValue}
              onChange={(e) => setTableRemarkValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (async () => {
                    if (!tableRemarkTarget) return;
                    try {
                      await invoke("set_table_remark", {
                        tableName: tableRemarkTarget,
                        remark: tableRemarkValue.trim(),
                      });
                      setTableRemarks((prev) => ({
                        ...prev,
                        [tableRemarkTarget]: tableRemarkValue.trim(),
                      }));
                      setTableRemarkOpen(false);
                      toast.success("表备注已保存");
                    } catch (err) {
                      toast.error(String(err));
                    }
                  })();
                }
              }}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTableRemarkOpen(false)}>
              取消
            </Button>
            <Button
              onClick={async () => {
                if (!tableRemarkTarget) return;
                try {
                  await invoke("set_table_remark", {
                    tableName: tableRemarkTarget,
                    remark: tableRemarkValue.trim(),
                  });
                  setTableRemarks((prev) => ({
                    ...prev,
                    [tableRemarkTarget]: tableRemarkValue.trim(),
                  }));
                  setTableRemarkOpen(false);
                  toast.success("表备注已保存");
                } catch (err) {
                  toast.error(String(err));
                }
              }}
            >
              <Save className="mr-2 h-4 w-4" />
              保存备注
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 上传表格弹窗 */}
      {selectedTable && (
        <TableUploadModal
          tableName={selectedTable}
          schema={schema}
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          onSuccess={loadTableDetail}
        />
      )}

      {/* Python代码弹窗 */}
      {selectedTable && (
        <PythonCodeModal
          tableName={selectedTable}
          schema={schema}
          open={codeOpen}
          onOpenChange={setCodeOpen}
        />
      )}

      {/* 公式列弹窗 */}
      {selectedTable && (
        <CustomColumnsModal
          open={customColumnsOpen}
          onOpenChange={setCustomColumnsOpen}
          tableName={selectedTable}
          onApplied={() => {
            loadTableDetail();
          }}
        />
      )}
    </div>
  );
}
