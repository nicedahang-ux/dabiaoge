import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Check, Code } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

interface PythonCodeModalProps {
  tableName: string;
  schema: ColumnInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ColumnMapping {
  excel_col: string;
  db_col: string;
}

interface SavedMappingConfig {
  table_name: string;
  mappings: ColumnMapping[];
  auto_clean: boolean;
}

export default function PythonCodeModal({
  tableName,
  schema,
  open,
  onOpenChange,
}: PythonCodeModalProps) {
  const [localDbPath, setLocalDbPath] = useState("");
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [copied, setCopied] = useState(false);
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [hasSaved, setHasSaved] = useState(false);

  useEffect(() => {
    if (open) {
      loadDbPath();
      loadRemarks();
      loadSavedMappings();
    }
  }, [open, schema, tableName]);

  async function loadSavedMappings() {
    try {
      const cfg = await invoke<SavedMappingConfig>("get_table_mappings", {
        tableName,
      });
      if (cfg.mappings && cfg.mappings.length > 0) {
        setMappings(cfg.mappings);
        setHasSaved(true);
        return;
      }
    } catch (e) {
      console.error("加载已保存映射失败:", e);
    }
    const autoMappings = schema.map((col) => ({
      excel_col: col.name,
      db_col: col.name,
    }));
    setMappings(autoMappings);
    setHasSaved(false);
  }

  async function loadDbPath() {
    try {
      const path = await invoke<string>("get_local_db_path");
      setLocalDbPath(path);
    } catch (e) {
      console.error("获取数据库路径失败:", e);
    }
  }

  async function loadRemarks() {
    try {
      const res = await invoke<Record<string, string>>("get_column_remarks", {
        tableName,
      });
      setRemarks(res || {});
    } catch (e) {
      console.error("加载备注失败:", e);
    }
  }

  const generatePythonCode = () => {
    const mappingCode = mappings
      .map((m) => `    "${m.excel_col}": "${m.db_col}",`)
      .join("\n");

    return `import pandas as pd
import sqlite3

# 连接本地 SQLite 数据库
db_path = r"${localDbPath || 'your_database.db'}"
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Excel/CSV 文件路径（请修改为你的实际路径）
file_path = r"C:\\Users\\YourName\\Desktop\\your_file.xlsx"

# 读取表格数据
df = pd.read_excel(file_path)  # CSV 请用 pd.read_csv(file_path)

# 字段映射：表格列名 → 数据库列名
column_mapping = {
${mappingCode}
}

# 重命名列
df = df.rename(columns=column_mapping)

# 只保留数据库中存在的列
db_columns = [${schema.map((c) => `"${c.name}"`).join(", ")}]
df = df[[col for col in df.columns if col in db_columns]]

# 构建 INSERT 语句
columns = ", ".join(df.columns)
placeholders = ", ".join(["?"] * len(df.columns))
sql = f"INSERT INTO ${tableName} ({columns}) VALUES ({placeholders})"

# 批量插入
batch_size = 1000
total = len(df)
for i in range(0, total, batch_size):
    batch = df.iloc[i:i+batch_size].values.tolist()
    cursor.executemany(sql, batch)
    conn.commit()
    print(f"已插入 {min(i+batch_size, total)} / {total} 行")

# 通知去表格化助手刷新关联看板
try:
    cursor.execute(
        'INSERT INTO _detabu_refresh_signals (table_name) VALUES (?)',
        ("${tableName}",)
    )
    conn.commit()
    print("📡 已通知看板刷新，5秒内看板将自动更新")
except Exception as e:
    print(f"⚠️ 刷新通知失败（可忽略）: {e}")

cursor.close()
conn.close()
print("✅ 数据导入完成！")
`;
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(generatePythonCode()).then(() => {
      setCopied(true);
      toast.success("代码已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const addMapping = () => {
    setMappings([...mappings, { excel_col: "", db_col: "" }]);
  };

  const removeMapping = (index: number) => {
    setMappings(mappings.filter((_, i) => i !== index));
  };

  const updateMapping = (
    index: number,
    field: keyof ColumnMapping,
    value: string
  ) => {
    const updated = [...mappings];
    updated[index] = { ...updated[index], [field]: value };
    setMappings(updated);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Code className="h-5 w-5" />
            生成 Python 调用代码 — {tableName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 p-3 rounded-md">
            <span>本地数据库: {localDbPath || "加载中..."}</span>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">字段映射（Excel列 → 数据库列）</label>
              <div className="flex items-center gap-2">
                {hasSaved && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-slate-500"
                    onClick={() => {
                      const auto = schema.map((col) => ({
                        excel_col: col.name,
                        db_col: col.name,
                      }));
                      setMappings(auto);
                      setHasSaved(false);
                    }}
                  >
                    重置为默认
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={addMapping}>
                  + 添加映射
                </Button>
              </div>
            </div>
            {hasSaved && (
              <div className="text-xs text-emerald-700 bg-emerald-50 px-2 py-1 rounded">
                已加载该表的"保存为默认映射配置"，生成代码会按这套映射重命名 Excel 列。
              </div>
            )}
            {mappings.map((mapping, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  className="flex-1 h-8 rounded border px-2 text-sm"
                  placeholder="Excel列名"
                  value={mapping.excel_col}
                  onChange={(e) => updateMapping(index, "excel_col", e.target.value)}
                />
                <span className="text-slate-400">→</span>
                <select
                  className="flex-1 h-8 rounded border px-2 text-sm"
                  value={mapping.db_col}
                  onChange={(e) => updateMapping(index, "db_col", e.target.value)}
                >
                  <option value="">选择数据库列</option>
                  {schema.map((col) => (
                    <option key={col.name} value={col.name}>
                      {col.name}
                      {remarks[col.name] ? ` [${remarks[col.name]}]` : ""}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-red-500"
                  onClick={() => removeMapping(index)}
                >
                  ×
                </Button>
              </div>
            ))}
          </div>

          <div className="relative">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">生成的代码</label>
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {copied ? (
                  <>
                    <Check className="mr-1 h-3 w-3" /> 已复制
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-3 w-3" /> 复制
                  </>
                )}
              </Button>
            </div>
            <pre className="bg-slate-900 text-slate-50 p-4 rounded-md text-xs overflow-x-auto max-h-[300px] overflow-y-auto">
              <code>{generatePythonCode()}</code>
            </pre>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
