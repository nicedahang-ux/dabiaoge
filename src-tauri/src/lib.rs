mod bot;
mod chart_gen;
mod server;

use calamine::Reader;
use chrono::{Datelike, Timelike};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Mutex;
use tauri::Emitter;
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct AppConfig {
    pub ai_url: String,
    pub ai_key: String,
    pub ai_model: String,
    pub query_model: String,
    pub ding_app_key: String,
    pub ding_app_secret: String,
}

static CONFIG_CACHE: Lazy<Mutex<AppConfig>> = Lazy::new(|| Mutex::new(AppConfig::default()));

#[derive(Serialize, Deserialize, Clone)]
struct PersistedShareInfo {
    pub board_id: String,
    pub url: String,
    pub pin: String,
    pub port: u16,
    pub allow_refresh: bool,
}

const STORE_PATH: &str = "app_config.bin";
const STORE_KEY: &str = "config";
const SHARE_STORE_KEY: &str = "share_status";

fn app_store(app: &tauri::AppHandle) -> Result<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>, String> {
    tauri_plugin_store::StoreBuilder::new(app, STORE_PATH)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let store = app_store(&app)?;
    store.set(STORE_KEY, serde_json::to_value(&config).unwrap());
    store.save().map_err(|e| format!("存储配置失败: {}", e))?;
    // 更新内存缓存
    if let Ok(mut cache) = CONFIG_CACHE.lock() {
        *cache = config;
    }
    Ok(())
}

#[tauri::command]
async fn load_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let store = app_store(&app)?;
    let cfg = match store.get(STORE_KEY) {
        Some(v) => {
            let c: AppConfig = serde_json::from_value(v.clone()).unwrap_or_default();
            c
        }
        None => AppConfig::default(),
    };
    // 更新内存缓存
    if let Ok(mut cache) = CONFIG_CACHE.lock() {
        *cache = cfg.clone();
    }
    Ok(cfg)
}

async fn save_share_status(app: tauri::AppHandle, info: PersistedShareInfo) -> Result<(), String> {
    let store = app_store(&app)?;
    store.set(SHARE_STORE_KEY, serde_json::to_value(&info).unwrap());
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

async fn load_share_status(app: tauri::AppHandle) -> Result<Option<PersistedShareInfo>, String> {
    let store = app_store(&app)?;
    match store.get(SHARE_STORE_KEY) {
        Some(v) => {
            let info: PersistedShareInfo = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
            Ok(Some(info))
        }
        None => Ok(None),
    }
}

async fn clear_share_status(app: tauri::AppHandle) -> Result<(), String> {
    let store = app_store(&app)?;
    store.delete(SHARE_STORE_KEY);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

async fn restart_share_server(
    app: tauri::AppHandle,
    board_id: String,
    allow_refresh: bool,
) -> Result<server::ShareInfo, String> {
    let dashboard = get_dashboard(board_id.clone()).await?;
    let board_data = serde_json::json!({
        "id": dashboard.id,
        "name": dashboard.name,
        "description": dashboard.description,
        "sql_template": dashboard.sql_template,
        "ui_filters": dashboard.ui_filters,
        "charts": dashboard.charts,
        "table_data": dashboard.table_data,
        "source_table": dashboard.source_table,
        "actions": dashboard.actions,
        "summary_cards": dashboard.summary_cards,
        "html_content": dashboard.html_content,
    });
    // 复用持久化的 PIN，让对方设备保存的提取码继续有效
    let existing_pin = load_share_status(app.clone()).await.ok().flatten()
        .filter(|s| s.board_id == board_id)
        .map(|s| s.pin);
    let info = server::start_share_server(board_id.clone(), allow_refresh, board_data, existing_pin).await?;
    let persisted = PersistedShareInfo {
        board_id,
        url: info.url.clone(),
        pin: info.pin.clone(),
        port: info.url.split(':').nth(2).and_then(|s| s.split('/').next()?.parse().ok()).unwrap_or(8080),
        allow_refresh,
    };
    let _ = save_share_status(app, persisted).await;
    Ok(info)
}

#[tauri::command]
async fn test_dingtalk_conn(app: tauri::AppHandle) -> Result<String, String> {
    let config = load_config(app).await?;
    if config.ding_app_key.is_empty() || config.ding_app_secret.is_empty() {
        return Err("请先在系统配置中填写钉钉 AppKey 和 AppSecret".to_string());
    }

    match bot::open_connection(&config).await {
        Ok(_) => Ok("钉钉凭证验证通过，Stream 模式可正常连接".to_string()),
        Err(e) => Err(e),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SheetPreview {
    pub sheet_name: String,
    pub columns: Vec<String>,
    pub preview_data: Vec<Vec<String>>,
    pub is_truncated: bool,
    pub truncated_rows: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ParseExcelResult {
    pub sheets: Vec<SheetPreview>,
}

/// 对字符串进行 XML 文本转义（用于替换 CDATA 内容）
fn xml_escape(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&apos;"),
            _ => result.push(ch),
        }
    }
    result
}

/// 读取 xlsx 文件，移除 sheet XML 中的 CDATA 标记并转义内容后重新打包。
/// 某些 BI 工具导出的 xlsx 使用 inlineStr + CDATA，calamine 无法读取 CDATA 内容，
/// 通过预处理把 <t><![CDATA[内容]]></t> 替换为 <t>转义后的内容</t> 可以解决。
fn remove_cdata_from_xlsx(path: &std::path::Path) -> Result<std::io::Cursor<Vec<u8>>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取 zip 失败: {}", e))?;

    let mut output = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut output);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    // 匹配 <t><![CDATA[...]]></t> 或 <t xml:space="preserve"><![CDATA[...]]></t>
    let cdata_re = regex::Regex::new(r"<t[^>]*><!\[CDATA\[(.*?)\]\]></t>").unwrap();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取 zip 条目失败: {}", e))?;
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        std::io::copy(&mut entry, &mut buf).map_err(|e| format!("复制 zip 内容失败: {}", e))?;

        if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
            let content = String::from_utf8_lossy(&buf);
            let cleaned = cdata_re.replace_all(&content, |caps: &regex::Captures| {
                let text = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let escaped = xml_escape(text);
                format!("<t>{}</t>", escaped)
            });
            writer.start_file(&name, options).map_err(|e| format!("写入 zip 条目失败: {}", e))?;
            writer.write_all(cleaned.as_bytes()).map_err(|e| format!("写入 zip 内容失败: {}", e))?;
        } else {
            writer.start_file(&name, options).map_err(|e| format!("写入 zip 条目失败: {}", e))?;
            writer.write_all(&buf).map_err(|e| format!("写入 zip 内容失败: {}", e))?;
        }
    }

    writer.finish().map_err(|e| format!("完成 zip 写入失败: {}", e))?;
    output.set_position(0);
    Ok(output)
}

#[tauri::command]
async fn parse_excel(path: String) -> Result<ParseExcelResult, String> {
    let path = std::path::Path::new(&path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut sheets: Vec<SheetPreview> = vec![];

    if ext == "csv" {
        let file = std::fs::File::open(path).map_err(|e| {
            if e.to_string().contains("being used") || e.raw_os_error() == Some(32) {
                "文件读取失败，请确保表格已在 WPS/Excel 中关闭".to_string()
            } else {
                format!("文件读取失败: {}", e)
            }
        })?;
        let mut rdr = csv::Reader::from_reader(file);
        let headers = rdr
            .headers()
            .map_err(|e| format!("CSV 解析失败: {}", e))?
            .iter()
            .map(|s| sanitize_col(s))
            .collect::<Vec<_>>();

        let mut preview_data: Vec<Vec<String>> = vec![];
        for result in rdr.records().take(50) {
            let record = result.map_err(|e| format!("CSV 解析失败: {}", e))?;
            preview_data.push(record.iter().map(|s| s.to_string()).collect());
        }

        sheets.push(SheetPreview {
            sheet_name: "Sheet1".to_string(),
            columns: headers,
            preview_data,
            is_truncated: true,
            truncated_rows: 50,
        });
    } else if ext == "xlsx" {
        // 某些 BI 工具导出的 xlsx 使用 inlineStr + CDATA，calamine 无法读取 CDATA 内容。
        // 先预处理移除 CDATA 后读取；如果失败则回退到直接读取。
        let try_parse = |bytes: std::io::Cursor<Vec<u8>>| -> Result<Vec<SheetPreview>, String> {
            let mut workbook = calamine::open_workbook_auto_from_rs(bytes)
                .map_err(|e| format!("Excel 解析失败: {}", e))?;
            let sheet_names = workbook.sheet_names().to_vec();
            let limit = if sheet_names.len() <= 2 { 50 } else { 10 };
            let mut result: Vec<SheetPreview> = vec![];

            for sheet_name in sheet_names {
                let range = workbook
                    .worksheet_range(&sheet_name)
                    .map_err(|e| format!("读取工作表失败: {}", e))?;

                let mut rows = range.rows();

                // 跳过开头完全为空的行，找到第一个有内容的行
                let mut candidate_columns: Vec<String> = vec![];
                while let Some(row) = rows.next() {
                    let parsed: Vec<String> = row.iter().map(|c| sanitize_col(&c.to_string())).collect();
                    if parsed.iter().any(|s| !s.is_empty()) {
                        candidate_columns = parsed;
                        break;
                    }
                }

                // 检测候选行是否像真正的表头：
                // 如果超过 50% 的列是空的，或所有非空列都是纯数字，则认为这不是表头
                let total_cols = candidate_columns.len().max(1);
                let empty_count = candidate_columns.iter().filter(|s| s.is_empty()).count();
                let non_empty: Vec<&String> = candidate_columns.iter().filter(|s| !s.is_empty()).collect();
                let all_numeric = !non_empty.is_empty() && non_empty.iter().all(|s| s.parse::<f64>().is_ok());
                let is_invalid_header = empty_count * 2 > total_cols || all_numeric;

                let (columns, preview_data) = if is_invalid_header && !candidate_columns.is_empty() {
                    // 生成默认列名，并把候选行放回数据预览
                    let generated: Vec<String> = (1..=candidate_columns.len())
                        .map(|i| format!("列{}", i))
                        .collect();
                    let first_row: Vec<String> = candidate_columns.iter().map(|s| s.clone()).collect();
                    let mut data: Vec<Vec<String>> = vec![first_row];
                    for row in rows.take(limit - 1) {
                        data.push(row.iter().map(|c| c.to_string().trim().to_string()).collect());
                    }
                    (generated, data)
                } else {
                    let mut data: Vec<Vec<String>> = vec![];
                    for row in rows.take(limit) {
                        data.push(row.iter().map(|c| c.to_string().trim().to_string()).collect());
                    }
                    (candidate_columns, data)
                };

                result.push(SheetPreview {
                    sheet_name: sheet_name.clone(),
                    columns,
                    preview_data,
                    is_truncated: range.rows().count() > limit,
                    truncated_rows: limit,
                });
            }
            Ok(result)
        };

        // 先尝试预处理（移除 CDATA）后读取
        let cleaned = remove_cdata_from_xlsx(path);
        if let Ok(cursor) = cleaned {
            if let Ok(parsed) = try_parse(cursor) {
                if !parsed.is_empty() && !parsed.iter().all(|s| s.columns.iter().all(|c| c.is_empty())) {
                    sheets = parsed;
                } else if let Ok(raw) = std::fs::read(path) {
                    sheets = try_parse(std::io::Cursor::new(raw))?;
                }
            } else if let Ok(raw) = std::fs::read(path) {
                sheets = try_parse(std::io::Cursor::new(raw))?;
            }
        } else if let Ok(raw) = std::fs::read(path) {
            sheets = try_parse(std::io::Cursor::new(raw))?;
        }
    } else if ext == "xls" {
        let mut workbook = calamine::open_workbook_auto(path)
            .map_err(|e| format!("Excel 解析失败: {}", e))?;
        let sheet_names = workbook.sheet_names().to_vec();
        let limit = if sheet_names.len() <= 2 { 50 } else { 10 };

        for sheet_name in sheet_names {
            let range = workbook
                .worksheet_range(&sheet_name)
                .map_err(|e| format!("读取工作表失败: {}", e))?;

            let mut rows = range.rows();

            // 跳过开头完全为空的行，找到第一个有内容的行
            let mut candidate_columns: Vec<String> = vec![];
            while let Some(row) = rows.next() {
                let parsed: Vec<String> = row.iter().map(|c| sanitize_col(&c.to_string())).collect();
                if parsed.iter().any(|s| !s.is_empty()) {
                    candidate_columns = parsed;
                    break;
                }
            }

            // 检测候选行是否像真正的表头：
            // 如果超过 50% 的列是空的，或所有非空列都是纯数字，则认为这不是表头
            let total_cols = candidate_columns.len().max(1);
            let empty_count = candidate_columns.iter().filter(|s| s.is_empty()).count();
            let non_empty: Vec<&String> = candidate_columns.iter().filter(|s| !s.is_empty()).collect();
            let all_numeric = !non_empty.is_empty() && non_empty.iter().all(|s| s.parse::<f64>().is_ok());
            let is_invalid_header = empty_count * 2 > total_cols || all_numeric;

            let (columns, preview_data) = if is_invalid_header && !candidate_columns.is_empty() {
                // 生成默认列名，并把候选行放回数据预览
                let generated: Vec<String> = (1..=candidate_columns.len())
                    .map(|i| format!("列{}", i))
                    .collect();
                let first_row: Vec<String> = candidate_columns.iter().map(|s| s.clone()).collect();
                let mut data: Vec<Vec<String>> = vec![first_row];
                for row in rows.take(limit - 1) {
                    data.push(row.iter().map(|c| c.to_string().trim().to_string()).collect());
                }
                (generated, data)
            } else {
                let mut data: Vec<Vec<String>> = vec![];
                for row in rows.take(limit) {
                    data.push(row.iter().map(|c| c.to_string().trim().to_string()).collect());
                }
                (candidate_columns, data)
            };

            sheets.push(SheetPreview {
                sheet_name: sheet_name.clone(),
                columns,
                preview_data,
                is_truncated: range.rows().count() > limit,
                truncated_rows: limit,
            });
        }
    } else {
        return Err("仅支持 xlsx/xls/csv 格式文件".to_string());
    }

    Ok(ParseExcelResult { sheets })
}

#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(base64::encode(bytes))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AiFilter {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub filter_type: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AiResponse {
    pub ui_filters: Vec<AiFilter>,
    pub sql_template: String,
    pub charts: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    pub filename: String,
    pub mime_type: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChatMessagePayload {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub attachments: Option<Vec<AttachmentPayload>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TablePreviewPayload {
    pub sheet_name: String,
    pub columns: Vec<String>,
    pub preview_data: Vec<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DbTablePreviewPayload {
    pub table_name: String,
    pub remark: String,
    pub columns: Vec<String>,
    pub preview_data: Vec<Vec<String>>,
    #[serde(default)]
    pub column_remarks: std::collections::HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChatAttachmentPreviewPayload {
    pub file_name: String,
    pub sheet_name: String,
    pub columns: Vec<String>,
    pub preview_data: Vec<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ColumnInfo {
    pub cid: i32,
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub notnull: bool,
    pub dflt_value: Option<String>,
    pub pk: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub rowids: Vec<String>,
    pub primary_key: String,
    #[serde(default)]
    pub total_count: i64,
}

#[derive(Serialize, Clone)]
struct ChatMessage {
    role: String,
    content: serde_json::Value,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessageResp,
}

#[derive(Deserialize)]
struct ChatMessageResp {
    content: String,
}

#[derive(Deserialize)]
struct ChatCompletion {
    choices: Vec<ChatChoice>,
}

const SYSTEM_PROMPT: &str = r#"你是一位专业的数据分析助手。用户会给你一段表格预览数据和自然语言需求，你需要返回一段 JSON，帮助前端动态生成数据看板。

必须严格遵守以下 JSON 格式（不要添加 markdown 代码块标记，直接返回 JSON 字符串）：
{
  "ui_filters": [
    {"id": "字段英文名", "label": "中文标签", "type": "input|select|multi_select|date_range|search", "options": ["选项1","选项2"], "default": "选项1", "target": ["col1","col2"]}
  ],
  "sql_template": "SELECT ... FROM temp_table WHERE 字段 = {{id}} ...",
  "charts": ["pie", "bar", "line", "table"],
  "actions": ["export_csv"],
  "summary_cards": [{"title": "总销售额", "field": "amount", "agg": "sum"}]
}

说明：
- sql_template 中的变量使用 {{id}} 双大括号占位，前端会替换为实际值。
- 表名固定使用 temp_table。
- ui_filters type 可选：input（文本）、select（单选下拉）、multi_select（多选复选框，值用逗号分隔）、date_range（日期范围，会在 SQL 中生成 {{id}}_start 和 {{id}}_end 两个变量）、search（模糊搜索）。
- select / multi_select 的 options 从数据中该字段的去重值推断，也可不写options由前端自动生成。
- charts 数组决定前端渲染哪些图表，可选 pie、bar、line、table。
- actions 可选 export_csv、export_excel，前端会渲染对应导出按钮。
- summary_cards 定义顶部统计卡片，agg 支持 sum、avg、count、max、min。
- 仅返回 JSON，不要任何解释文字。
"#;

const WORKBENCH_SYSTEM_PROMPT: &str = r#"你是一位数据看板设计与可视化开发专家。用户会上传表格数据或选择已有数据库表，并与你对话。
你的任务是：
1. 理解用户的数据结构与字段含义（含中文备注）
2. 设计可视化方案（图表选型、聚合维度、筛选器布局、汇总卡片）
3. 当用户需求清晰、可以输出看板时，**直接产出一段完整可运行的 HTML 文档作为最终交付物**

【输出格式 — 强制规则】
1. 创建看板时，必须在回复**最末尾**输出一个完整的 HTML 代码块，使用三个反引号 + html 标记包裹：
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>...</head>
<body>...</body>
</html>
```
2. 系统只识别 ```html 代码块（小写 html），不识别其他语言标记或纯文本。
3. HTML 必须是**完整文档**，含 <!DOCTYPE html>、<html>、<head>、<body>，不能是片段。
4. 严禁输出任何 JSON action（如 {"action":"create_dashboard"} ），系统已不再支持 JSON 流程。
5. 解释性文字可以放在 HTML 代码块之前，但 HTML 必须是整段回复**最后**一个代码块。

【HTML 数据接入约定 — 必须严格遵守】
渲染时后端会自动把源数据表的全部行注入到 window.__dashboardData（数组，每个元素**同时**带英文列名 key 和中文备注 key——只要列有中文备注，那一行就既能 row["order_date"] 也能 row["下单日期"] 取到值），并尝试调用 runAnalysisLogic(anchorId)。所以：
1. 在 <script> 中**必须定义** window.rawExcelData 与 runAnalysisLogic(anchorId) 函数：
   - 函数内读取 window.__dashboardData（fallback 到 window.rawExcelData）作为数据源；
   - 函数负责把数据计算成 ECharts option 并渲染到对应的 DOM 容器；
   - 函数还应处理筛选器变化（绑定 change/input 事件后再次调用自身或一个 reRender 子函数）。
2. 提供一个 <input id="anchorId" type="hidden"> 作为兼容字段（系统会写入值，可不读取）。
3. 不要在 HTML 中硬编码示例数据用于生产展示（仅可作为兜底；正式数据由 __dashboardData 提供）。
4. 通过 CDN 引入 ECharts 5：<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>。
5. 数据 key 任选一种风格即可：**优先使用英文原列名**（与 preview 的 columns / column_remarks key 完全一致，最不易出错）；如果你想用中文 key 必须使用 column_remarks 给出的精确中文备注，**禁止根据列含义自行编造中文名**（编出来的 key 数据里没有，图表会空）。同一份 HTML 内 key 风格保持一致。

【HTML 设计建议】
- 推荐结构：顶部统计卡片区 → 筛选区（select / 日期范围 / 搜索）→ 主图表网格（2~4 张图）→ 明细表格（可选）。
- 样式：使用 inline <style> 写简洁、专业的 CSS（建议浅色卡片 + 轻量阴影 + 圆角），避免引入外部 CSS 框架。
- 全文中文，文案专业、有数据可观察的洞察提示。
- 图表选型基于业务：分类对比用柱状/条形，趋势用折线/面积，构成用饼/环，分布用散点/直方。

【SQL / 计算约定】
- 所有聚合、筛选都在前端 JS 中完成（基于 __dashboardData 数组），不需要写 SQL。
- 数值字段在 __dashboardData 中是字符串，请使用 Number(x) 或 parseFloat 做转换。
- 日期字段也是字符串，建议用 new Date(x) 或字符串比较处理。

【交互节奏】
- 如果用户需求清晰，可以直接给出 HTML 代码块。
- 如果模糊，先用【关键提问】引导（见交互引导模式提示），但**最终一定要输出完整 HTML 代码块**。
"#;

const THOUGHT_GUIDE_SYSTEM_PROMPT: &str = r#"# Role
你现在处于特殊的【交互引导模式】。你的名字是小妮。面对用户丢过来的模糊问题或一句话需求，你现在的座右铭是：“需求不清晰，看板/分析跑偏一万米”。

# Core Directive (核心行为准则)
1. 绝对不要急于给最终答案：当用户开启此模式时，说明他们自己也没完全想清楚。你必须先压制住"立刻回答"的冲动。
2. 剥洋葱式提问：仔细阅读用户输入，思考在业务逻辑、可视化目标、数据维度或受众场景上还有哪些关键信息缺失。
3. 提问数量限制：每次回复向用户抛出 1 到 5 个最核心的澄清问题（不超过 5 个），并等待用户回答。
4. 允许连问：如果用户回答后你认为依然有逻辑漏洞或关键细节缺失，可以继续提问。轮次没有硬上限，由你自行判断；但**一旦信息齐全就要立刻闭环**，不要为了提问而提问。
5. 闭环输出：只有当你确信已经掌握 100% 必要信息后，才正式结束提问，并给出**一段完整可运行的 HTML 看板代码块**作为最终交付物。

# Tone & Style (语气与风格)
- 保持理性、专业，分析模糊需求时不卖弄术语。
- 提问要一针见血：每个问题都直击痛点，不要废话。

# Interaction Format (交互格式标准)
当本轮还要继续追问时，**必须**带上下面三个中括号小节，缺一不可：
1. 【诊断反馈】：用一两句话总结你对当前需求的"体检报告"（哪里太虚、哪里没兜底）。
2. 【关键提问】：使用编号列表（1, 2, 3...）列出你的问题，最多 5 个。每个问题附带 A/B/C/D 选项（单行排列，如 A. 选项一 B. 选项二 C. 选项三）；不适合出选项时也至少给 2 个常见选项加"其它"。
3. 【提醒】：温和提醒用户回复你的问题。

当**已经收集到足够信息、可以输出最终方案**时，不再写以上三个小节，而是：
- 简短一两句话说明你的设计思路（聚焦哪些指标、用哪些图表）；
- 在回复**最末尾**输出一段**完整可运行的 HTML 看板代码块**：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>看板标题</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <style>/* 简洁专业的样式 */</style>
</head>
<body>
  <input id="anchorId" type="hidden" />
  <!-- 顶部统计卡片 / 筛选器 / 主图表 / 明细表 -->
  <script>
    window.rawExcelData = window.rawExcelData || [];
    function runAnalysisLogic(anchorId) {
      const data = (window.__dashboardData && window.__dashboardData.length)
        ? window.__dashboardData
        : window.rawExcelData;
      // 基于 data 计算并渲染所有图表
    }
  </script>
</body>
</html>
```

【输出 HTML 时的硬规则】
- 必须使用 ```html 代码块包裹（系统只识别小写 html 标记）。
- 必须是完整 <!DOCTYPE html> 文档，不能是片段。
- 必须定义 window.rawExcelData 与 runAnalysisLogic(anchorId)，因为系统会自动注入 window.__dashboardData 并尝试调用此函数。
- 数据 key 使用**英文原列名**（推荐，最稳）或 column_remarks 给出的**精确中文备注**（不要自行根据含义造中文名，造出来的 key 数据里没有）。整份 HTML 用统一一种风格。
- 数值字段是字符串，需用 Number() / parseFloat 转换。
- 严禁输出任何 JSON action（如 {"action":"create_dashboard"}），系统已废弃 JSON 流程。

【绝对红线】
- 不要在带【关键提问】的回复里输出 HTML 代码块。
- 不要把 HTML 代码块的内容塞进【诊断反馈】或【关键提问】里。
- 输出 HTML 后再补一句"如需调整告诉我"即可，不要再追加问题。
"#;

const MODIFICATION_SYSTEM_PROMPT: &str = r#"你是一位数据看板修改专家。用户正在修改一个已有的数据看板，并已把当前看板的 HTML 源码与源数据预览随请求一并提供给你。

【数据保护 — 绝对禁止】
1. 严禁清空或替换用户的源数据库数据。
2. 你没有权限删除数据库中的任何记录。
3. 不要修改数据 key 的中文列名（必须与原版一致，否则数据注入会失效）。

【输出格式 — 强制规则】
1. 在分析用户的修改需求后，**始终输出一段完整可运行的新 HTML 文档**，使用三个反引号 + html 包裹：
```html
<!DOCTYPE html>
<html lang="zh-CN">
...
</html>
```
2. **必须**输出完整 HTML，不能输出 diff、片段或"在原 HTML 第 X 行加 Y"。
3. 严禁输出 JSON action（如 {"action":"update_dashboard"}），系统已废弃 JSON 流程。
4. 严禁使用其他语言标记（如 ```javascript 单独片段）替代完整 HTML。
5. 解释性文字可以放在 HTML 代码块之前，但 HTML 代码块必须是整段回复**最后**一个代码块。
6. 如果用户只是闲聊或没有明确的修改需求，**不要**输出 HTML 代码块，只回复文字即可。

【保留约定 — 必须保留】
新 HTML 必须保持以下要素，否则看板无法正常渲染：
- 完整 <!DOCTYPE html> 文档结构。
- 通过 CDN 引入 ECharts 5（https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js）。
- <input id="anchorId" type="hidden"> 兼容字段。
- 定义 window.rawExcelData（默认值 []）。
- 定义 runAnalysisLogic(anchorId) 函数：内部应优先读 window.__dashboardData，回退到 window.rawExcelData，并据此重渲染所有图表与表格。
- 数据 key 使用与原 HTML **完全一致**的命名（原版用英文 key 就继续用英文，原版用中文 key 就继续用对应中文备注），禁止换风格——换了 key 数据立刻读不到。

【修改建议】
- 优先在原 HTML 基础上做最小改动：保留布局骨架与 DOM ID，只替换图表逻辑或样式。
- 如果用户只要"把饼图改成柱状图"这种局部需求，不要顺手重写其它部分。
- 数值字段在 __dashboardData 中是字符串，记得用 Number() / parseFloat 转换再聚合。
- 全文中文，UI 风格保持简洁专业。
"#;

#[tauri::command]
async fn chat_with_ai(
    app: tauri::AppHandle,
    prompt: String,
    preview_data: Vec<Vec<String>>,
    thought_guide_mode: Option<bool>,
) -> Result<AiResponse, String> {
    let config = load_config(app).await?;

    if config.ai_url.is_empty() || config.ai_key.is_empty() {
        return Err("请先配置 AI 接口地址和 API Key".to_string());
    }

    let preview_json = serde_json::to_string(&preview_data).unwrap_or_default();
    let user_content = format!(
        "表格预览数据（前若干行）:\n{}\n\n用户需求:\n{}",
        preview_json, prompt
    );

    let system_content = if thought_guide_mode.unwrap_or(false) {
        THOUGHT_GUIDE_SYSTEM_PROMPT.to_string()
    } else {
        SYSTEM_PROMPT.to_string()
    };

    let client = reqwest::Client::new();
    let url = if config.ai_url.ends_with("/v1/chat/completions") {
        config.ai_url.clone()
    } else if config.ai_url.ends_with("/v1") {
        format!("{}/chat/completions", config.ai_url)
    } else if config.ai_url.ends_with("/") {
        format!("{}v1/chat/completions", config.ai_url)
    } else {
        format!("{}/v1/chat/completions", config.ai_url)
    };

    let req_body = ChatRequest {
        model: if config.ai_model.is_empty() {
            "deepseek-chat".to_string()
        } else {
            config.ai_model
        },
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: serde_json::Value::String(system_content),
            },
            ChatMessage {
                role: "user".to_string(),
                content: serde_json::Value::String(user_content),
            },
        ],
        temperature: 0.2,
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.ai_key))
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("请求 AI 接口失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("AI 接口返回错误 {}: {}", status, text));
    }

    let completion: ChatCompletion = resp
        .json()
        .await
        .map_err(|e| format!("解析 AI 响应失败: {}", e))?;

    let content = completion
        .choices
        .get(0)
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let ai_resp: AiResponse = serde_json::from_str(cleaned)
        .map_err(|e| format!("AI 返回格式不符合预期: {}\n原始内容: {}", e, content))?;

    Ok(ai_resp)
}

#[tauri::command]
async fn chat_workbench(
    app: tauri::AppHandle,
    messages: Vec<ChatMessagePayload>,
    table_preview: Option<Vec<TablePreviewPayload>>,
    db_table_previews: Option<Vec<DbTablePreviewPayload>>,
    chat_attachment_previews: Option<Vec<ChatAttachmentPreviewPayload>>,
    thought_guide_mode: Option<bool>,
    modifying_dashboard: Option<bool>,
) -> Result<String, String> {
    let start = std::time::Instant::now();
    println!("[chat_workbench] ========== AI聊天请求开始 ==========");
    println!("[chat_workbench] 用户消息数量: {}", messages.len());
    println!("[chat_workbench] 思维引导模式: {:?}", thought_guide_mode);
    println!("[chat_workbench] 是否有表格预览数据: {}", table_preview.is_some());

    let config = load_config(app).await?;
    println!("[chat_workbench] 配置加载成功");
    println!("[chat_workbench] AI URL: {}", config.ai_url);
    println!("[chat_workbench] AI Model: {}", config.ai_model);
    let key_preview = if config.ai_key.len() > 12 {
        format!("{}...{}", &config.ai_key[..6], &config.ai_key[config.ai_key.len()-4..])
    } else if !config.ai_key.is_empty() {
        "已设置".to_string()
    } else {
        "未设置".to_string()
    };
    println!("[chat_workbench] AI Key: {}", key_preview);

    if config.ai_url.is_empty() || config.ai_key.is_empty() {
        println!("[chat_workbench] 错误: AI配置不完整，URL或Key为空");
        return Err("请先配置 AI 接口地址和 API Key".to_string());
    }

    let mut system_content = if modifying_dashboard.unwrap_or(false) {
        println!("[chat_workbench] 使用【看板修改】系统提示词");
        MODIFICATION_SYSTEM_PROMPT.to_string()
    } else if thought_guide_mode.unwrap_or(true) {
        println!("[chat_workbench] 使用【思维引导】系统提示词");
        THOUGHT_GUIDE_SYSTEM_PROMPT.to_string()
    } else {
        println!("[chat_workbench] 使用【工作台】系统提示词");
        WORKBENCH_SYSTEM_PROMPT.to_string()
    };

    if db_table_previews.is_some() {
        system_content.push_str("\n\n【数据库表查询能力】当前已提供数据库表结构和预览数据。请基于这些预览理解数据并设计可视化方案；最终请直接输出完整 HTML 看板代码块，不要再返回任何 JSON action。");
    }

    let is_modifying = modifying_dashboard.unwrap_or(false);

    let mut chat_messages: Vec<ChatMessage> = vec![ChatMessage {
        role: "system".to_string(),
        content: serde_json::Value::String(system_content),
    }];

    if let Some(previews) = table_preview {
        if !previews.is_empty() {
            let mut table_text = format!("当前已加载 {} 张表格预览数据。当用户提到表格或数据时，请从下方对应表格中查找数据。\n", previews.len());
            for (i, preview) in previews.iter().enumerate() {
                let preview_json = serde_json::to_string(&serde_json::json!({
                    "sheet_name": preview.sheet_name,
                    "columns": preview.columns,
                    "preview_data": preview.preview_data,
                }))
                .unwrap_or_default();
                table_text.push_str(&format!("\n【表格 {}】\n{}\n", i + 1, preview_json));
            }
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: serde_json::Value::String(table_text),
            });
            println!("[chat_workbench] 已注入 {} 张表格预览数据到上下文", previews.len());
        }
    }

    if let Some(db_previews) = db_table_previews {
        for p in &db_previews {
            // 列级中文备注：优先用前端传来的；为空时回退查 DB，避免 AI 看不到列名 → 中文 key 的对应关系
            let column_remarks: std::collections::HashMap<String, String> =
                if !p.column_remarks.is_empty() {
                    p.column_remarks.clone()
                } else {
                    get_column_remarks(p.table_name.clone()).unwrap_or_default()
                };
            let preview_json = serde_json::to_string(&serde_json::json!({
                "table_name": p.table_name,
                "remark": p.remark,
                "columns": p.columns,
                "column_remarks": column_remarks,
                "preview_data": p.preview_data,
            })).unwrap_or_default();
            let header = if is_modifying {
                format!(
                    "【看板关联数据表 {}】这是你当前正在修改的看板所关联的源数据表，必须沿用其列名和数据 key 风格（columns 是英文列名；column_remarks 是 英文列名→中文备注 映射；运行时 window.__dashboardData 的每一行**同时**带英文 key 和中文 key，原 HTML 用哪种就继续用哪种，禁止换风格）:\n",
                    p.table_name
                )
            } else {
                format!(
                    "数据库表 [{}] 预览数据（columns 是英文列名；column_remarks 是 英文列名→中文备注 映射；运行时 window.__dashboardData 的每一行**同时**带英文 key 和中文 key，请任选一种作为数据 key 使用，但同一份 HTML 内必须保持一致）:\n",
                    p.table_name
                )
            };
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: serde_json::Value::String(format!("{}{}", header, preview_json)),
            });
        }
        println!("[chat_workbench] 已注入 {} 张数据库表预览（modify={}）", db_previews.len(), is_modifying);
    }

    if let Some(attach_previews) = chat_attachment_previews {
        let mut attach_text = if is_modifying {
            format!("【本轮新增候选数据】用户在本次修改对话中又上传了 {} 张表格附件，请判断是否需要把它们融入当前看板（仅当用户明确要求或数据明显匹配时才使用）。\n", attach_previews.len())
        } else {
            format!("用户在聊天中上传了 {} 张表格附件。当用户提到某个文件名或 Sheet 名时，请从下方对应附件中查找数据。\n", attach_previews.len())
        };
        for (i, p) in attach_previews.iter().enumerate() {
            let preview_json = serde_json::to_string(&serde_json::json!({
                "文件": p.file_name,
                "sheet": p.sheet_name,
                "列名": p.columns,
                "前20行预览": p.preview_data,
            })).unwrap_or_default();
            attach_text.push_str(&format!("\n【聊天附件 {}】\n{}\n", i + 1, preview_json));
        }
        chat_messages.push(ChatMessage {
            role: "system".to_string(),
            content: serde_json::Value::String(attach_text),
        });
        println!("[chat_workbench] 已注入 {} 张聊天附件表格预览（modify={}）", attach_previews.len(), is_modifying);
    }

    for (i, msg) in messages.iter().enumerate() {
        println!("[chat_workbench] 消息[{}] role={} content_len={} attachments={}", i, msg.role, msg.content.len(), msg.attachments.as_ref().map(|a| a.len()).unwrap_or(0));
        if let Some(attachments) = &msg.attachments {
            let mut parts: Vec<serde_json::Value> = vec![];
            if !msg.content.is_empty() {
                parts.push(serde_json::json!({"type":"text","text":&msg.content}));
            }
            for att in attachments {
                if att.mime_type.starts_with("image/") {
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:{};base64,{}", att.mime_type, att.data)
                        }
                    }));
                } else {
                    parts.push(serde_json::json!({"type":"text","text":format!("【附件: {}】", att.filename)}));
                }
            }
            chat_messages.push(ChatMessage {
                role: msg.role.clone(),
                content: serde_json::Value::Array(parts),
            });
        } else {
            chat_messages.push(ChatMessage {
                role: msg.role.clone(),
                content: serde_json::Value::String(msg.content.clone()),
            });
        }
    }

    // 修改模式最终提醒：放在用户消息之后，最大程度影响AI输出
    if modifying_dashboard.unwrap_or(false) {
        chat_messages.push(ChatMessage {
            role: "system".to_string(),
            content: serde_json::Value::String("【最终提醒】你现在必须在回复最末尾输出一段完整可运行的新 HTML 文档（用 ```html 代码块包裹）。必须保留 window.rawExcelData、runAnalysisLogic(anchorId)、<input id=\"anchorId\">、ECharts CDN，**数据 key 风格与原 HTML 保持完全一致**（原来用英文 key 就继续用英文，用中文备注就继续用同一中文备注，禁止换风格）。严禁输出任何 JSON action，严禁输出片段或 diff，必须是完整 <!DOCTYPE html> 文档。".to_string()),
        });
        println!("[chat_workbench] 已注入修改模式最终提醒");
    }

    let client = reqwest::Client::new();
    let url = if config.ai_url.ends_with("/v1/chat/completions") {
        config.ai_url.clone()
    } else if config.ai_url.ends_with("/v1") {
        format!("{}/chat/completions", config.ai_url)
    } else if config.ai_url.ends_with("/") {
        format!("{}v1/chat/completions", config.ai_url)
    } else {
        format!("{}/v1/chat/completions", config.ai_url)
    };
    println!("[chat_workbench] 构建请求URL: {}", url);

    let model = if config.ai_model.is_empty() {
        "deepseek-chat".to_string()
    } else {
        config.ai_model.clone()
    };
    println!("[chat_workbench] 使用模型: {}", model);
    println!("[chat_workbench] 总消息数(含system): {}", chat_messages.len());

    let req_body = ChatRequest {
        model,
        messages: chat_messages,
        temperature: 0.3,
    };

    println!("[chat_workbench] >>> 正在发送HTTP POST请求到AI服务...");
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.ai_key))
        .json(&req_body)
        .send()
        .await
        .map_err(|e| {
            println!("[chat_workbench] 请求发送失败: {}", e);
            format!("请求 AI 接口失败: {}", e)
        })?;

    let status = resp.status();
    println!("[chat_workbench] 收到HTTP响应，状态码: {}", status);

    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        println!("[chat_workbench] AI接口返回错误: status={} body={}", status, text);
        return Err(format!("AI 接口返回错误 {}: {}", status, text));
    }

    println!("[chat_workbench] 响应状态成功，正在解析JSON...");
    let completion: ChatCompletion = resp
        .json()
        .await
        .map_err(|e| {
            println!("[chat_workbench] JSON解析失败: {}", e);
            format!("解析 AI 响应失败: {}", e)
        })?;

    let content = completion
        .choices
        .get(0)
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    let elapsed = start.elapsed();
    println!("[chat_workbench] 响应内容长度: {} 字符", content.len());
    println!("[chat_workbench] 请求总耗时: {:.3}秒", elapsed.as_secs_f64());
    println!("[chat_workbench] ========== AI聊天请求完成 ==========");

    Ok(content)
}

fn db_path() -> Result<std::path::PathBuf, String> {
    let mut path = dirs::data_dir().ok_or("无法获取数据目录")?;
    path.push("ai_dashboard");
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {}", e))?;
    path.push("data.db");
    Ok(path)
}

fn migrate_chat_sessions(conn: &rusqlite::Connection) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_sessions'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if exists {
        let has_id: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('chat_sessions') WHERE name='id'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);

        if !has_id {
            conn.execute("ALTER TABLE chat_sessions RENAME TO chat_sessions_old", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DROP TABLE chat_sessions_old", [])
                .map_err(|e| e.to_string())?;
        }
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '新对话',
            messages TEXT NOT NULL,
            thought_guide_mode INTEGER NOT NULL DEFAULT 1,
            token_count INTEGER NOT NULL DEFAULT 0,
            dashboard_id TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn init_db() -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(db_path()?).map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS kb_docs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            content TEXT NOT NULL,
            description TEXT,
            dashboard_links TEXT,
            vec BLOB NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 迁移：添加 description 和 dashboard_links 列
    let _ = conn.execute("ALTER TABLE kb_docs ADD COLUMN description TEXT", []);
    let _ = conn.execute("ALTER TABLE kb_docs ADD COLUMN dashboard_links TEXT", []);

    migrate_chat_sessions(&conn)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS bot_chat_memory (
            user_id TEXT PRIMARY KEY,
            messages TEXT NOT NULL,
            last_time TEXT DEFAULT CURRENT_TIMESTAMP,
            round_count INTEGER DEFAULT 0
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 迁移：添加 round_count 列
    let _ = conn.execute("ALTER TABLE bot_chat_memory ADD COLUMN round_count INTEGER DEFAULT 0", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS dashboards (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            sql_template TEXT,
            ui_filters TEXT,
            charts TEXT,
            table_data TEXT,
            source_table TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 迁移：按需添加 dashboards 缺失列（先检查再添加，避免失败被静默忽略）
    let mut existing_cols: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stmt = conn.prepare("PRAGMA table_info(dashboards)").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let name: String = row.get("name")?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;
    for name in rows {
        if let Ok(n) = name {
            existing_cols.insert(n);
        }
    }
    drop(stmt);

    let needed_cols = vec![
        ("source_table", "TEXT"),
        ("actions", "TEXT"),
        ("summary_cards", "TEXT"),
        ("html_content", "TEXT"),
        ("source_type", "TEXT"),
        ("dingtalk_doc_url", "TEXT"),
        ("dingtalk_doc_id", "TEXT"),
        ("dingtalk_last_sync", "TEXT"),
        ("dingtalk_operator_id", "TEXT"),
    ];
    for (col, typ) in needed_cols {
        if !existing_cols.contains(col) {
            let sql = format!("ALTER TABLE dashboards ADD COLUMN {} {}", col, typ);
            if let Err(e) = conn.execute(&sql, []) {
                eprintln!("[DB MIGRATE] 添加 dashboards.{} 失败: {}", col, e);
            } else {
                println!("[DB MIGRATE] 成功添加 dashboards.{} 列", col);
            }
        }
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS table_column_remarks (
            table_name TEXT NOT NULL,
            column_name TEXT NOT NULL,
            remark TEXT NOT NULL DEFAULT '',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (table_name, column_name)
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS table_upload_mappings (
            table_name TEXT PRIMARY KEY,
            mappings TEXT NOT NULL DEFAULT '[]',
            auto_clean INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS dashboard_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dashboard_id TEXT NOT NULL,
            sql_template TEXT,
            ui_filters TEXT,
            charts TEXT,
            actions TEXT,
            summary_cards TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS table_remarks (
            table_name TEXT PRIMARY KEY,
            remark TEXT NOT NULL DEFAULT '',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 外部Python入库后的刷新信号表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _detabu_refresh_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 看板创建失败暂存表（HTML 不丢，可重试 / 导出 / 删除）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS pending_dashboards (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            html_content TEXT NOT NULL,
            new_files TEXT NOT NULL DEFAULT '[]',
            existing_tables TEXT NOT NULL DEFAULT '[]',
            source TEXT NOT NULL DEFAULT 'ai_html',
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 看板定时任务表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS dashboard_schedules (
            id TEXT PRIMARY KEY,
            dashboard_id TEXT NOT NULL,
            prompt TEXT NOT NULL DEFAULT '',
            schedule_type TEXT NOT NULL,
            schedule_config TEXT NOT NULL DEFAULT '{}',
            webhook_url TEXT NOT NULL DEFAULT '',
            phone_number TEXT NOT NULL DEFAULT '',
            task_type TEXT NOT NULL DEFAULT 'analysis',
            sync_mode TEXT NOT NULL DEFAULT 'overwrite',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 看板定时任务执行日志表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS dashboard_schedule_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            schedule_id TEXT NOT NULL,
            status TEXT NOT NULL,
            result TEXT,
            error TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 迁移：为 dashboard_schedules 表添加 task_type 和 sync_mode 字段
    let schedule_cols = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(dashboard_schedules)")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok())
            .collect::<std::collections::HashSet<String>>()
    };
    for (col, typ) in [("task_type", "TEXT"), ("sync_mode", "TEXT"), ("phone_number", "TEXT NOT NULL DEFAULT ''")] {
        if !schedule_cols.contains(col) {
            let sql = format!("ALTER TABLE dashboard_schedules ADD COLUMN {} {}", col, typ);
            if let Err(e) = conn.execute(&sql, []) {
                eprintln!("[DB MIGRATE] 添加 dashboard_schedules.{} 失败: {}", col, e);
            }
        }
    }

    Ok(conn)
}

// ========== Session Commands ==========

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub messages: Vec<ChatMessagePayload>,
    pub thought_guide_mode: bool,
    pub token_count: i32,
    pub dashboard_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
async fn create_session(title: Option<String>, thought_guide_mode: Option<bool>, dashboard_id: Option<String>) -> Result<String, String> {
    let conn = init_db()?;
    let id = Uuid::new_v4().to_string();
    let title = title.unwrap_or_else(|| "新对话".to_string());
    let tgm = if thought_guide_mode.unwrap_or(true) { 1 } else { 0 };
    let messages_json = serde_json::to_string(&Vec::<ChatMessagePayload>::new()).unwrap_or_default();

    conn.execute(
        "INSERT INTO chat_sessions (id, title, messages, thought_guide_mode, token_count, dashboard_id) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        rusqlite::params![id, title, messages_json, tgm, dashboard_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
async fn get_sessions() -> Result<Vec<Session>, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare("SELECT id, title, messages, thought_guide_mode, token_count, dashboard_id, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let messages_json: String = row.get(2)?;
            let messages: Vec<ChatMessagePayload> = serde_json::from_str(&messages_json).unwrap_or_default();
            Ok(Session {
                id: row.get(0)?,
                title: row.get(1)?,
                messages,
                thought_guide_mode: row.get::<_, i32>(3)? != 0,
                token_count: row.get(4)?,
                dashboard_id: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut sessions: Vec<Session> = vec![];
    for row in rows {
        sessions.push(row.map_err(|e| e.to_string())?);
    }
    Ok(sessions)
}

#[tauri::command]
async fn get_session(session_id: String) -> Result<Session, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare("SELECT id, title, messages, thought_guide_mode, token_count, dashboard_id, created_at, updated_at FROM chat_sessions WHERE id = ?1")
        .map_err(|e| e.to_string())?;

    let row = stmt
        .query_row([session_id], |row| {
            let messages_json: String = row.get(2)?;
            let messages: Vec<ChatMessagePayload> = serde_json::from_str(&messages_json).unwrap_or_default();
            Ok(Session {
                id: row.get(0)?,
                title: row.get(1)?,
                messages,
                thought_guide_mode: row.get::<_, i32>(3)? != 0,
                token_count: row.get(4)?,
                dashboard_id: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(row)
}

#[tauri::command]
async fn update_session(session_id: String, messages: Vec<ChatMessagePayload>, token_count: Option<i32>, title: Option<String>, thought_guide_mode: Option<bool>) -> Result<(), String> {
    let conn = init_db()?;
    let messages_json = serde_json::to_string(&messages).unwrap_or_default();

    let (current_title, current_tgm, current_tc): (String, i32, i32) = conn.query_row(
        "SELECT title, thought_guide_mode, token_count FROM chat_sessions WHERE id = ?1",
        [&session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|e| e.to_string())?;

    let new_title = title.unwrap_or(current_title);
    let new_tgm = thought_guide_mode.map(|v| if v { 1 } else { 0 }).unwrap_or(current_tgm);
    let new_tc = token_count.unwrap_or(current_tc);

    conn.execute(
        "UPDATE chat_sessions SET messages = ?1, token_count = ?2, title = ?3, thought_guide_mode = ?4, updated_at = CURRENT_TIMESTAMP WHERE id = ?5",
        rusqlite::params![messages_json, new_tc, new_title, new_tgm, session_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_session(session_id: String) -> Result<(), String> {
    let conn = init_db()?;
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", [session_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ========== Dashboard Commands ==========

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub sql_template: Option<String>,
    pub ui_filters: Option<String>,
    pub charts: Option<String>,
    pub table_data: Option<String>,
    pub source_table: Option<String>,
    pub actions: Option<String>,
    pub summary_cards: Option<String>,
    pub html_content: Option<String>,
    pub source_type: Option<String>,
    pub dingtalk_doc_url: Option<String>,
    pub dingtalk_doc_id: Option<String>,
    pub dingtalk_last_sync: Option<String>,
    pub dingtalk_operator_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
async fn create_dashboard(
    name: String,
    description: Option<String>,
    sql_template: Option<String>,
    ui_filters: Option<String>,
    charts: Option<String>,
    table_data: Option<String>,
    source_table: Option<String>,
    actions: Option<String>,
    summary_cards: Option<String>,
    html_content: Option<String>,
    source_type: Option<String>,
    dingtalk_doc_url: Option<String>,
    dingtalk_doc_id: Option<String>,
) -> Result<String, String> {
    let conn = init_db()?;
    let id = Uuid::new_v4().to_string();

    conn.execute(
        "INSERT INTO dashboards (id, name, description, sql_template, ui_filters, charts, table_data, source_table, actions, summary_cards, html_content, source_type, dingtalk_doc_url, dingtalk_doc_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![id, name, description, sql_template, ui_filters, charts, table_data, source_table, actions, summary_cards, html_content, source_type, dingtalk_doc_url, dingtalk_doc_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
async fn get_dashboards() -> Result<Vec<Dashboard>, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare("SELECT id, name, description, sql_template, ui_filters, charts, table_data, source_table, actions, summary_cards, html_content, source_type, dingtalk_doc_url, dingtalk_doc_id, dingtalk_last_sync, dingtalk_operator_id, created_at, updated_at FROM dashboards ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Dashboard {
                id: row.get("id")?,
                name: row.get("name")?,
                description: row.get("description")?,
                sql_template: row.get("sql_template")?,
                ui_filters: row.get("ui_filters")?,
                charts: row.get("charts")?,
                table_data: row.get("table_data")?,
                source_table: row.get("source_table")?,
                actions: row.get("actions")?,
                summary_cards: row.get("summary_cards")?,
                html_content: row.get("html_content")?,
                source_type: row.get("source_type")?,
                dingtalk_doc_url: row.get("dingtalk_doc_url")?,
                dingtalk_doc_id: row.get("dingtalk_doc_id")?,
                dingtalk_last_sync: row.get("dingtalk_last_sync")?,
                dingtalk_operator_id: row.get("dingtalk_operator_id")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut dashboards: Vec<Dashboard> = vec![];
    for row in rows {
        dashboards.push(row.map_err(|e| e.to_string())?);
    }
    Ok(dashboards)
}

#[tauri::command]
async fn get_dashboard(id: String) -> Result<Dashboard, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare("SELECT id, name, description, sql_template, ui_filters, charts, table_data, source_table, actions, summary_cards, html_content, source_type, dingtalk_doc_url, dingtalk_doc_id, dingtalk_last_sync, dingtalk_operator_id, created_at, updated_at FROM dashboards WHERE id = ?1")
        .map_err(|e| e.to_string())?;

    let row = stmt
        .query_row([id], |row| {
            Ok(Dashboard {
                id: row.get("id")?,
                name: row.get("name")?,
                description: row.get("description")?,
                sql_template: row.get("sql_template")?,
                ui_filters: row.get("ui_filters")?,
                charts: row.get("charts")?,
                table_data: row.get("table_data")?,
                source_table: row.get("source_table")?,
                actions: row.get("actions")?,
                summary_cards: row.get("summary_cards")?,
                html_content: row.get("html_content")?,
                source_type: row.get("source_type")?,
                dingtalk_doc_url: row.get("dingtalk_doc_url")?,
                dingtalk_doc_id: row.get("dingtalk_doc_id")?,
                dingtalk_last_sync: row.get("dingtalk_last_sync")?,
                dingtalk_operator_id: row.get("dingtalk_operator_id")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(row)
}

#[tauri::command]
async fn render_html_dashboard(dashboard_id: String) -> Result<String, String> {
    let dashboard = get_dashboard(dashboard_id).await?;
    let html_content = dashboard.html_content.ok_or("看板没有 HTML 内容")?;
    let source_table = dashboard.source_table.ok_or("看板没有关联数据表")?;

    // 1. 获取列备注（中文列名映射）
    let remarks = get_column_remarks(source_table.clone())?;

    // 2. 查询全量数据
    let sql = format!(r#"SELECT * FROM "{}""#, source_table);
    let query_result = run_sql_query(&sql)?;

    // 3. 转换数据格式：每行同时带英文列名 key 和中文备注 key（如果该列有中文备注），
    //    避免 AI 生成的 HTML 不知道用英文还是中文 key 时数据落空。
    let mut data: Vec<serde_json::Map<String, serde_json::Value>> = Vec::with_capacity(query_result.rows.len());
    for row in &query_result.rows {
        let mut obj = serde_json::Map::new();
        for (i, col) in query_result.columns.iter().enumerate() {
            let val = row.get(i).cloned().unwrap_or_default();
            // 英文原列名 key（始终写入）
            obj.insert(col.clone(), serde_json::Value::String(val.clone()));
            // 中文备注 key（存在且与英文名不同才写入，避免覆盖）
            if let Some(chinese_name) = remarks.get(col) {
                if chinese_name != col && !chinese_name.is_empty() {
                    obj.insert(chinese_name.clone(), serde_json::Value::String(val));
                }
            }
        }
        data.push(obj);
    }

    // 4. 处理 HTML：注入 CSS + 数据 + 自动执行脚本
    let mut html = html_content;

    let hide_css = r#"<style>
      .container > .card:first-of-type { display: none !important; }
      #filterCard { display: block !important; }
      #chartsCard { display: flex !important; }
      #tableCard { display: block !important; }
    </style>"#;
    html = html.replace("</head>", &format!("{}</head>", hide_css));

    let data_json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    let data_script = format!(
        r#"<script>
          window.__dashboardData = {};
          window.__anchorId = "IDNDS002";
        </script>"#,
        data_json
    );
    html = html.replace("<body>", &format!("<body>{}", data_script));

    let auto_script = r#"<script>
      (function() {
        if (window.__dashboardData && window.__dashboardData.length > 0) {
          if (typeof rawExcelData !== 'undefined') {
            rawExcelData = window.__dashboardData;
          } else {
            window.rawExcelData = window.__dashboardData;
          }
          var anchorInput = document.getElementById('anchorId');
          if (anchorInput) anchorInput.value = window.__anchorId || 'IDNDS002';
          if (typeof runAnalysisLogic === 'function') {
            runAnalysisLogic(window.__anchorId || 'IDNDS002');
          }
        }
      })();
    </script>"#;
    html = html.replace("</body>", &format!("{}</body>", auto_script));

    Ok(html)
}

#[tauri::command]
fn check_refresh_signals() -> Result<Vec<String>, String> {
    let conn = init_db()?;

    let mut stmt = conn
        .prepare("SELECT DISTINCT table_name FROM _detabu_refresh_signals")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let name: String = row.get(0)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    let mut table_names = Vec::new();
    for row in rows {
        if let Ok(name) = row {
            table_names.push(name);
        }
    }
    drop(stmt);

    conn.execute("DELETE FROM _detabu_refresh_signals", [])
        .map_err(|e| e.to_string())?;

    Ok(table_names)
}

#[tauri::command]
async fn update_dashboard(
    id: String,
    name: Option<String>,
    description: Option<String>,
    sql_template: Option<String>,
    ui_filters: Option<String>,
    charts: Option<String>,
    table_data: Option<String>,
    source_table: Option<String>,
    actions: Option<String>,
    summary_cards: Option<String>,
    html_content: Option<String>,
    source_type: Option<String>,
    dingtalk_doc_url: Option<String>,
    dingtalk_doc_id: Option<String>,
    dingtalk_last_sync: Option<String>,
    dingtalk_operator_id: Option<String>,
) -> Result<(), String> {
    let conn = init_db()?;

    let current: Dashboard = conn.query_row(
        "SELECT id, name, description, sql_template, ui_filters, charts, table_data, source_table, actions, summary_cards, html_content, source_type, dingtalk_doc_url, dingtalk_doc_id, dingtalk_last_sync, dingtalk_operator_id, created_at, updated_at FROM dashboards WHERE id = ?1",
        [&id],
        |row| Ok(Dashboard {
            id: row.get("id")?,
            name: row.get("name")?,
            description: row.get("description")?,
            sql_template: row.get("sql_template")?,
            ui_filters: row.get("ui_filters")?,
            charts: row.get("charts")?,
            table_data: row.get("table_data")?,
            source_table: row.get("source_table")?,
            actions: row.get("actions")?,
            summary_cards: row.get("summary_cards")?,
            html_content: row.get("html_content")?,
            source_type: row.get("source_type")?,
            dingtalk_doc_url: row.get("dingtalk_doc_url")?,
            dingtalk_doc_id: row.get("dingtalk_doc_id")?,
            dingtalk_last_sync: row.get("dingtalk_last_sync")?,
            dingtalk_operator_id: row.get("dingtalk_operator_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        }),
    ).map_err(|e| e.to_string())?;

    // 安全更新：空字符串视为未修改，保留原有数据
    let new_name = name.filter(|s| !s.is_empty()).unwrap_or(current.name.clone());
    let new_description = description.filter(|s| !s.is_empty()).or(current.description.clone());
    let new_sql = sql_template.filter(|s| !s.is_empty()).or(current.sql_template.clone());
    let new_filters = ui_filters.filter(|s| !s.is_empty() && s != "[]").or(current.ui_filters.clone());
    let new_charts = charts.filter(|s| !s.is_empty() && s != "[]").or(current.charts.clone());
    // table_data 保护：只有传入非空且解析后多于1行（表头+数据）才更新
    let new_table_data = table_data.and_then(|s| {
        if s.is_empty() || s == "[]" { return None; }
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&s) {
            if arr.len() > 1 { return Some(s); }
        }
        None
    }).or(current.table_data.clone());
    let new_source_table = source_table.filter(|s| !s.is_empty()).or(current.source_table.clone());
    let new_actions = actions.filter(|s| !s.is_empty() && s != "[]").or(current.actions.clone());
    let new_summary_cards = summary_cards.filter(|s| !s.is_empty() && s != "[]").or(current.summary_cards.clone());
    let new_html_content = html_content.filter(|s| !s.is_empty()).or(current.html_content.clone());
    let new_source_type = source_type.filter(|s| !s.is_empty()).or(current.source_type.clone());
    let new_dingtalk_doc_url = dingtalk_doc_url.filter(|s| !s.is_empty()).or(current.dingtalk_doc_url.clone());
    let new_dingtalk_doc_id = dingtalk_doc_id.filter(|s| !s.is_empty()).or(current.dingtalk_doc_id.clone());
    let new_dingtalk_last_sync = dingtalk_last_sync.filter(|s| !s.is_empty()).or(current.dingtalk_last_sync.clone());
    let new_dingtalk_operator_id = dingtalk_operator_id.filter(|s| !s.is_empty()).or(current.dingtalk_operator_id.clone());

    // 保存快照（只要任一关键字段发生变化）
    let changed = new_sql.as_ref() != current.sql_template.as_ref()
        || new_filters.as_ref() != current.ui_filters.as_ref()
        || new_charts.as_ref() != current.charts.as_ref()
        || new_actions.as_ref() != current.actions.as_ref()
        || new_summary_cards.as_ref() != current.summary_cards.as_ref();
    if changed {
        conn.execute(
            "INSERT INTO dashboard_revisions (dashboard_id, sql_template, ui_filters, charts, actions, summary_cards) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                id,
                current.sql_template,
                current.ui_filters,
                current.charts,
                current.actions,
                current.summary_cards
            ],
        ).map_err(|e| e.to_string())?;
    }

    conn.execute(
        "UPDATE dashboards SET name = ?1, description = ?2, sql_template = ?3, ui_filters = ?4, charts = ?5, table_data = ?6, source_table = ?7, actions = ?8, summary_cards = ?9, html_content = ?10, source_type = ?11, dingtalk_doc_url = ?12, dingtalk_doc_id = ?13, dingtalk_last_sync = ?14, dingtalk_operator_id = ?15, updated_at = CURRENT_TIMESTAMP WHERE id = ?16",
        rusqlite::params![new_name, new_description, new_sql, new_filters, new_charts, new_table_data, new_source_table, new_actions, new_summary_cards, new_html_content, new_source_type, new_dingtalk_doc_url, new_dingtalk_doc_id, new_dingtalk_last_sync, new_dingtalk_operator_id, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn rollback_dashboard(id: String) -> Result<(), String> {
    let conn = init_db()?;
    let rev: (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = conn.query_row(
        "SELECT sql_template, ui_filters, charts, actions, summary_cards FROM dashboard_revisions WHERE dashboard_id = ?1 ORDER BY id DESC LIMIT 1",
        [&id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(|e| format!("没有可回退的快照: {}", e))?;
    conn.execute(
        "UPDATE dashboards SET sql_template = ?1, ui_filters = ?2, charts = ?3, actions = ?4, summary_cards = ?5, updated_at = CURRENT_TIMESTAMP WHERE id = ?6",
        rusqlite::params![rev.0, rev.1, rev.2, rev.3, rev.4, &id],
    ).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM dashboard_revisions WHERE dashboard_id = ?1 AND id = (SELECT MAX(id) FROM dashboard_revisions WHERE dashboard_id = ?1)", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_dashboard(id: String) -> Result<(), String> {
    let conn = init_db()?;
    conn.execute("DELETE FROM dashboards WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM dashboard_revisions WHERE dashboard_id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ========== Dashboard Schedule ==========

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DashboardSchedule {
    pub id: String,
    pub dashboard_id: String,
    pub prompt: String,
    pub schedule_type: String,
    pub schedule_config: String,
    pub webhook_url: String,
    pub phone_number: String,
    pub task_type: String,
    pub sync_mode: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ScheduleConfig {
    pub time: String,
    #[serde(default)]
    pub days: Vec<u8>,
    #[serde(default)]
    pub interval_days: Option<u32>,
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ScheduleLog {
    pub id: i64,
    pub schedule_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
}

#[tauri::command]
async fn create_schedule(
    dashboard_id: String,
    prompt: String,
    schedule_type: String,
    schedule_config: String,
    webhook_url: String,
    phone_number: String,
    task_type: Option<String>,
    sync_mode: Option<String>,
) -> Result<String, String> {
    let conn = init_db()?;
    let id = Uuid::new_v4().to_string();
    let task = task_type.unwrap_or_else(|| "analysis".to_string());
    let sync = sync_mode.unwrap_or_else(|| "overwrite".to_string());
    conn.execute(
        "INSERT INTO dashboard_schedules (id, dashboard_id, prompt, schedule_type, schedule_config, webhook_url, phone_number, task_type, sync_mode, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)",
        rusqlite::params![id, dashboard_id, prompt, schedule_type, schedule_config, webhook_url, phone_number, task, sync],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
async fn update_schedule(
    id: String,
    prompt: String,
    schedule_type: String,
    schedule_config: String,
    webhook_url: String,
    phone_number: String,
    enabled: bool,
    task_type: Option<String>,
    sync_mode: Option<String>,
) -> Result<(), String> {
    let conn = init_db()?;
    let enabled_i = if enabled { 1 } else { 0 };
    let task = task_type.unwrap_or_else(|| "analysis".to_string());
    let sync = sync_mode.unwrap_or_else(|| "overwrite".to_string());
    conn.execute(
        "UPDATE dashboard_schedules SET prompt = ?1, schedule_type = ?2, schedule_config = ?3, webhook_url = ?4, phone_number = ?5, enabled = ?6, task_type = ?7, sync_mode = ?8, updated_at = CURRENT_TIMESTAMP WHERE id = ?9",
        rusqlite::params![prompt, schedule_type, schedule_config, webhook_url, phone_number, enabled_i, task, sync, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_schedule(id: String) -> Result<(), String> {
    let conn = init_db()?;
    conn.execute("DELETE FROM dashboard_schedules WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM dashboard_schedule_logs WHERE schedule_id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_schedules(dashboard_id: Option<String>) -> Result<Vec<DashboardSchedule>, String> {
    let conn = init_db()?;
    let (sql, params): (String, Vec<&dyn rusqlite::ToSql>) = if let Some(did) = &dashboard_id {
        (
            "SELECT id, dashboard_id, prompt, schedule_type, schedule_config, webhook_url, phone_number, task_type, sync_mode, enabled, created_at, updated_at FROM dashboard_schedules WHERE dashboard_id = ?1 ORDER BY updated_at DESC".to_string(),
            vec![did as &dyn rusqlite::ToSql],
        )
    } else {
        (
            "SELECT id, dashboard_id, prompt, schedule_type, schedule_config, webhook_url, phone_number, task_type, sync_mode, enabled, created_at, updated_at FROM dashboard_schedules ORDER BY updated_at DESC".to_string(),
            vec![],
        )
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok(DashboardSchedule {
                id: row.get(0)?,
                dashboard_id: row.get(1)?,
                prompt: row.get(2)?,
                schedule_type: row.get(3)?,
                schedule_config: row.get(4)?,
                webhook_url: row.get(5)?,
                phone_number: row.get(6)?,
                task_type: row.get(7)?,
                sync_mode: row.get(8)?,
                enabled: row.get::<_, i64>(9).map(|v| v == 1).unwrap_or(true),
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut schedules = vec![];
    for row in rows {
        schedules.push(row.map_err(|e| e.to_string())?);
    }
    Ok(schedules)
}

#[tauri::command]
async fn get_schedule_logs(schedule_id: String, limit: Option<i64>) -> Result<Vec<ScheduleLog>, String> {
    let conn = init_db()?;
    let limit = limit.unwrap_or(20);
    let mut stmt = conn
        .prepare("SELECT id, schedule_id, status, result, error, created_at FROM dashboard_schedule_logs WHERE schedule_id = ?1 ORDER BY created_at DESC LIMIT ?2")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![schedule_id, limit], |row| {
            Ok(ScheduleLog {
                id: row.get(0)?,
                schedule_id: row.get(1)?,
                status: row.get(2)?,
                result: row.get(3)?,
                error: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut logs = vec![];
    for row in rows {
        logs.push(row.map_err(|e| e.to_string())?);
    }
    Ok(logs)
}

fn should_run_now(schedule: &DashboardSchedule) -> bool {
    let config: ScheduleConfig = match serde_json::from_str(&schedule.schedule_config) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let now = chrono::Local::now();
    let target_time = match chrono::NaiveTime::parse_from_str(&config.time, "%H:%M") {
        Ok(t) => t,
        Err(_) => return false,
    };

    // 匹配到分钟级别即可（轮询每60秒一次）
    if now.minute() != target_time.minute() || now.hour() != target_time.hour() {
        return false;
    }

    match schedule.schedule_type.as_str() {
        "once" => {
            if let Some(date_str) = config.date {
                if let Ok(target_date) = chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") {
                    return now.date_naive() == target_date;
                }
            }
            false
        }
        "daily" => true,
        "weekly" => {
            let weekday = now.weekday().number_from_monday() as u8;
            config.days.contains(&weekday)
        }
        "monthly" => {
            let day = now.day() as u8;
            config.days.contains(&day)
        }
        "interval" => {
            if let Some(interval) = config.interval_days {
                if interval == 0 {
                    return false;
                }
                // 查询上次成功执行时间
                if let Ok(conn) = init_db() {
                    let last_run: Option<String> = conn
                        .query_row(
                            "SELECT created_at FROM dashboard_schedule_logs WHERE schedule_id = ?1 AND status = 'success' ORDER BY created_at DESC LIMIT 1",
                            [&schedule.id],
                            |row| row.get(0),
                        )
                        .ok();
                    if let Some(last_str) = last_run {
                        if let Ok(last_dt) = chrono::NaiveDateTime::parse_from_str(&last_str, "%Y-%m-%d %H:%M:%S") {
                            let days_since = now.naive_local().signed_duration_since(last_dt).num_days();
                            return days_since >= interval as i64;
                        }
                    } else {
                        // 从未执行过，允许执行
                        return true;
                    }
                }
            }
            false
        }
        _ => false,
    }
}

use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

static RUNNING_SCHEDULES: once_cell::sync::Lazy<Arc<TokioMutex<std::collections::HashSet<String>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(TokioMutex::new(std::collections::HashSet::new())));

fn parse_comma_list(s: &str) -> Vec<String> {
    s.split(|c: char| c == ',' || c == '\n' || c == '\r' || c == ' ' || c == '\t' || c == '；' || c == ';')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

async fn run_schedule_task(_app: tauri::AppHandle, schedule: DashboardSchedule) {
    let schedule_id = schedule.id.clone();
    let dashboard_id = schedule.dashboard_id.clone();
    let prompt = schedule.prompt.clone();
    let webhook_urls = parse_comma_list(&schedule.webhook_url);
    let phone_numbers = parse_comma_list(&schedule.phone_number);
    let task_type = schedule.task_type.clone();
    let sync_mode = schedule.sync_mode.clone();

    println!("[Scheduler] 开始执行任务 {} 看板 {} 类型 {}", schedule_id, dashboard_id, task_type);

    // 1. 获取看板信息
    let dashboard = match get_dashboard(dashboard_id.clone()).await {
        Ok(d) => d,
        Err(e) => {
            let _ = log_schedule_run(&schedule_id, "failed", None, Some(&format!("获取看板失败: {}", e))).await;
            return;
        }
    };

    if task_type == "sync" {
        // ========== 数据同步任务 ==========
        let doc_url = match dashboard.dingtalk_doc_url {
            Some(u) => u,
            None => {
                let _ = log_schedule_run(&schedule_id, "failed", None, Some("看板没有关联钉钉文档")).await;
                return;
            }
        };
        let doc_type = parse_dingtalk_url(&doc_url).map(|(t, _)| t).unwrap_or("sheet");

        let op_id = dashboard.dingtalk_operator_id.clone().unwrap_or_default();

        let token = match get_dingtalk_token_from_config().await {
            Ok(t) => t,
            Err(e) => {
                let _ = log_schedule_run(&schedule_id, "failed", None, Some(&format!("获取Token失败: {}", e))).await;
                return;
            }
        };

        let data = if doc_type == "bitable" {
            if op_id.is_empty() {
                let _ = log_schedule_run(&schedule_id, "failed", None, Some("同步钉钉多维表需要提供 OPERATOR_ID")).await;
                return;
            }
            match fetch_dingtalk_bitable_data(&token, &doc_url, &op_id).await {
                Ok(d) => d,
                Err(e) => {
                    let _ = log_schedule_run(&schedule_id, "failed", None, Some(&format!("获取多维表数据失败: {}", e))).await;
                    return;
                }
            }
        } else {
            match fetch_dingtalk_sheet_data(&token, &doc_url).await {
                Ok(d) => d,
                Err(e) => {
                    let _ = log_schedule_run(&schedule_id, "failed", None, Some(&format!("获取表格数据失败: {}", e))).await;
                    return;
                }
            }
        };

        let table_name = match dashboard.source_table {
            Some(t) => t,
            None => {
                let _ = log_schedule_run(&schedule_id, "failed", None, Some("看板没有关联数据表")).await;
                return;
            }
        };

        let mut conn = match init_db() {
            Ok(c) => c,
            Err(e) => {
                let _ = log_schedule_run(&schedule_id, "failed", None, Some(&format!("数据库连接失败: {}", e))).await;
                return;
            }
        };

        let count = match insert_data_into_table(&mut conn, &table_name, data, &sync_mode, None) {
            Ok(c) => c,
            Err(e) => {
                let _ = log_schedule_run(&schedule_id, "failed", None, Some(&format!("写入数据失败: {}", e))).await;
                return;
            }
        };

        // 更新最后同步时间
        let _ = conn.execute(
            "UPDATE dashboards SET dingtalk_last_sync = datetime('now','localtime') WHERE id = ?1",
            [&dashboard_id],
        );

        let result_msg = format!("同步成功，共写入 {} 条记录 (模式: {})", count, sync_mode);

        // 如果配置了 webhook，发送同步完成通知
        for url in &webhook_urls {
            let notify_md = format!(
                "## 数据同步完成\n\n- 看板：{}\n- 同步模式：{}\n- 写入记录数：{}\n- 同步时间：{}",
                dashboard.name,
                sync_mode,
                count,
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            );
            if let Err(e) = send_dingtalk_webhook(url, &notify_md, &[]).await {
                eprintln!("[Scheduler] 同步通知发送失败: {}", e);
            }
        }
        // 如果配置了手机号，私聊发送同步完成通知
        for phone in &phone_numbers {
            let notify_md = format!(
                "## 数据同步完成\n\n- 看板：{}\n- 同步模式：{}\n- 写入记录数：{}\n- 同步时间：{}",
                dashboard.name,
                sync_mode,
                count,
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            );
            if let Err(e) = send_dingtalk_private_message(phone, &notify_md, &[]).await {
                eprintln!("[Scheduler] 同步私聊通知发送失败: {}", e);
            }
        }

        let _ = log_schedule_run(&schedule_id, "success", Some(&result_msg), None).await;
        println!("[Scheduler] 同步任务 {} 执行成功，写入 {} 条", schedule_id, count);
        return;
    }

    // ========== AI 分析任务 ==========
    // 2. 确定数据源
    let (table_name, data_markdown) = match resolve_dashboard_data(&dashboard, &prompt
    ).await {
        Ok(v) => v,
        Err(e) => {
            let _ = log_schedule_run(&schedule_id, "failed", None, Some(&format!("解析数据失败: {}", e))).await;
            return;
        }
    };

    // 3. 调用 AI 分析
    let analysis_result = match analyze_with_ai(&prompt, &data_markdown, &table_name, None
    ).await {
        Ok(r) => r,
        Err(e) => {
            let _ = log_schedule_run(&schedule_id, "failed", None, Some(&format!("AI分析失败: {}", e))).await;
            return;
        }
    };

    // 4. 生成图表
    let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
    let (content_with_images, image_urls) = match crate::chart_gen::process_tables_into_charts(
        &analysis_result,
        &temp_dir,
    )
    .await
    {
        Ok((content, urls)) => (content, urls),
        Err(e) => {
            eprintln!("[Scheduler] 图表生成失败: {}", e);
            (analysis_result.clone(), vec![])
        }
    };

    // 5. 发送钉钉（Webhook + 私聊）
    let mut send_errors = vec![];

    for url in &webhook_urls {
        if let Err(e) = send_dingtalk_webhook(url, &content_with_images, &image_urls).await {
            send_errors.push(format!("Webhook发送失败: {}", e));
        }
    }

    for phone in &phone_numbers {
        if let Err(e) = send_dingtalk_private_message(phone, &content_with_images, &image_urls).await {
            send_errors.push(format!("私聊发送失败: {}", e));
        }
    }

    if !send_errors.is_empty() {
        let _ = log_schedule_run(
            &schedule_id,
            "failed",
            Some(&analysis_result),
            Some(&send_errors.join("; ")),
        )
        .await;
        return;
    }

    let _ = log_schedule_run(
        &schedule_id,
        "success",
        Some(&analysis_result),
        None,
    )
    .await;
    println!("[Scheduler] 任务 {} 执行成功", schedule_id);
}

async fn log_schedule_run(
    schedule_id: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = init_db()?;
    conn.execute(
        "INSERT INTO dashboard_schedule_logs (schedule_id, status, result, error) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![schedule_id, status, result, error],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn check_and_run_schedules(app: tauri::AppHandle) {
    let schedules = match get_schedules(None).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[Scheduler] 获取定时任务失败: {}", e);
            return;
        }
    };

    let now = chrono::Local::now();
    println!(
        "[Scheduler] {} 检查 {} 个定时任务",
        now.format("%Y-%m-%d %H:%M:%S"),
        schedules.len()
    );

    for schedule in schedules {
        if !schedule.enabled {
            continue;
        }
        if !should_run_now(&schedule) {
            continue;
        }

        let running = RUNNING_SCHEDULES.clone();
        let id = schedule.id.clone();
        {
            let mut set = running.lock().await;
            if set.contains(&id) {
                println!("[Scheduler] 任务 {} 正在执行中，跳过", id);
                continue;
            }
            set.insert(id.clone());
        }

        let app_clone = app.clone();
        let schedule_clone = schedule.clone();
        tauri::async_runtime::spawn(async move {
            run_schedule_task(app_clone, schedule_clone).await;
            let mut set = running.lock().await;
            set.remove(&id);
        });
    }
}

async fn resolve_dashboard_data(
    dashboard: &Dashboard,
    _prompt: &str,
) -> Result<(String, String), String> {
    let conn = init_db()?;

    // 优先使用 source_table
    let table_name = if let Some(ref st) = dashboard.source_table {
        st.clone()
    } else {
        return Err("看板没有关联数据表".to_string());
    };

    // 统计行数列数
    let count_sql = format!("SELECT COUNT(*) FROM \"{}\"", table_name);
    let row_count: i64 = conn
        .query_row(&count_sql, [], |row| row.get(0)
        )
        .map_err(|e| format!("统计行数失败: {}", e))?;

    let col_sql = format!("PRAGMA table_info({})", table_name);
    let mut col_stmt = conn.prepare(&col_sql).map_err(|e| e.to_string())?;
    let col_count = col_stmt.column_count();
    // PRAGMA table_info 返回的是行数，需要用 query_map 统计
    let mut actual_col_count = 0i64;
    let rows = col_stmt.query_map([], |_row| {
        actual_col_count += 1;
        Ok(())
    }).map_err(|e| e.to_string())?;
    for _ in rows {}
    drop(col_stmt);

    println!(
        "[Scheduler] 表 {} 行数: {}, 列数: {}",
        table_name, row_count, actual_col_count
    );

    if row_count <= 50 && actual_col_count <= 30 {
        // 直接获取全部数据
        let sql = format!(r#"SELECT * FROM "{}""#, table_name);
        let query_result = run_sql_query(&sql)?;
        let markdown = query_result_to_markdown(&query_result);
        Ok((table_name, markdown))
    } else {
        // 获取前20行
        let preview_sql = format!(r#"SELECT * FROM "{}" LIMIT 20"#, table_name);
        let preview_result = run_sql_query(&preview_sql)?;
        let preview_md = query_result_to_markdown(&preview_result);
        let schema = collect_schema_summary();
        let context = format!(
            "【表结构说明】\n{}\n\n【数据预览（前20行）】\n{}\n\n请根据用户要求，写SQLite查询语句来分析数据。",
            schema, preview_md
        );
        Ok((table_name, context))
    }
}

fn query_result_to_markdown(result: &QueryResult) -> String {
    let mut lines = vec![];
    lines.push(
        format!("| {} |", result.columns.join(" | ")));
    lines.push(
        format!("|{}|", result.columns.iter().map(|_| " --- ").collect::<Vec<_>>().join("|")),
    );
    for row in &result.rows {
        lines.push(format!("| {} |", row.join(" | ")));
    }
    lines.join("\n")
}

async fn analyze_with_ai(
    prompt: &str,
    data_markdown: &str,
    table_name: &str,
    system_prompt_override: Option<&str>,
) -> Result<String, String> {
    let config = load_config_db()?;
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", config.ai_url.trim_end_matches('/'));

    let system_prompt = system_prompt_override.map(|s| s.to_string()).unwrap_or_else(|| format!(
        r#"你是企业数据分析师。请根据提供的数据，按照用户的要求生成图文分析报告。
要求：
1. 用大白话解释数据，不要讲技术术语
2. 数据结果用 Markdown 表格呈现
3. 适当加 emoji 让报告更生动
4. 如果有趋势或对比，主动指出洞察
当前分析的表名：{}"#,
        table_name
    ));

    let user_content = format!(
        "【用户分析要求】\n{}\n\n【数据】\n{}\n\n请生成分析报告：",
        prompt, data_markdown
    );

    let req_body = serde_json::json!({
        "model": config.ai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ],
        "temperature": 0.3,
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.ai_key))
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("AI请求失败: {}", e))?;

    let status = resp.status();
    let body = resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("AI响应解析失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("AI接口错误: {:?}", body));
    }

    let content = body
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(content)
}

fn load_config_db() -> Result<AppConfig, String> {
    // 从内存缓存中读取配置（调度器内部使用）
    let cache = CONFIG_CACHE.lock().map_err(|e| format!("配置锁错误: {}", e))?;
    Ok(cache.clone())
}

/// 从文本中自动提取图片链接（支持 jpg/jpeg/png/gif/webp/bmp/svg）
fn extract_image_urls(text: &str) -> Vec<String> {
    let re = regex::Regex::new(
        r"https?://[^\s'\]\)<>]+\.(?:jpg|jpeg|png|gif|webp|bmp|svg)(?:\?[^\s'\]\)<>]*)?"
    )
    .unwrap();
    re.find_iter(text).map(|m| m.as_str().to_string()).collect()
}

async fn send_dingtalk_webhook(
    webhook_url: &str,
    content: &str,
    image_urls: &[ String],
) -> Result<(), String> {
    if webhook_url.is_empty() {
        return Err("Webhook 地址为空".to_string());
    }
    let client = reqwest::Client::new();

    // 从内容中自动提取图片链接，合并去重
    let extracted = extract_image_urls(content);
    let mut seen = std::collections::HashSet::new();
    let all_urls: Vec<String> = image_urls
        .iter()
        .cloned()
        .chain(extracted.into_iter())
        .filter(|u| seen.insert(u.clone()))
        .collect();

    let markdown_text = if all_urls.is_empty() {
        content.to_string()
    } else {
        let mut text = content.to_string();
        for url in &all_urls {
            text.push_str(&format!("\n\n![图片]({})", url));
        }
        text
    };

    let body = serde_json::json!({
        "msgtype": "markdown",
        "markdown": {
            "title": "数据定时报告",
            "text": markdown_text
        }
    });

    let resp = client
        .post(webhook_url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Webhook 发送失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    println!("Webhook 回复响应: {} {}", status, text);

    if status.is_success() {
        Ok(())
    } else {
        Err(format!("Webhook 回复失败: {} {}", status, text))
    }
}

async fn send_dingtalk_private_message(
    phone_number: &str,
    content: &str,
    image_urls: &[ String],
) -> Result<(), String> {
    if phone_number.is_empty() {
        return Err("手机号为空".to_string());
    }

    let config = load_config_db()?;
    if config.ding_app_key.is_empty() || config.ding_app_secret.is_empty() {
        return Err("钉钉配置不完整，无法发送私聊消息".to_string());
    }

    let token = get_dingtalk_token_from_config().await?;
    let userid = get_userid_by_mobile(phone_number.to_string()).await?;
    let robot_code = &config.ding_app_key;
    println!("[PrivateMsg] robot_code={}, userid={}, phone={}", robot_code, userid, phone_number);

    // 从内容中自动提取图片链接，合并去重
    let extracted = extract_image_urls(content);
    let mut seen = std::collections::HashSet::new();
    let all_urls: Vec<String> = image_urls
        .iter()
        .cloned()
        .chain(extracted.into_iter())
        .filter(|u| seen.insert(u.clone()))
        .collect();

    let markdown_text = if all_urls.is_empty() {
        content.to_string()
    } else {
        let mut text = content.to_string();
        for url in &all_urls {
            text.push_str(&format!("\n\n![图片]({})", url));
        }
        text
    };

    let client = reqwest::Client::new();
    let url = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
    let body = serde_json::json!({
        "robotCode": robot_code,
        "userIds": [userid],
        "msgKey": "sampleMarkdown",
        "msgParam": serde_json::json!({
            "title": "数据定时报告",
            "text": markdown_text
        }).to_string()
    });

    let resp = client
        .post(url)
        .header("x-acs-dingtalk-access-token", &token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("发送单聊消息请求失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    println!("钉钉单聊消息响应: {} {}", status, text);

    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(code) = json.get("code").and_then(|v| v.as_str()) {
            if !code.is_empty() && code != "0" {
                let msg = json.get("message").and_then(|v| v.as_str()).unwrap_or("");
                return Err(format!(
                    "发送单聊消息失败 [{}]: {}。请检查应用是否已添加 '企业内部机器人发送消息权限'",
                    code, msg
                ));
            }
        }
    }

    if status.is_success() {
        Ok(())
    } else {
        Err(format!("发送单聊消息失败: {} {}", status, text))
    }
}

#[tauri::command]
async fn test_private_message(phone_number: String, content: String) -> Result<String, String> {
    if phone_number.is_empty() {
        return Err("手机号不能为空".to_string());
    }
    let test_content = if content.is_empty() {
        "这是一条定时任务私聊测试消息，如果您收到说明配置正确。"
    } else {
        &content
    };
    send_dingtalk_private_message(&phone_number, test_content, &[]).await?;
    Ok("私聊测试发送成功，请检查钉钉".to_string())
}

#[tauri::command]
async fn test_schedule_run(
    dashboard_id: String,
    prompt: String,
    webhook_url: String,
    phone_number: String,
    task_type: Option<String>,
    sync_mode: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let task = task_type.unwrap_or_else(|| "analysis".to_string());
    let sync = sync_mode.unwrap_or_else(|| "overwrite".to_string());

    let schedule = DashboardSchedule {
        id: "test".to_string(),
        dashboard_id,
        prompt,
        schedule_type: "once".to_string(),
        schedule_config: "{}".to_string(),
        webhook_url,
        phone_number,
        task_type: task.clone(),
        sync_mode: sync.clone(),
        enabled: true,
        created_at: String::new(),
        updated_at: String::new(),
    };

    if task == "sync" {
        // 测试同步：直接调用同步逻辑
        let dashboard = get_dashboard(schedule.dashboard_id.clone()).await?;
        let doc_url = dashboard.dingtalk_doc_url.ok_or("看板没有关联钉钉文档")?;
        let doc_type = parse_dingtalk_url(&doc_url).map(|(t, _)| t).unwrap_or("sheet");

        let op_id = dashboard.dingtalk_operator_id.clone().unwrap_or_default();
        let token = get_dingtalk_token_from_config().await?;

        let data = if doc_type == "bitable" {
            if op_id.is_empty() {
                return Err("同步钉钉多维表需要提供 OPERATOR_ID".to_string());
            }
            fetch_dingtalk_bitable_data(&token, &doc_url, &op_id).await?
        } else {
            fetch_dingtalk_sheet_data(&token, &doc_url).await?
        };

        println!(
            "[TestSync] fetch 完成，doc_type={}，数据总行数={}（含表头），表头={:?}",
            doc_type,
            data.len(),
            data.get(0)
        );

        let table_name = dashboard.source_table.ok_or("看板没有关联数据表")?;
        let mut conn = init_db()?;
        let count = insert_data_into_table(&mut conn, &table_name, data, &sync, Some(app.clone()))?;

        conn.execute(
            "UPDATE dashboards SET dingtalk_last_sync = datetime('now','localtime') WHERE id = ?1",
            [&schedule.dashboard_id],
        ).map_err(|e| e.to_string())?;

        return Ok(format!("同步测试成功，共写入 {} 条记录 (模式: {})", count, sync));
    }

    // 测试分析：直接执行核心逻辑
    let dashboard = get_dashboard(schedule.dashboard_id.clone()).await?;
    let (table_name, data_markdown) = resolve_dashboard_data(&dashboard, &schedule.prompt
    ).await?;

    let analysis_result = analyze_with_ai(
        &schedule.prompt,
        &data_markdown,
        &table_name,
        None,
    ).await?;

    let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
    let (content_with_images, image_urls) = match crate::chart_gen::process_tables_into_charts(
        &analysis_result,
        &temp_dir,
    )
    .await
    {
        Ok((content, urls)) => (content, urls),
        Err(e) => {
            eprintln!("[Test] 图表生成失败: {}", e);
            (analysis_result.clone(), vec![])
        }
    };

    let webhook_urls = parse_comma_list(&schedule.webhook_url);
    let phone_numbers = parse_comma_list(&schedule.phone_number);

    let mut send_errors = vec![];

    for url in &webhook_urls {
        if let Err(e) = send_dingtalk_webhook(url, &content_with_images, &image_urls).await {
            send_errors.push(format!("Webhook发送失败: {}", e));
        }
    }

    for phone in &phone_numbers {
        if let Err(e) = send_dingtalk_private_message(phone, &content_with_images, &image_urls).await {
            send_errors.push(format!("私聊发送失败: {}", e));
        }
    }

    if !send_errors.is_empty() {
        return Err(send_errors.join("; "));
    }

    Ok("测试发送成功，请检查钉钉".to_string())
}

// ========== DingTalk Sheet Integration ==========

fn parse_dingtalk_url(url: &str) -> Option<(&str, &str)> {
    // 在线表格: https://alidocs.dingtalk.com/i/xxx
    // 多维表格: https://alidocs.dingtalk.com/i/xxx?table=yyy
    // 纯ID输入: 直接当作多维表 baseId
    if url.contains("alidocs.dingtalk.com") {
        if url.contains("bitable") || url.contains("table=") {
            Some(("bitable", url))
        } else {
            Some(("sheet", url))
        }
    } else if !url.contains("http") && !url.is_empty() {
        // 用户直接输入 baseId（纯文本ID）
        Some(("bitable", url))
    } else {
        None
    }
}

async fn get_dingtalk_token_from_config() -> Result<String, String> {
    let config = load_config_db()?;
    crate::bot::get_dingtalk_token(&config).await
}

/// 从钉钉分享链接中提取文档ID
/// 支持格式:
/// - https://alidocs.dingtalk.com/i/xxxxx
/// - https://alidocs.dingtalk.com/i/nodes/xxxxx
/// - https://alidocs.dingtalk.com/i/sheets/xxxxx
/// - https://alidocs.dingtalk.com/spreadsheetv2/xxx/edit?docKey=yyy
fn extract_doc_id_from_url(url: &str) -> Option<String> {
    // 优先从 query 参数提取 docKey（spreadsheetv2 格式常用）
    if let Some(doc_key) = url.split("docKey=").nth(1)
        .and_then(|s| s.split('&').next())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
    {
        return Some(doc_key);
    }

    // 支持 /i/xxx, /spreadsheetv2/xxx, /sheets/xxx 等
    let path = url.split('?').next()?;
    for prefix in ["/i/", "/spreadsheetv2/", "/sheets/", "/workbook/"] {
        if let Some(seg) = path.split(prefix).nth(1) {
            let id = seg.split('/').next()?;
            if !id.is_empty() && id != "edit" {
                return Some(id.to_string());
            }
        }
    }

    // 兜底：最后一个路径段
    path.rsplit('/').next()
        .filter(|s| !s.is_empty() && *s != "edit")
        .map(|s| s.to_string())
}

/// 从钉钉多维表格分享链接中提取参数
fn extract_bitable_params_from_url(url: &str) -> Option<(String, String)> {
    // 尝试从URL中提取 appToken 和 tableId
    // 格式通常包含 bitable 或 table=xxx
    let mut app_token = None;
    let mut table_id = None;

    for param in url.split('?').nth(1).unwrap_or("").split('&') {
        if let Some((k, v)) = param.split_once('=') {
            if k == "appToken" || k == "token" {
                app_token = Some(v.to_string());
            } else if k == "table" || k == "tableId" {
                table_id = Some(v.to_string());
            }
        }
    }

    // 如果URL中没有query参数，尝试从path中提取
    if app_token.is_none() {
        if let Some(seg) = url.split("/bitable/").nth(1) {
            app_token = seg.split('/').next().map(|s| s.to_string());
        }
    }

    Some((app_token? , table_id.unwrap_or_else(|| "tbltI2f5B8Y3Bbbb".to_string())))
}

/// 从钉钉多维表(notable)分享链接中提取 base_id
/// 支持格式:
/// - https://alidocs.dingtalk.com/i/nodes/xxxxx (团队空间中的多维表)
/// - https://alidocs.dingtalk.com/i/bitable/xxxxx
/// - 包含 baseId=xxx 或 docKey=xxx 的链接
fn extract_notable_base_id(url: &str) -> Option<String> {
    // 优先从 query 参数提取
    for key in ["baseId", "docKey", "appToken"] {
        if let Some(v) = url.split(&format!("{}=", key)).nth(1)
            .and_then(|s| s.split('&').next())
            .filter(|s| !s.is_empty())
        {
            return Some(v.to_string());
        }
    }

    // 从路径中提取
    let path = url.split('?').next()?;
    for prefix in ["/i/", "/nodes/", "/bitable/"] {
        if let Some(seg) = path.split(prefix).nth(1) {
            let id = seg.split('/').next()?;
            if !id.is_empty() && id != "edit" {
                return Some(id.to_string());
            }
        }
    }

    // 兜底
    path.rsplit('/').next()
        .filter(|s| !s.is_empty() && *s != "edit")
        .map(|s| s.to_string())
}

async fn fetch_dingtalk_sheet_data(token: &str, url: &str) -> Result<Vec<Vec<String>>, String> {
    let workbook_id = extract_doc_id_from_url(url)
        .ok_or("无法从链接中提取文档ID，请确保是钉钉在线表格分享链接")?;

    println!("[DingTalk Sheet] workbook_id: {}", workbook_id);
    let client = reqwest::Client::new();

    // 钉钉在线表格 API 尝试多种端点
    // 方案1: 新版API (GET /v1.0/doc/workbooks/{id})
    let info_url = format!("https://api.dingtalk.com/v1.0/doc/workbooks/{}", workbook_id);
    let info_resp = client
        .get(&info_url)
        .header("x-acs-dingtalk-access-token", token)
        .send()
        .await;

    println!("[DingTalk Sheet] 尝试新版API: {}", info_url);

    // 如果新版API 404，尝试 spreadsheetv2 专用端点，再尝试旧版TOPAPI
    let mut use_topapi = match info_resp {
        Ok(r) if r.status() == 404 => {
            println!("[DingTalk Sheet] 新版API(workbooks)不存在");
            true
        }
        Ok(r) if !r.status().is_success() => {
            let text = r.text().await.unwrap_or_default();
            println!("[DingTalk Sheet] 新版API错误: {}", text);
            true
        }
        Err(e) => {
            println!("[DingTalk Sheet] 新版API请求失败: {}", e);
            true
        }
        _ => false,
    };

    // 对于 spreadsheetv2 链接，尝试 spreadsheets 端点
    if use_topapi && url.contains("/spreadsheetv2/") {
        let sp_url = format!("https://api.dingtalk.com/v1.0/doc/spreadsheets/{}", workbook_id);
        let sp_resp = client
            .get(&sp_url)
            .header("x-acs-dingtalk-access-token", token)
            .send()
            .await;
        println!("[DingTalk Sheet] 尝试 spreadsheets 端点: {}", sp_url);
        match sp_resp {
            Ok(r) if r.status().is_success() => {
                println!("[DingTalk Sheet] spreadsheets 端点可用，继续执行");
                use_topapi = false;
                // TODO: 如果此端点成功，需要实现对应的 sheets/cells 获取逻辑
                // 目前先回退到TOPAPI，因为 spreadsheets 的 sheet/cell API 路径可能也不同
            }
            Ok(r) if r.status() == 404 => {
                println!("[DingTalk Sheet] spreadsheets 端点也不存在");
            }
            Ok(r) => {
                let text = r.text().await.unwrap_or_default();
                println!("[DingTalk Sheet] spreadsheets 端点错误: {}", text);
            }
            Err(e) => {
                println!("[DingTalk Sheet] spreadsheets 端点请求失败: {}", e);
            }
        }
    }

    if use_topapi {
        return fetch_dingtalk_sheet_data_topapi(token, &workbook_id, url).await;
    }

    // 使用新版API获取Sheet列表
    let sheet_list_url = format!(
        "https://api.dingtalk.com/v1.0/doc/workbooks/{}/sheets",
        workbook_id
    );
    let sheet_resp = client
        .get(&sheet_list_url)
        .header("x-acs-dingtalk-access-token", token)
        .send()
        .await
        .map_err(|e| format!("查询Sheet列表请求失败: {}", e))?;

    let sheet_status = sheet_resp.status();
    let sheet_text = sheet_resp.text().await.unwrap_or_default();
    println!("[DingTalk Sheet] sheets status: {} body: {}", sheet_status, sheet_text);

    if !sheet_status.is_success() {
        return Err(format!("查询Sheet列表失败: {}", sheet_text));
    }

    let sheet_json: serde_json::Value = serde_json::from_str(&sheet_text)
        .map_err(|e| format!("解析Sheet列表失败: {}", e))?;

    let sheets = sheet_json
        .get("sheets")
        .and_then(|v| v.as_array())
        .ok_or("返回数据中没有sheets字段")?;

    if sheets.is_empty() {
        return Err("文档中没有找到Sheet".to_string());
    }

    let first_sheet = &sheets[0];
    let sheet_id = first_sheet
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Sheet没有id字段")?;
    let sheet_name = first_sheet
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Sheet1");
    println!("[DingTalk Sheet] 使用Sheet: {} ({})", sheet_name, sheet_id);

    // 获取Sheet数据（前500行）
    let cells_url = format!(
        "https://api.dingtalk.com/v1.0/doc/workbooks/{}/sheets/{}/cells",
        workbook_id, sheet_id
    );
    let cells_resp = client
        .get(&cells_url)
        .header("x-acs-dingtalk-access-token", token)
        .send()
        .await
        .map_err(|e| format!("获取单元格数据请求失败: {}", e))?;

    let cells_status = cells_resp.status();
    let cells_text = cells_resp.text().await.unwrap_or_default();
    println!("[DingTalk Sheet] cells status: {} body: {}", cells_status, cells_text);

    if !cells_status.is_success() {
        return Err(format!("获取单元格数据失败: {}", cells_text));
    }

    let cells_json: serde_json::Value = serde_json::from_str(&cells_text)
        .map_err(|e| format!("解析单元格数据失败: {}", e))?;

    let result = parse_sheet_cells(&cells_json)?;
    println!("[DingTalk Sheet] 解析完成，共 {} 行（含表头）", result.len());
    Ok(result)
}

async fn fetch_dingtalk_sheet_data_topapi(
    token: &str,
    workbook_id: &str,
    url: &str,
) -> Result<Vec<Vec<String>>, String> {
    let client = reqwest::Client::new();

    // 钉钉文档(nodes)和智能表格(sheets)使用不同的 docType
    let is_doc = url.contains("/nodes/");
    let doc_type = if is_doc { "DOCUMENT" } else { "SHEET" };

    // 旧版TOPAPI: 先查询表格信息（尝试 sheet 接口，spreadsheetv2 使用此接口）
    let query_url = "https://oapi.dingtalk.com/topapi/dingtalkDoc/sheet/query";
    let query_body = if url.contains("/spreadsheetv2/") || url.contains("/sheets/") {
        serde_json::json!({
            "docKey": workbook_id,
            "docType": "SHEET"
        })
    } else {
        serde_json::json!({
            "docKey": workbook_id,
            "docType": doc_type
        })
    };
    let query_resp = client
        .post(query_url)
        .query(&[("access_token", token)])
        .json(&query_body)
        .send()
        .await
        .map_err(|e| format!("TOPAPI查询文档请求失败: {}", e))?;

    let query_status = query_resp.status();
    let query_text = query_resp.text().await.unwrap_or_default();
    println!(
        "[DingTalk Sheet TOPAPI] query({}) status: {} body: {}",
        doc_type, query_status, query_text
    );

    if !query_status.is_success() {
        return Err(format!("TOPAPI查询文档失败: {}", query_text));
    }

    let query_json: serde_json::Value = serde_json::from_str(&query_text)
        .map_err(|e| format!("解析查询响应失败: {}", e))?;

    let errcode = query_json.get("errcode").and_then(|v| v.as_i64()).unwrap_or(-1);
    if errcode != 0 {
        let errmsg = query_json
            .get("errmsg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        // 如果是钉钉文档(nodes)或表格(spreadsheetv2)且接口不合法，提示用户当前不支持
        if is_doc || url.contains("/spreadsheetv2/") {
            return Err(format!(
                "钉钉在线表格/文档暂不支持通过API直接读取数据。\
                建议：1) 改用钉钉多维表链接; 2) 或将表格导出为Excel/CSV上传。 \
                (TOPAPI错误 [{}]: {})",
                errcode, errmsg
            ));
        }
        return Err(format!("TOPAPI错误 [{}]: {}", errcode, errmsg));
    }

    // 获取sheetId
    let sheet_id = query_json
        .get("doc")
        .and_then(|v| v.get("sheetId"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            query_json
                .get("doc")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or(workbook_id);

    println!("[DingTalk Sheet TOPAPI] sheet_id: {}", sheet_id);

    // 获取表格数据范围
    let range_url = "https://oapi.dingtalk.com/topapi/dingtalkDoc/sheet/getRangeData";
    let range_resp = client
        .post(range_url)
        .query(&[("access_token", token)])
        .json(&serde_json::json!({
            "docKey": workbook_id,
            "sheetId": sheet_id,
            "range": {
                "startRow": 0,
                "startColumn": 0,
                "endRow": 500,
                "endColumn": 50
            }
        }))
        .send()
        .await
        .map_err(|e| format!("TOPAPI获取数据请求失败: {}", e))?;

    let range_status = range_resp.status();
    let range_text = range_resp.text().await.unwrap_or_default();
    println!(
        "[DingTalk Sheet TOPAPI] range status: {} body: {}",
        range_status, range_text
    );

    if !range_status.is_success() {
        return Err(format!("TOPAPI获取数据失败: {}", range_text));
    }

    let range_json: serde_json::Value = serde_json::from_str(&range_text)
        .map_err(|e| format!("解析数据响应失败: {}", e))?;

    let errcode = range_json.get("errcode").and_then(|v| v.as_i64()).unwrap_or(-1);
    if errcode != 0 {
        let errmsg = range_json
            .get("errmsg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("TOPAPI获取数据错误 [{}]: {}", errcode, errmsg));
    }

    parse_sheet_cells(&range_json)
}

fn parse_sheet_cells(json: &serde_json::Value) -> Result<Vec<Vec<String>>, String> {
    let rows_data = json
        .get("cells")
        .and_then(|v| v.as_array())
        .or_else(|| json.get("data").and_then(|v| v.get("cells")).and_then(|v| v.as_array()))
        .ok_or("返回数据中没有cells字段")?;

    let mut result: Vec<Vec<String>> = vec![];
    let mut current_row: Vec<String> = vec![];
    let mut current_row_idx = 0u32;

    for cell in rows_data {
        let row = cell.get("row").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let col = cell.get("column").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        // 钉钉 API 可能返回字符串、数字、布尔等多种类型，不能只用 as_str()
        let value = cell.get("value").map(|v| {
            if let Some(s) = v.as_str() {
                s.to_string()
            } else if let Some(n) = v.as_i64() {
                n.to_string()
            } else if let Some(n) = v.as_f64() {
                n.to_string()
            } else if let Some(b) = v.as_bool() {
                b.to_string()
            } else {
                v.to_string()
            }
        }).unwrap_or_default();

        if row != current_row_idx {
            if !current_row.is_empty() {
                result.push(current_row.clone());
            }
            current_row = vec![];
            current_row_idx = row;
        }

        while current_row.len() < col {
            current_row.push("".to_string());
        }
        if current_row.len() == col {
            current_row.push(value);
        } else {
            current_row[col] = value;
        }
    }

    if !current_row.is_empty() {
        result.push(current_row);
    }

    result.retain(|row| row.iter().any(|cell| !cell.is_empty()));

    if result.is_empty() {
        return Err("表格数据为空".to_string());
    }

    Ok(result)
}

async fn fetch_dingtalk_bitable_data(
    token: &str,
    url: &str,
    operator_id: &str,
) -> Result<Vec<Vec<String>>, String> {
    let base_id = extract_notable_base_id(url)
        .ok_or("无法从链接中提取多维表ID，请确保是钉钉多维表分享链接")?;

    println!(
        "[DingTalk Bitable] base_id: {}, operator_id: {}",
        base_id, operator_id
    );
    let client = reqwest::Client::new();

    // 1. 获取多维表内的所有子表（Sheet）
    let sheets_url = format!(
        "https://api.dingtalk.com/v1.0/notable/bases/{}/sheets?operatorId={}",
        base_id, operator_id
    );
    let sheets_resp = client
        .get(&sheets_url)
        .header("x-acs-dingtalk-access-token", token)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("获取子表列表请求失败: {}", e))?;

    let sheets_status = sheets_resp.status();
    let sheets_text = sheets_resp.text().await.unwrap_or_default();
    println!(
        "[DingTalk Bitable] sheets status: {} body: {}",
        sheets_status, sheets_text
    );

    if !sheets_status.is_success() {
        return Err(format!("获取子表列表失败: {}", sheets_text));
    }

    let sheets_json: serde_json::Value = serde_json::from_str(&sheets_text)
        .map_err(|e| format!("解析子表列表失败: {}", e))?;

    let sheets = sheets_json
        .get("value")
        .and_then(|v| v.as_array())
        .ok_or("返回数据中没有value字段（请检查是否已开启 AI表格应用读权限）")?;

    if sheets.is_empty() {
        return Err("多维表中没有找到子表".to_string());
    }

    let first_sheet = &sheets[0];
    let sheet_id = first_sheet
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("子表没有id字段")?;
    let sheet_name = first_sheet
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Sheet1");
    println!(
        "[DingTalk Bitable] 使用子表: {} ({})",
        sheet_name, sheet_id
    );

    // 2. 读取记录
    let records_url = format!(
        "https://api.dingtalk.com/v1.0/notable/bases/{}/sheets/{}/records/list?operatorId={}",
        base_id, sheet_id, operator_id
    );
    let records_resp = client
        .post(&records_url)
        .header("x-acs-dingtalk-access-token", token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "maxResults": 100 }))
        .send()
        .await
        .map_err(|e| format!("获取记录请求失败: {}", e))?;

    let records_status = records_resp.status();
    let records_text = records_resp.text().await.unwrap_or_default();
    println!(
        "[DingTalk Bitable] records status: {} body: {}",
        records_status, records_text
    );

    if !records_status.is_success() {
        return Err(format!("获取记录失败: {}", records_text));
    }

    let records_json: serde_json::Value = serde_json::from_str(&records_text)
        .map_err(|e| format!("解析记录失败: {}", e))?;

    // 兼容两种返回格式: { "records": [...] } 或 { "value": { "records": [...] } }
    let records = records_json
        .get("records")
        .and_then(|v| v.as_array())
        .or_else(|| {
            records_json
                .get("value")
                .and_then(|v| v.get("records"))
                .and_then(|v| v.as_array())
        })
        .ok_or("返回数据中没有records字段")?;

    if records.is_empty() {
        return Err("多维表中没有记录".to_string());
    }

    // 遍历所有记录收集字段名（钉钉多维表采用稀疏存储，不同记录的字段可能不同）
    let mut headers: Vec<String> = vec![];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for rec in records {
        if let Some(fields) = rec.get("fields").and_then(|v| v.as_object()) {
            for key in fields.keys() {
                if seen.insert(key.clone()) {
                    headers.push(key.clone());
                }
            }
        }
    }

    if headers.is_empty() {
        return Err("多维表中没有字段".to_string());
    }

    let mut result: Vec<Vec<String>> = vec![];
    result.push(headers.clone());

    for rec in records {
        if let Some(fields) = rec.get("fields").and_then(|v| v.as_object()) {
            let mut row: Vec<String> = vec![];
            for key in &headers {
                let raw_value = fields.get(key);
                let value = format_field_value(raw_value);
                row.push(value);
            }
            result.push(row);
        }
    }

    println!("[DingTalk Bitable] 解析完成，共 {} 行（含表头）", result.len());

    if result.len() <= 1 {
        return Err("多维表记录为空".to_string());
    }

    Ok(result)
}

/// 格式化钉钉多维表字段值，自动处理时间戳、多选、对象等类型
fn format_field_value(raw: Option<&serde_json::Value>) -> String {
    let v = match raw {
        Some(v) => v,
        None => return String::new(),
    };

    if let Some(s) = v.as_str() {
        // 检测是否为毫秒时间戳（13位纯数字）
        if s.len() == 13 && s.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(ts) = s.parse::<i64>() {
                let dt = chrono::DateTime::from_timestamp_millis(ts);
                return dt
                    .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
                    .unwrap_or_else(|| s.to_string());
            }
        }
        s.to_string()
    } else if let Some(arr) = v.as_array() {
        let vals: Vec<String> = arr
            .iter()
            .filter_map(|i| {
                if let Some(s) = i.as_str() {
                    Some(s.to_string())
                } else if let Some(obj) = i.as_object() {
                    obj.get("text")
                        .or_else(|| obj.get("name"))
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        vals.join(", ")
    } else if let Some(obj) = v.as_object() {
        obj.get("text")
            .or_else(|| obj.get("name"))
            .or_else(|| obj.get("address"))
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default()
    } else if let Some(num) = v.as_i64() {
        // 检测数字类型的时间戳（毫秒）
        if num > 1_000_000_000_000 && num < 9_999_999_999_999 {
            chrono::DateTime::from_timestamp_millis(num)
                .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| num.to_string())
        } else {
            num.to_string()
        }
    } else if let Some(num) = v.as_f64() {
        num.to_string()
    } else {
        String::new()
    }
}

fn insert_data_into_table(
    conn: &mut rusqlite::Connection,
    table_name: &str,
    data: Vec<Vec<String>>,
    mode: &str,
    app: Option<tauri::AppHandle>,
) -> Result<usize, String> {
    if data.is_empty() {
        return Ok(0);
    }

    // 防御保护：如果 fetch 到的数据只有表头没有数据行，拒绝执行（避免 overwrite 模式下清空原有数据）
    if data.len() <= 1 {
        return Err(format!(
            "钉钉返回的数据只有表头（{}列）没有数据行，拒绝执行{}操作",
            data[0].len(),
            if mode == "overwrite" { "覆盖（会清空本地表）" } else { "追加" }
        ));
    }

    let headers = &data[0];
    let columns: Vec<String> = headers.iter().map(|h| format!("\"{}\"", h.replace('"', ""))).collect();
    let placeholders: Vec<String> = (1..=headers.len()).map(|i| format!("?{}", i)).collect();

    // 覆盖模式：清空表
    if mode == "overwrite" {
        let _ = conn.execute(&format!("DELETE FROM \"{}\"", table_name), []);
    }

    // 列兼容性：如果新表头中有旧表不存在的列，自动 ALTER TABLE ADD COLUMN
    {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info(\"{}\")", table_name))
            .map_err(|e| e.to_string())?;
        let existing_cols: std::collections::HashSet<String> = stmt
            .query_map([], |row| Ok(row.get::<_, String>("name")?))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        for header in headers {
            if !existing_cols.contains(header) {
                let alter_sql = format!(
                    "ALTER TABLE \"{}\" ADD COLUMN \"{}\" TEXT",
                    table_name,
                    header.replace('"', "")
                );
                conn.execute(&alter_sql, [])
                    .map_err(|e| e.to_string())?;
                println!(
                    "[DingTalk Sync] 表 {} 自动新增列: {}",
                    table_name, header
                );
            }
        }
    }

    let sql = format!(
        "INSERT INTO \"{}\" ({}) VALUES ({})",
        table_name,
        columns.join(", "),
        placeholders.join(", ")
    );

    // 使用事务批量插入，大幅提升性能并避免前端长时间等待
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let total_rows = data.len().saturating_sub(1);
    let mut count = 0usize;
    for (idx, row) in data.iter().skip(1).enumerate() {
        let params: Vec<&dyn rusqlite::ToSql> = row.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        match tx.execute(&sql, rusqlite::params_from_iter(params)) {
            Ok(_) => {
                count += 1;
                if let Some(ref app_handle) = app {
                    if (idx + 1) % 5 == 0 || idx + 1 == total_rows {
                        let _ = app_handle.emit(
                            "sync-progress",
                            serde_json::json!({
                                "current": idx + 1,
                                "total": total_rows,
                                "table": table_name,
                            }),
                        );
                    }
                }
            }
            Err(e) => {
                eprintln!("[DingTalk Sync] 插入行失败: {}", e);
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    // 发送完成事件
    if let Some(ref app_handle) = app {
        let _ = app_handle.emit(
            "sync-progress",
            serde_json::json!({
                "current": total_rows,
                "total": total_rows,
                "table": table_name,
                "done": true,
            }),
        );
    }

    Ok(count)
}

#[tauri::command]
async fn sync_dingtalk_sheet(
    dashboard_id: String,
    operator_id: Option<String>,
    sync_mode: Option<String>,
    app: tauri::AppHandle,
) -> Result<i32, String> {
    let dashboard = get_dashboard(dashboard_id.clone()).await?;
    let doc_url = dashboard.dingtalk_doc_url.ok_or("看板没有关联钉钉文档")?;
    let doc_type = parse_dingtalk_url(&doc_url).map(|(t, _)| t).unwrap_or("sheet");

    // 自动读取看板保存的 operator_id，外部传入的优先
    let op_id = if let Some(ref oid) = operator_id {
        oid.clone()
    } else if let Some(ref oid) = dashboard.dingtalk_operator_id {
        oid.clone()
    } else {
        String::new()
    };

    let token = get_dingtalk_token_from_config().await?;
    let data = if doc_type == "bitable" {
        if op_id.is_empty() {
            return Err("同步钉钉多维表需要提供 OPERATOR_ID".to_string());
        }
        fetch_dingtalk_bitable_data(&token, &doc_url, &op_id).await?
    } else {
        fetch_dingtalk_sheet_data(&token, &doc_url).await?
    };

    let table_name = dashboard.source_table.ok_or("看板没有关联数据表")?;
    let mut conn = init_db()?;
    let mode = sync_mode.unwrap_or_else(|| "overwrite".to_string());
    let count = insert_data_into_table(&mut conn, &table_name, data, &mode, Some(app.clone()))?;

    // 更新最后同步时间
    conn.execute(
        "UPDATE dashboards SET dingtalk_last_sync = datetime('now','localtime') WHERE id = ?1",
        [&dashboard_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(count as i32)
}

#[tauri::command]
async fn import_dingtalk_sheet(
    url: String,
    mode: String,
    prompt: Option<String>,
    operator_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let doc_type = parse_dingtalk_url(&url).map(|(t, _)| t).unwrap_or("sheet");
    let token = get_dingtalk_token_from_config().await?;
    let data = if doc_type == "bitable" {
        let op_id = operator_id.clone().ok_or("读取钉钉多维表需要提供 OPERATOR_ID")?;
        fetch_dingtalk_bitable_data(&token, &url, &op_id).await?
    } else {
        fetch_dingtalk_sheet_data(&token, &url).await?
    };

    if data.is_empty() {
        return Err("从钉钉获取的数据为空".to_string());
    }

    // 创建本地表
    let table_name = format!("dingtalk_{}", Uuid::new_v4().to_string().replace("-", "").to_lowercase());
    let mut conn = init_db()?;
    let headers = &data[0];
    let col_defs: Vec<String> = headers.iter().map(|h| format!("\"{}\" TEXT", h.replace('"', ""))).collect();
    let create_sql = format!("CREATE TABLE IF NOT EXISTS \"{}\" ({})", table_name, col_defs.join(", "));
    conn.execute(&create_sql, []).map_err(|e| e.to_string())?;

    let row_count = data.len().saturating_sub(1);
    println!("[DingTalk Import] 数据表 {} 创建成功，共 {} 行，模式: {}", table_name, row_count, mode);

    // 插入数据
    insert_data_into_table(&mut conn, &table_name, data, "overwrite", Some(app.clone()))?;

    // 创建看板：取前10行数据发给AI生成简易看板HTML（减少token消耗，加快速度）
    let data_md = query_result_to_markdown(
        &run_sql_query(&format!("SELECT * FROM \"{}\" LIMIT 10", table_name)
        )?
    );

    let (ai_prompt, system_override) = if mode == "auto" {
        let auto_prompt = r#"请根据以下表格数据，生成一个极简的HTML数据看板页面，只包含1个数据图表即可。
要求：
1. 使用单一HTML文件，ECharts通过CDN引入（https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js）
2. 只需要1个图表，选择最适合数据特点的类型（柱状图、折线图或饼图），不需要KPI卡片、不需要复杂布局
3. 主题色使用蓝色系（#3b82f6）
4. 页面顶部显示看板标题，底部显示数据更新时间
5. 不要包含任何"数据清洗"、"梳理"、"上传"相关的UI文字或按钮
6. 直接输出完整可运行的HTML代码，不要加markdown代码块标记，不要解释"#;
        let html_system = r#"你是一位前端数据可视化专家。请根据提供的数据生成极简HTML看板页面，只输出1个图表。必须直接输出HTML代码，不要输出markdown，不要加解释。"#;
        (auto_prompt.to_string(), Some(html_system))
    } else {
        let prompt_text = prompt.unwrap_or_default();
        (prompt_text, None)
    };

    println!("[DingTalk Import] 开始调用AI生成看板，prompt长度: {}", ai_prompt.len());
    let ai_start = std::time::Instant::now();

    let ai_result = analyze_with_ai(
        &ai_prompt,
        &data_md,
        &table_name,
        system_override,
    ).await?;

    println!("[DingTalk Import] AI生成完成，耗时 {:?}，结果长度: {}", ai_start.elapsed(), ai_result.len());

    let dashboard_id = create_dashboard(
        "钉钉数据看板".to_string(),
        None,
        None,
        None,
        None,
        None,
        Some(table_name.clone()),
        None,
        None,
        Some(ai_result),
        Some(doc_type.to_string()),
        Some(url.clone()),
        None,
    ).await?;

    // 保存 operator_id 到 dashboards 表
    if let Some(ref op_id) = operator_id {
        let conn = init_db()?;
        conn.execute(
            "UPDATE dashboards SET dingtalk_operator_id = ?1 WHERE id = ?2",
            rusqlite::params![op_id, dashboard_id],
        ).map_err(|e| e.to_string())?;
    }

    Ok(dashboard_id)
}

async fn get_userid_by_mobile(mobile: String) -> Result<String, String> {
    let token = get_dingtalk_token_from_config().await?;
    let client = reqwest::Client::new();

    let userid_url = format!(
        "https://oapi.dingtalk.com/topapi/v2/user/getbymobile?access_token={}",
        token
    );
    let userid_resp = client
        .post(&userid_url)
        .json(&serde_json::json!({ "mobile": mobile }))
        .send()
        .await
        .map_err(|e| format!("查询UserID请求失败: {}", e))?;

    let userid_text = userid_resp.text().await.unwrap_or_default();
    let userid_json: serde_json::Value = serde_json::from_str(&userid_text)
        .map_err(|e| format!("解析UserID响应失败: {}", e))?;

    let errcode = userid_json
        .get("errcode")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    if errcode != 0 {
        let errmsg = userid_json
            .get("errmsg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("手机号查询UserID失败 [{}]: {}", errcode, errmsg));
    }

    let userid = userid_json
        .get("result")
        .and_then(|v| v.get("userid"))
        .and_then(|v| v.as_str())
        .ok_or("响应中没有userid字段")?;

    Ok(userid.to_string())
}

#[tauri::command]
async fn get_unionid_by_mobile(mobile: String) -> Result<String, String> {
    let userid = get_userid_by_mobile(mobile).await?;
    let token = get_dingtalk_token_from_config().await?;
    let client = reqwest::Client::new();

    let unionid_url = format!(
        "https://oapi.dingtalk.com/topapi/v2/user/get?access_token={}",
        token
    );
    let unionid_resp = client
        .post(&unionid_url)
        .json(&serde_json::json!({ "userid": userid }))
        .send()
        .await
        .map_err(|e| format!("查询UnionID请求失败: {}", e))?;

    let unionid_text = unionid_resp.text().await.unwrap_or_default();
    let unionid_json: serde_json::Value = serde_json::from_str(&unionid_text)
        .map_err(|e| format!("解析UnionID响应失败: {}", e))?;

    let errcode = unionid_json
        .get("errcode")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    if errcode != 0 {
        let errmsg = unionid_json
            .get("errmsg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("UserID查询UnionID失败 [{}]: {}", errcode, errmsg));
    }

    let unionid = unionid_json
        .get("result")
        .and_then(|v| v.get("unionid"))
        .and_then(|v| v.as_str())
        .ok_or("响应中没有unionid字段")?;

    Ok(unionid.to_string())
}

#[tauri::command]
fn log_to_terminal(level: String, message: String) {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    match level.as_str() {
        "error" => eprintln!("[{}] [FRONTEND ERROR] {}", ts, message),
        "warn" => println!("[{}] [FRONTEND WARN]  {}", ts, message),
        _ => println!("[{}] [FRONTEND LOG]   {}", ts, message),
    }
}

// 检查 SQL 是否为安全的 SELECT 查询（允许 CTE / 去除注释）
fn is_safe_select(sql: &str) -> bool {
    let mut cleaned = String::new();
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '-' && chars.peek() == Some(&'-') {
            chars.next();
            while let Some(c) = chars.next() {
                if c == '\n' { break; }
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            while let Some(c) = chars.next() {
                if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    break;
                }
            }
        } else {
            cleaned.push(c);
        }
    }
    let t = cleaned.trim().to_lowercase();
    t.starts_with("select") || t.starts_with("with")
}

#[tauri::command]
fn run_sql_query_for_chat(sql: String) -> Result<QueryResult, String> {
    if !is_safe_select(&sql) {
        return Err("仅支持 SELECT 查询".to_string());
    }
    run_sql_query(&sql)
}

#[tauri::command]
fn execute_dashboard_sql(
    sql_template: String,
    filter_values: Option<std::collections::HashMap<String, String>>,
) -> Result<QueryResult, String> {
    let mut sql = sql_template;
    if let Some(filters) = filter_values {
        for (key, value) in filters {
            sql = sql.replace(&format!("{{{{{}}}}}" , key), &value);
        }
    }

    if !is_safe_select(&sql) {
        return Err("仅支持 SELECT 查询".to_string());
    }

    let conn = init_db()?;
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("SQL准备失败: {}", e))?;
    let col_count = stmt.column_count();
    let mut columns: Vec<String> = vec![];
    for i in 0..col_count {
        columns.push(stmt.column_name(i).unwrap_or("?").to_string());
    }

    let mut data: Vec<Vec<String>> = vec![];
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut vals: Vec<String> = vec![];
        for i in 0..col_count {
            let val_ref = row.get_ref(i).map_err(|e| e.to_string())?;
            let val: String = match val_ref {
                rusqlite::types::ValueRef::Null => String::new(),
                rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                rusqlite::types::ValueRef::Real(f) => f.to_string(),
                rusqlite::types::ValueRef::Text(s) => String::from_utf8_lossy(s).to_string(),
                rusqlite::types::ValueRef::Blob(_) => "<BLOB>".to_string(),
            };
            vals.push(val);
        }
        data.push(vals);
    }

    Ok(QueryResult {
        columns,
        rows: data,
        rowids: vec![],
        primary_key: "rowid".to_string(),
        total_count: 0,
    })
}

// ========== SQL 自动纠错 Agent ==========

const SQL_REPAIR_SYSTEM_PROMPT: &str = r#"你是 SQLite 专家。下面这条 SQL 在本地 SQLite 数据库执行失败了，请基于 SQLite 语法修正它。

【SQLite 与 MySQL 主要差异 — 必须遵守】
- 禁止 GROUP_CONCAT(... SEPARATOR x)，改用 GROUP_CONCAT(expr, '分隔符')（逗号分隔）
- 禁止 DATE_FORMAT，改用 strftime('%Y-%m-%d', col)
- 字符串拼接用 ||，不能用 CONCAT(...)
- 禁止 LIMIT n,m 写法，改用 LIMIT n OFFSET m
- 没有 IF(cond, a, b)，用 CASE WHEN cond THEN a ELSE b END 或 IIF
- 禁止 RIGHT/LEFT(str, n)，用 substr
- 只能引用提示中给出的真实表名和列名，不允许虚构

【输出要求 — 必须严格遵守】
返回纯 JSON 对象，不要 markdown 围栏，不要解释文字，不要前后缀：
{
  "reason": "用一两句中文说明原 SQL 错在哪",
  "fix": "用一两句中文说明你做了什么修正",
  "corrected_sql": "完整修正后的 SQL 语句"
}
"#;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RepairStep {
    pub step_number: i32,
    pub status: String, // "running" | "success" | "failed"
    pub title: String,
    pub message: String,
    pub error: Option<String>,
    pub reason: Option<String>,
    pub fix: Option<String>,
    pub sql_preview: Option<String>,
    pub elapsed_seconds: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RepairResult {
    pub query_result: Option<QueryResult>,
    pub final_sql: String,
    pub steps: Vec<RepairStep>,
    pub repaired: bool,
}

fn run_sql_query(sql: &str) -> Result<QueryResult, String> {
    let conn = init_db()?;
    let mut stmt = conn.prepare(sql).map_err(|e| format!("SQL准备失败: {}", e))?;
    let col_count = stmt.column_count();
    let mut columns: Vec<String> = vec![];
    for i in 0..col_count {
        columns.push(stmt.column_name(i).unwrap_or("?").to_string());
    }
    let mut data: Vec<Vec<String>> = vec![];
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut vals: Vec<String> = vec![];
        for i in 0..col_count {
            let val_ref = row.get_ref(i).map_err(|e| e.to_string())?;
            let val: String = match val_ref {
                rusqlite::types::ValueRef::Null => String::new(),
                rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                rusqlite::types::ValueRef::Real(f) => f.to_string(),
                rusqlite::types::ValueRef::Text(s) => String::from_utf8_lossy(s).to_string(),
                rusqlite::types::ValueRef::Blob(_) => "<BLOB>".to_string(),
            };
            vals.push(val);
        }
        data.push(vals);
    }
    Ok(QueryResult {
        columns,
        rows: data,
        rowids: vec![],
        primary_key: "rowid".to_string(),
        total_count: 0,
    })
}

fn collect_schema_summary() -> String {
    let conn = match init_db() {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let tables: Vec<String> = {
        let mut stmt = match conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('chat_sessions','dashboards','column_remarks','table_column_remarks','table_mappings','table_upload_mappings','bot_chat_memory','kb_chunks','kb_docs','app_config') ORDER BY name",
        ) {
            Ok(s) => s,
            Err(_) => return String::new(),
        };
        let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
            Ok(r) => r,
            Err(_) => return String::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut out = String::new();
    for t in &tables {
        out.push_str(&format!("表 {}:\n", t));
        if let Ok(mut s) = conn.prepare(&format!("PRAGMA table_info({})", t)) {
            let cols = s.query_map([], |row| {
                let name: String = row.get(1)?;
                let ty: String = row.get(2)?;
                Ok((name, ty))
            });
            if let Ok(cols) = cols {
                for c in cols.flatten() {
                    let remark: String = conn
                        .query_row(
                            "SELECT remark FROM table_column_remarks WHERE table_name = ?1 AND column_name = ?2",
                            rusqlite::params![t, c.0],
                            |row| row.get(0),
                        )
                        .unwrap_or_default();
                    if remark.is_empty() {
                        out.push_str(&format!("  - {} ({})\n", c.0, c.1));
                    } else {
                        out.push_str(&format!("  - {} ({}) — {}\n", c.0, c.1, remark));
                    }
                }
            }
        }
    }
    out
}

#[tauri::command]
async fn execute_dashboard_sql_with_repair(
    app: tauri::AppHandle,
    dashboard_id: String,
    sql_template: String,
    filter_values: Option<std::collections::HashMap<String, String>>,
) -> Result<RepairResult, String> {
    let mut sql = sql_template.clone();
    if let Some(filters) = &filter_values {
        for (key, value) in filters {
            sql = sql.replace(&format!("{{{{{}}}}}" , key), value);
        }
    }

    if !is_safe_select(&sql) {
        return Err("仅支持 SELECT 查询".to_string());
    }

    let start = std::time::Instant::now();
    let mut steps: Vec<RepairStep> = vec![];
    let mut step_num = 1;

    let emit_step = |app: &tauri::AppHandle, step: &RepairStep| {
        let _ = app.emit("dashboard-sql-repair-step", step);
    };

    // Step 1: 直接执行原 SQL
    let s = RepairStep {
        step_number: step_num,
        status: "running".into(),
        title: "执行 SQL".into(),
        message: "正在直接执行看板 SQL".into(),
        error: None,
        reason: None,
        fix: None,
        sql_preview: Some(sql.chars().take(200).collect()),
        elapsed_seconds: start.elapsed().as_secs() as i32,
    };
    emit_step(&app, &s);
    steps.push(s);

    match run_sql_query(&sql) {
        Ok(res) => {
            let s = RepairStep {
                step_number: step_num,
                status: "success".into(),
                title: "执行 SQL".into(),
                message: format!("查询成功，返回 {} 行", res.rows.len()),
                error: None,
                reason: None,
                fix: None,
                sql_preview: None,
                elapsed_seconds: start.elapsed().as_secs() as i32,
            };
            emit_step(&app, &s);
            steps.push(s);
            return Ok(RepairResult {
                query_result: Some(res),
                final_sql: sql,
                steps,
                repaired: false,
            });
        }
        Err(err) => {
            let s = RepairStep {
                step_number: step_num,
                status: "failed".into(),
                title: "执行 SQL".into(),
                message: "原 SQL 执行失败，启动 AI 自动纠错".into(),
                error: Some(err.clone()),
                reason: None,
                fix: None,
                sql_preview: None,
                elapsed_seconds: start.elapsed().as_secs() as i32,
            };
            emit_step(&app, &s);
            steps.push(s);
        }
    }

    // 进入纠错循环
    let config = load_config(app.clone()).await?;
    if config.ai_url.is_empty() || config.ai_key.is_empty() {
        return Err("看板 SQL 出错，且未配置 AI 接口，无法自动纠错".to_string());
    }
    let url = if config.ai_url.ends_with("/v1/chat/completions") {
        config.ai_url.clone()
    } else if config.ai_url.ends_with("/v1") {
        format!("{}/chat/completions", config.ai_url)
    } else if config.ai_url.ends_with('/') {
        format!("{}v1/chat/completions", config.ai_url)
    } else {
        format!("{}/v1/chat/completions", config.ai_url)
    };
    let model = if config.ai_model.is_empty() {
        "deepseek-chat".to_string()
    } else {
        config.ai_model.clone()
    };
    let schema_summary = collect_schema_summary();
    let client = reqwest::Client::new();

    let mut current_sql = sql.clone();
    let mut last_error = steps.last().and_then(|s| s.error.clone()).unwrap_or_default();
    let mut last_reason: Option<String> = None;
    let mut last_fix: Option<String> = None;

    for round in 1..=5 {
        step_num += 1;
        let s = RepairStep {
            step_number: step_num,
            status: "running".into(),
            title: format!("AI 分析错误（第 {} 轮）", round),
            message: "正在让 AI 分析错误并给出修正方案".into(),
            error: Some(last_error.clone()),
            reason: None,
            fix: None,
            sql_preview: Some(current_sql.chars().take(200).collect()),
            elapsed_seconds: start.elapsed().as_secs() as i32,
        };
        emit_step(&app, &s);
        steps.push(s);

        let user_prompt = format!(
            "下面是当前数据库的所有用户表 schema（含中文备注）：\n{}\n\n出错的 SQL：\n{}\n\n错误信息：\n{}\n\n请按系统消息中的格式返回 JSON。",
            schema_summary, current_sql, last_error
        );
        let req_body = ChatRequest {
            model: model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system".into(),
                    content: SQL_REPAIR_SYSTEM_PROMPT.into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: serde_json::Value::String(user_prompt),
                },
            ],
            temperature: 0.1,
        };

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.ai_key))
            .json(&req_body)
            .send()
            .await
            .map_err(|e| format!("请求 AI 接口失败: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let s = RepairStep {
                step_number: step_num,
                status: "failed".into(),
                title: format!("AI 分析错误（第 {} 轮）", round),
                message: format!("AI 接口返回错误 {}", status),
                error: Some(text),
                reason: None,
                fix: None,
                sql_preview: None,
                elapsed_seconds: start.elapsed().as_secs() as i32,
            };
            emit_step(&app, &s);
            steps.push(s);
            continue;
        }

        let completion: ChatCompletion = match resp.json().await {
            Ok(c) => c,
            Err(e) => {
                let s = RepairStep {
                    step_number: step_num,
                    status: "failed".into(),
                    title: format!("AI 分析错误（第 {} 轮）", round),
                    message: "解析 AI 响应失败".into(),
                    error: Some(e.to_string()),
                    reason: None,
                    fix: None,
                    sql_preview: None,
                    elapsed_seconds: start.elapsed().as_secs() as i32,
                };
                emit_step(&app, &s);
                steps.push(s);
                continue;
            }
        };

        let raw_content = completion
            .choices
            .get(0)
            .map(|c| c.message.content.clone())
            .unwrap_or_default();
        let cleaned = raw_content
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string();
        let parsed: serde_json::Value = match serde_json::from_str(&cleaned) {
            Ok(v) => v,
            Err(_) => {
                // 尝试在文本里抠出第一个 { ... } JSON 块
                if let (Some(s_idx), Some(e_idx)) = (cleaned.find('{'), cleaned.rfind('}')) {
                    if e_idx > s_idx {
                        let slice = &cleaned[s_idx..=e_idx];
                        match serde_json::from_str::<serde_json::Value>(slice) {
                            Ok(v) => v,
                            Err(e) => {
                                let s = RepairStep {
                                    step_number: step_num,
                                    status: "failed".into(),
                                    title: format!("AI 分析错误（第 {} 轮）", round),
                                    message: "AI 返回不是合法 JSON".into(),
                                    error: Some(e.to_string()),
                                    reason: None,
                                    fix: None,
                                    sql_preview: None,
                                    elapsed_seconds: start.elapsed().as_secs() as i32,
                                };
                                emit_step(&app, &s);
                                steps.push(s);
                                continue;
                            }
                        }
                    } else {
                        continue;
                    }
                } else {
                    continue;
                }
            }
        };

        let reason = parsed
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let fix = parsed
            .get("fix")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let corrected_sql = parsed
            .get("corrected_sql")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if corrected_sql.is_empty() {
            let s = RepairStep {
                step_number: step_num,
                status: "failed".into(),
                title: format!("AI 分析错误（第 {} 轮）", round),
                message: "AI 没给出修正后的 SQL".into(),
                error: None,
                reason: Some(reason),
                fix: Some(fix),
                sql_preview: None,
                elapsed_seconds: start.elapsed().as_secs() as i32,
            };
            emit_step(&app, &s);
            steps.push(s);
            continue;
        }

        last_reason = Some(reason.clone());
        last_fix = Some(fix.clone());

        let s = RepairStep {
            step_number: step_num,
            status: "success".into(),
            title: format!("AI 给出修正方案（第 {} 轮）", round),
            message: "已收到 AI 修正建议".into(),
            error: None,
            reason: Some(reason),
            fix: Some(fix),
            sql_preview: Some(corrected_sql.chars().take(200).collect()),
            elapsed_seconds: start.elapsed().as_secs() as i32,
        };
        emit_step(&app, &s);
        steps.push(s);

        // 重试执行修正后的 SQL
        step_num += 1;
        let s = RepairStep {
            step_number: step_num,
            status: "running".into(),
            title: format!("执行修正后的 SQL（第 {} 轮）", round),
            message: "正在用 AI 修正后的 SQL 重新查询".into(),
            error: None,
            reason: None,
            fix: None,
            sql_preview: Some(corrected_sql.chars().take(200).collect()),
            elapsed_seconds: start.elapsed().as_secs() as i32,
        };
        emit_step(&app, &s);
        steps.push(s);

        // 应用 filter_values 占位符替换
        let mut replaced = corrected_sql.clone();
        if let Some(filters) = &filter_values {
            for (key, value) in filters {
                replaced = replaced.replace(&format!("{{{{{}}}}}" , key), value);
            }
        }

        match run_sql_query(&replaced) {
            Ok(res) => {
                let s = RepairStep {
                    step_number: step_num,
                    status: "success".into(),
                    title: "修正成功".into(),
                    message: format!("查询成功，返回 {} 行", res.rows.len()),
                    error: None,
                    reason: last_reason.clone(),
                    fix: last_fix.clone(),
                    sql_preview: None,
                    elapsed_seconds: start.elapsed().as_secs() as i32,
                };
                emit_step(&app, &s);
                steps.push(s);

                // 持久化:把 corrected_sql 写回 dashboards.sql_template
                let conn = init_db()?;
                let _ = conn.execute(
                    "UPDATE dashboards SET sql_template = ?1, updated_at = datetime('now') WHERE id = ?2",
                    rusqlite::params![corrected_sql, dashboard_id],
                );

                return Ok(RepairResult {
                    query_result: Some(res),
                    final_sql: corrected_sql,
                    steps,
                    repaired: true,
                });
            }
            Err(err) => {
                let s = RepairStep {
                    step_number: step_num,
                    status: "failed".into(),
                    title: format!("执行修正后的 SQL（第 {} 轮）", round),
                    message: "修正后的 SQL 仍然失败，进入下一轮".into(),
                    error: Some(err.clone()),
                    reason: None,
                    fix: None,
                    sql_preview: None,
                    elapsed_seconds: start.elapsed().as_secs() as i32,
                };
                emit_step(&app, &s);
                steps.push(s);
                last_error = err;
                current_sql = corrected_sql;
            }
        }
    }

    // 三轮全失败
    step_num += 1;
    let s = RepairStep {
        step_number: step_num,
        status: "failed".into(),
        title: "无法自动修正".into(),
        message: "AI 已尝试 3 轮仍未能修复，请手动调整 SQL 或联系开发者".into(),
        error: Some(last_error.clone()),
        reason: last_reason,
        fix: last_fix,
        sql_preview: None,
        elapsed_seconds: start.elapsed().as_secs() as i32,
    };
    emit_step(&app, &s);
    steps.push(s);

    Err(format!("AI 自动纠错 3 轮后仍失败:{}", last_error))
}

// ========== Modify Dashboard with Multi-step ==========

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ModifyStep {
    pub step_number: i32,
    pub plan: String,
    pub action: String,
    pub elapsed_seconds: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ModifyResult {
    pub steps: Vec<ModifyStep>,
    pub dashboard: Option<serde_json::Value>,
    pub final_content: String,
}

#[tauri::command]
async fn modify_dashboard(
    app: tauri::AppHandle,
    session_id: String,
    dashboard_id: String,
    user_request: String,
    max_steps: Option<i32>,
) -> Result<ModifyResult, String> {
    let config = load_config(app.clone()).await?;
    let max_steps = max_steps.unwrap_or(10);
    let dashboard = get_dashboard(dashboard_id.clone()).await?;

    if config.ai_url.is_empty() || config.ai_key.is_empty() {
        return Err("请先配置 AI 接口地址和 API Key".to_string());
    }

    let start_time = std::time::Instant::now();
    let mut steps: Vec<ModifyStep> = vec![];
    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: "system".to_string(),
        content: serde_json::Value::String(MODIFICATION_SYSTEM_PROMPT.to_string()),
    }];

    let initial_prompt = format!(
        "请修改以下看板：\n名称: {}\nSQL: {}\n筛选器: {}\n图表: {}\n\n用户修改需求: {}",
        dashboard.name,
        dashboard.sql_template.unwrap_or_default(),
        dashboard.ui_filters.unwrap_or_default(),
        dashboard.charts.unwrap_or_default(),
        user_request
    );
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: serde_json::Value::String(initial_prompt),
    });

    let client = reqwest::Client::new();
    let url = if config.ai_url.ends_with("/v1/chat/completions") {
        config.ai_url.clone()
    } else if config.ai_url.ends_with("/v1") {
        format!("{}/chat/completions", config.ai_url)
    } else if config.ai_url.ends_with("/") {
        format!("{}v1/chat/completions", config.ai_url)
    } else {
        format!("{}/v1/chat/completions", config.ai_url)
    };

    let mut final_content = String::new();
    let mut dashboard_json: Option<serde_json::Value> = None;

    for step in 1..=max_steps {
        let req_body = ChatRequest {
            model: if config.ai_model.is_empty() {
                "deepseek-chat".to_string()
            } else {
                config.ai_model.clone()
            },
            messages: messages.clone(),
            temperature: 0.3,
        };

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.ai_key))
            .json(&req_body)
            .send()
            .await
            .map_err(|e| format!("请求 AI 接口失败: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("AI 接口返回错误 {}: {}", status, text));
        }

        let completion: ChatCompletion = resp
            .json()
            .await
            .map_err(|e| format!("解析 AI 响应失败: {}", e))?;

        let content = completion
            .choices
            .get(0)
            .map(|c| c.message.content.clone())
            .unwrap_or_default();

        let elapsed = start_time.elapsed().as_secs() as i32;

        let plan = if content.contains("【整体规划】") {
            content.split("【整体规划】").nth(1)
                .and_then(|s| s.split("【步骤").next())
                .unwrap_or(&content)
                .trim()
                .to_string()
        } else {
            content.lines().next().unwrap_or(&content).to_string()
        };

        steps.push(ModifyStep {
            step_number: step,
            plan: plan.clone(),
            action: format!("执行第 {} 步", step),
            elapsed_seconds: elapsed,
        });

        let _ = app.emit("modify-progress", serde_json::json!({
            "step": step,
            "total": max_steps,
            "plan": plan,
            "elapsed_seconds": elapsed,
        }));

        final_content = content.clone();
        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: serde_json::Value::String(content.clone()),
        });

        if content.contains("\"action\": \"update_dashboard\"") || content.contains("\"action\":\"update_dashboard\"") {
            let cleaned = content
                .trim()
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim();
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(cleaned) {
                dashboard_json = Some(json);
            }
            break;
        }

        messages.push(ChatMessage {
            role: "user".to_string(),
            content: serde_json::Value::String("请继续执行下一步。".to_string()),
        });
    }

    Ok(ModifyResult {
        steps,
        dashboard: dashboard_json,
        final_content,
    })
}

// ========== Database Commands ==========

#[tauri::command]
fn get_db_tables() -> Result<Vec<String>, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let name: String = row.get(0)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    let mut tables: Vec<String> = vec![];
    for row in rows {
        let name = row.map_err(|e| e.to_string())?;
        if name != "kb_docs" && name != "chat_sessions" && name != "dashboards" && !name.starts_with("sqlite_") && !name.starts_with("temp_") {
            tables.push(name);
        }
    }
    Ok(tables)
}

#[tauri::command]
fn get_table_schema(table_name: String) -> Result<Vec<ColumnInfo>, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table_name))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ColumnInfo {
                cid: row.get(0)?,
                name: row.get(1)?,
                type_name: row.get(2)?,
                notnull: row.get::<_, i32>(3)? != 0,
                dflt_value: row.get(4)?,
                pk: row.get::<_, i32>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut cols: Vec<ColumnInfo> = vec![];
    for row in rows {
        cols.push(row.map_err(|e| e.to_string())?);
    }
    Ok(cols)
}

#[tauri::command]
fn query_table_data(
    table_name: String,
    limit: i32,
    offset: Option<i64>,
) -> Result<QueryResult, String> {
    let conn = init_db()?;
    let offset_val = offset.unwrap_or(0).max(0);

    let total_count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {}", table_name),
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let mut col_stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table_name))
        .map_err(|e| e.to_string())?;
    let mut has_pk = false;
    let mut pk_col: Option<String> = None;
    let col_rows = col_stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let pk: bool = row.get::<_, i32>(5)? != 0;
            if pk {
                has_pk = true;
                pk_col = Some(name.clone());
            }
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    let mut columns: Vec<String> = vec![];
    for row in col_rows {
        columns.push(row.map_err(|e| e.to_string())?);
    }

    let sql = if has_pk {
        format!("SELECT * FROM {} LIMIT ? OFFSET ?", table_name)
    } else {
        format!("SELECT rowid, * FROM {} LIMIT ? OFFSET ?", table_name)
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let col_count = columns.len();
    let rows = stmt
        .query_map(rusqlite::params![limit, offset_val], move |row| {
            let mut vals: Vec<String> = vec![];
            for i in 0..col_count {
                let idx = if has_pk { i } else { i + 1 };
                let val_ref = row.get_ref(idx)?;
                let val: String = match val_ref {
                    rusqlite::types::ValueRef::Null => String::new(),
                    rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                    rusqlite::types::ValueRef::Real(f) => f.to_string(),
                    rusqlite::types::ValueRef::Text(s) => String::from_utf8_lossy(s).to_string(),
                    rusqlite::types::ValueRef::Blob(_) => "<BLOB>".to_string(),
                };
                vals.push(val);
            }
            let rowid: String = if has_pk {
                String::new()
            } else {
                let val_ref = row.get_ref(0)?;
                match val_ref {
                    rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                    rusqlite::types::ValueRef::Text(s) => String::from_utf8_lossy(s).to_string(),
                    _ => String::new(),
                }
            };
            Ok((vals, rowid))
        })
        .map_err(|e| e.to_string())?;

    let mut data: Vec<Vec<String>> = vec![];
    let mut rowids: Vec<String> = vec![];
    for row in rows {
        let (vals, rid) = row.map_err(|e| e.to_string())?;
        data.push(vals);
        rowids.push(rid);
    }

    Ok(QueryResult {
        columns,
        rows: data,
        rowids,
        primary_key: pk_col.unwrap_or_else(|| "rowid".to_string()),
        total_count,
    })
}

#[tauri::command]
fn drop_user_table(table_name: String) -> Result<(), String> {
    let conn = init_db()?;
    conn.execute(
        &format!("DROP TABLE IF EXISTS {}", table_name),
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM kb_docs WHERE table_name = ?1",
        rusqlite::params![table_name],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM table_column_remarks WHERE table_name = ?1",
        rusqlite::params![table_name],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM table_upload_mappings WHERE table_name = ?1",
        rusqlite::params![table_name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_table_primary_key(table_name: String) -> Result<String, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table_name))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let pk: bool = row.get::<_, i32>(5)? != 0;
            Ok((name, pk))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (name, pk) = row.map_err(|e| e.to_string())?;
        if pk {
            return Ok(name);
        }
    }
    Ok("rowid".to_string())
}

#[tauri::command]
fn get_column_remarks(table_name: String) -> Result<std::collections::HashMap<String, String>, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare("SELECT column_name, remark FROM table_column_remarks WHERE table_name = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&table_name], |row| {
            let col: String = row.get(0)?;
            let remark: String = row.get(1)?;
            Ok((col, remark))
        })
        .map_err(|e| e.to_string())?;

    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (col, remark) = row.map_err(|e| e.to_string())?;
        map.insert(col, remark);
    }
    Ok(map)
}

#[tauri::command]
fn set_column_remark(table_name: String, column_name: String, remark: String) -> Result<(), String> {
    let conn = init_db()?;
    conn.execute(
        "INSERT OR REPLACE INTO table_column_remarks (table_name, column_name, remark, updated_at) VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)",
        rusqlite::params![table_name, column_name, remark],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_table_remark(table_name: String) -> Result<String, String> {
    let conn = init_db()?;
    let remark: String = conn.query_row(
        "SELECT remark FROM table_remarks WHERE table_name = ?1",
        [&table_name],
        |row| row.get(0),
    ).unwrap_or_default();
    Ok(remark)
}

#[tauri::command]
fn set_table_remark(table_name: String, remark: String) -> Result<(), String> {
    let conn = init_db()?;
    conn.execute(
        "INSERT OR REPLACE INTO table_remarks (table_name, remark, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
        rusqlite::params![table_name, remark],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Debug, Clone)]
pub struct ChatTableInfo {
    pub table_name: String,
    pub remark: String,
    pub dashboards: Vec<String>,
    pub column_count: i32,
    pub row_count: i64,
}

#[tauri::command]
fn list_db_tables_for_chat() -> Result<Vec<ChatTableInfo>, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('dashboards','chat_sessions','table_column_remarks','table_upload_mappings','table_remarks','dashboard_revisions') ORDER BY name")
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let mut dashboards_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut dash_stmt = conn
        .prepare("SELECT source_table, name FROM dashboards WHERE source_table IS NOT NULL AND source_table != ''")
        .map_err(|e| e.to_string())?;
    let dash_rows = dash_stmt
        .query_map([], |row| {
            let tbl: String = row.get(0)?;
            let name: String = row.get(1)?;
            Ok((tbl, name))
        })
        .map_err(|e| e.to_string())?;
    for row in dash_rows {
        if let Ok((tbl, name)) = row {
            dashboards_map.entry(tbl).or_default().push(name);
        }
    }
    drop(dash_stmt);

    let mut out = Vec::new();
    for name in names {
        let remark: String = conn.query_row(
            "SELECT remark FROM table_remarks WHERE table_name = ?1",
            [&name],
            |row| row.get(0),
        ).unwrap_or_default();
        let col_count: i32 = conn.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{}')", name),
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        let row_count: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", name),
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        out.push(ChatTableInfo {
            table_name: name.clone(),
            remark,
            dashboards: dashboards_map.get(&name).cloned().unwrap_or_default(),
            column_count: col_count,
            row_count,
        });
    }
    Ok(out)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SavedMapping {
    pub excel_col: String,
    pub db_col: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TableMappingConfig {
    pub table_name: String,
    pub mappings: Vec<SavedMapping>,
    pub auto_clean: bool,
}

#[tauri::command]
fn get_table_mappings(table_name: String) -> Result<TableMappingConfig, String> {
    let conn = init_db()?;
    let result = conn.query_row(
        "SELECT mappings, auto_clean FROM table_upload_mappings WHERE table_name = ?1",
        [&table_name],
        |row| {
            let mappings_json: String = row.get(0)?;
            let auto_clean: i32 = row.get(1)?;
            let mappings: Vec<SavedMapping> = serde_json::from_str(&mappings_json).unwrap_or_default();
            Ok(TableMappingConfig {
                table_name: table_name.clone(),
                mappings,
                auto_clean: auto_clean != 0,
            })
        },
    );
    match result {
        Ok(cfg) => Ok(cfg),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(TableMappingConfig {
            table_name,
            mappings: vec![],
            auto_clean: true,
        }),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_table_mappings(table_name: String, mappings: Vec<SavedMapping>, auto_clean: bool) -> Result<(), String> {
    let conn = init_db()?;
    let mappings_json = serde_json::to_string(&mappings).unwrap_or_default();
    conn.execute(
        "INSERT OR REPLACE INTO table_upload_mappings (table_name, mappings, auto_clean, updated_at) VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)",
        rusqlite::params![table_name, mappings_json, if auto_clean { 1 } else { 0 }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_local_db_path() -> Result<String, String> {
    db_path().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn get_local_ip() -> Result<String, String> {
    match local_ip_address::local_ip() {
        Ok(ip) => Ok(ip.to_string()),
        Err(e) => Err(format!("获取本地IP失败: {}", e)),
    }
}

#[tauri::command]
fn update_table_row(
    table_name: String,
    row_data: std::collections::HashMap<String, String>,
    primary_key: String,
    primary_value: String,
) -> Result<(), String> {
    let conn = init_db()?;
    let mut set_clauses = vec![];
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![];

    for (col, val) in &row_data {
        if col != &primary_key {
            set_clauses.push(format!("{} = ?", col));
            params.push(Box::new(val.clone()));
        }
    }

    if set_clauses.is_empty() {
        return Err("没有要更新的字段".to_string());
    }

    let sql = format!(
        "UPDATE {} SET {} WHERE {} = ?",
        table_name,
        set_clauses.join(", "),
        primary_key
    );
    params.push(Box::new(primary_value));

    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, param_refs.as_slice())
        .map_err(|e| format!("更新失败: {}", e))?;
    Ok(())
}

#[tauri::command]
fn batch_update_rows(
    table_name: String,
    column: String,
    value: String,
    row_indices: Vec<i32>,
    primary_key: String,
    primary_values: Vec<String>,
) -> Result<i32, String> {
    let conn = init_db()?;
    let mut updated = 0;
    for (i, pk_val) in primary_values.iter().enumerate() {
        if !row_indices.contains(&(i as i32)) {
            continue;
        }
        let sql = format!(
            "UPDATE {} SET {} = ?1 WHERE {} = ?2",
            table_name, column, primary_key
        );
        match conn.execute(&sql, rusqlite::params![value, pk_val]) {
            Ok(n) => updated += n as i32,
            Err(e) => eprintln!("批量更新行失败: {}", e),
        }
    }
    Ok(updated)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ColumnMapping {
    pub excel_col: String,
    pub db_col: String,
}

#[tauri::command]
async fn import_excel_to_table(
    file_path: String,
    table_name: String,
    mappings: Vec<ColumnMapping>,
    skip_header: bool,
    use_saved_mappings: Option<bool>,
) -> Result<i32, String> {
    let path = std::path::Path::new(&file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let conn = init_db()?;

    let mut effective_mappings = mappings;
    if effective_mappings.is_empty() || use_saved_mappings.unwrap_or(false) {
        let saved = get_table_mappings(table_name.clone())?;
        if !saved.mappings.is_empty() {
            effective_mappings = saved.mappings.into_iter().map(|m| ColumnMapping {
                excel_col: m.excel_col,
                db_col: m.db_col,
            }).collect();
        }
    }

    if effective_mappings.is_empty() {
        return Err("字段映射不能为空".to_string());
    }

    let db_cols: Vec<String> = effective_mappings.iter().map(|m| m.db_col.clone()).collect();
    let excel_cols: Vec<String> = effective_mappings.iter().map(|m| m.excel_col.clone()).collect();

    let mut inserted = 0;

    if ext == "csv" {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut rdr = csv::Reader::from_reader(file);
        let headers: Vec<String> = rdr
            .headers()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|s| s.to_string())
            .collect();

        let col_indices: Vec<usize> = excel_cols
            .iter()
            .map(|ec| headers.iter().position(|h| h == ec).unwrap_or(usize::MAX))
            .collect();

        let placeholders = db_cols.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table_name,
            db_cols.join(", "),
            placeholders
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

        for result in rdr.records() {
            let rec = result.map_err(|e| e.to_string())?;
            let mut values: Vec<String> = vec![];
            for idx in &col_indices {
                if *idx == usize::MAX {
                    values.push(String::new());
                } else {
                    values.push(rec.get(*idx).unwrap_or("").to_string());
                }
            }
            let params: Vec<&dyn rusqlite::ToSql> = values.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            if let Err(e) = stmt.execute(params.as_slice()) {
                eprintln!("插入行失败: {}", e);
            } else {
                inserted += 1;
            }
        }
    } else if ext == "xlsx" || ext == "xls" {
        let range = if ext == "xlsx" {
            let cursor = remove_cdata_from_xlsx(path)?;
            let mut workbook = calamine::open_workbook_auto_from_rs(cursor)
                .map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        } else {
            let mut workbook = calamine::open_workbook_auto(path).map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        };
        let mut rows = range.rows();
        let headers: Vec<String> = rows
            .next()
            .map(|r| r.iter().map(|c| c.to_string().trim().to_string()).collect())
            .unwrap_or_default();

        let col_indices: Vec<usize> = excel_cols
            .iter()
            .map(|ec| headers.iter().position(|h| h == ec).unwrap_or(usize::MAX))
            .collect();

        let placeholders = db_cols.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table_name,
            db_cols.join(", "),
            placeholders
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

        for row in rows {
            let mut values: Vec<String> = vec![];
            for idx in &col_indices {
                if *idx == usize::MAX {
                    values.push(String::new());
                } else {
                    values.push(row.get(*idx).map(|c| c.to_string()).unwrap_or_default());
                }
            }
            let params: Vec<&dyn rusqlite::ToSql> = values.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            if let Err(e) = stmt.execute(params.as_slice()) {
                eprintln!("插入行失败: {}", e);
            } else {
                inserted += 1;
            }
        }
    } else {
        return Err("仅支持 xlsx/xls/csv 格式文件".to_string());
    }

    Ok(inserted)
}

fn emit_progress(app: &tauri::AppHandle, percent: i32, step: String, error_rows: i32) {
    let _ = app.emit("ingest-progress", serde_json::json!({
        "percent": percent,
        "step": step,
        "error_rows": error_rows,
    }));
}

#[derive(Serialize)]
struct EmbeddingReq {
    model: String,
    input: String,
}

#[derive(Deserialize)]
struct EmbeddingDataResp {
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct EmbeddingResp {
    data: Vec<EmbeddingDataResp>,
}

async fn get_embedding(text: String, config: &AppConfig) -> Result<Vec<f32>, String> {
    let client = reqwest::Client::new();
    let url = if config.ai_url.ends_with("/v1/embeddings") {
        config.ai_url.clone()
    } else if config.ai_url.ends_with("/v1") {
        format!("{}/embeddings", config.ai_url)
    } else if config.ai_url.ends_with("/") {
        format!("{}v1/embeddings", config.ai_url)
    } else {
        format!("{}/v1/embeddings", config.ai_url)
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.ai_key))
        .json(&EmbeddingReq {
            model: config
                .ai_model
                .replace("-chat", "-embedding")
                .replace("deepseek-chat", "text-embedding-3-small"),
            input: text,
        })
        .send()
        .await
        .map_err(|e| format!("Embedding 请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Embedding 接口错误: {}", resp.status()));
    }

    let body: EmbeddingResp = resp.json().await.map_err(|e| e.to_string())?;
    body.data
        .into_iter()
        .next()
        .map(|d| d.embedding)
        .ok_or_else(|| "Embedding 返回为空".to_string())
}

fn sanitize_col(name: &str) -> String {
    name.trim()
        .replace(|c: char| !c.is_alphanumeric() && c != '_', "_")
        .replace(" ", "_")
}

#[tauri::command]
async fn ingest_full_data(
    app: tauri::AppHandle,
    file_path: String,
    clean_sql: String,
    table_name: String,
) -> Result<(), String> {
    let config = load_config(app.clone()).await?;
    let path = std::path::Path::new(&file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    emit_progress(&app, 5, "正在读取表头...".to_string(), 0);

    let conn = init_db()?;
    let temp_table = format!("temp_{}", table_name);

    let columns: Vec<String>;
    if ext == "csv" {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut rdr = csv::Reader::from_reader(file);
        columns = rdr
            .headers()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|s| sanitize_col(s))
            .collect();
    } else if ext == "xlsx" || ext == "xls" {
        let range = if ext == "xlsx" {
            let cursor = remove_cdata_from_xlsx(path)?;
            let mut workbook = calamine::open_workbook_auto_from_rs(cursor)
                .map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        } else {
            let mut workbook = calamine::open_workbook_auto(path).map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        };
        columns = range
            .rows()
            .next()
            .map(|r| r.iter().map(|c| sanitize_col(&c.to_string())).collect())
            .unwrap_or_default();
    } else {
        return Err("仅支持 xlsx/xls/csv".to_string());
    }

    if columns.is_empty() {
        return Err("无法读取表头".to_string());
    }

    let _ = conn.execute(&format!("DROP TABLE IF EXISTS {}", temp_table), []);
    let _ = conn.execute(&format!("DROP TABLE IF EXISTS {}", table_name), []);

    let cols_def = columns.iter().map(|c| format!("{} TEXT", c)).collect::<Vec<_>>().join(", ");
    conn.execute(
        &format!("CREATE TABLE {} ({})", temp_table, cols_def),
        [],
    )
    .map_err(|e| format!("创建临时表失败: {}", e))?;

    emit_progress(&app, 10, "正在分块读取数据...".to_string(), 0);
    let chunk_size = 5000;
    let mut error_rows = 0;
    let mut total_rows = 0;

    if ext == "csv" {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut rdr = csv::Reader::from_reader(file);
        let mut chunk: Vec<Vec<String>> = vec![];
        for result in rdr.records() {
            match result {
                Ok(rec) => {
                    chunk.push(rec.iter().map(|s| s.to_string()).collect());
                    if chunk.len() >= chunk_size {
                        total_rows += chunk.len();
                        insert_chunk(&conn, &temp_table, &columns, &chunk)?;
                        chunk.clear();
                        emit_progress(&app, 10 + (total_rows / 1000).min(60) as i32, format!("已写入 {} 行...", total_rows), error_rows);
                    }
                }
                Err(_) => error_rows += 1,
            }
        }
        if !chunk.is_empty() {
            total_rows += chunk.len();
            insert_chunk(&conn, &temp_table, &columns, &chunk)?;
        }
    } else {
        let range = if ext == "xlsx" {
            let cursor = remove_cdata_from_xlsx(path)?;
            let mut workbook = calamine::open_workbook_auto_from_rs(cursor)
                .map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        } else {
            let mut workbook = calamine::open_workbook_auto(path).map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        };
        let mut rows = range.rows();
        rows.next(); // skip header
        let mut chunk: Vec<Vec<String>> = vec![];
        for row in rows {
            let row_vals: Vec<String> = row.iter().map(|c| c.to_string()).collect();
            if row_vals.iter().all(|v| v.trim().is_empty()) {
                error_rows += 1;
                continue;
            }
            chunk.push(row_vals);
            if chunk.len() >= chunk_size {
                total_rows += chunk.len();
                insert_chunk(&conn, &temp_table, &columns, &chunk)?;
                chunk.clear();
                emit_progress(&app, 10 + (total_rows / 1000).min(60) as i32, format!("已写入 {} 行...", total_rows), error_rows);
            }
        }
        if !chunk.is_empty() {
            total_rows += chunk.len();
            insert_chunk(&conn, &temp_table, &columns, &chunk)?;
        }
    }

    emit_progress(&app, 70, "正在执行 SQL 清洗数据...".to_string(), error_rows);

    let cleaned_sql = clean_sql.replace("temp_table", &temp_table);
    if let Err(e) = conn.execute_batch(&cleaned_sql) {
        let actual_cols = columns.join(", ");
        return Err(format!(
            "SQL 清洗失败: {}。\n【诊断】temp_table({}) 的实际列名为: [{}]。\n请检查 AI 生成的 clean_sql 是否严格使用了上述列名，禁止改名或增减列。",
            e, temp_table, actual_cols
        ));
    }

    // 为前5列创建索引，加速后续条件查询
    for col in columns.iter().take(5) {
        let idx_name = format!("idx_{}_{}", table_name, col)
            .replace(|c: char| !c.is_alphanumeric() && c != '_', "_");
        let idx_sql = format!(r#"CREATE INDEX IF NOT EXISTS "{}" ON "{}" ("{}")"#, idx_name, table_name, col);
        let _ = conn.execute(&idx_sql, []);
    }

    emit_progress(&app, 85, "正在生成知识库摘要...".to_string(), error_rows);

    // 查询关联的看板
    let linked_dashboards: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM dashboards WHERE sql_template LIKE ?1")
            .map_err(|e| e.to_string())?;
        let pattern = format!("%{}%", table_name);
        let rows = stmt
            .query_map([pattern], |row| {
                let name: String = row.get(0)?;
                Ok(name)
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let dashboard_links_json = serde_json::to_string(&linked_dashboards).unwrap_or_default();

    // 生成小白友好的表描述
    let column_desc = columns
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}. {}", i + 1, c))
        .collect::<Vec<_>>()
        .join("；");

    let summary = format!(
        "📊 数据表《{}》已入库，包含 {} 个字段，共 {} 行数据。\n\n字段明细：{}\n\n关联看板：{}",
        table_name,
        columns.len(),
        total_rows,
        column_desc,
        if linked_dashboards.is_empty() {
            "暂无".to_string()
        } else {
            linked_dashboards.join("、")
        }
    );

    let description = format!(
        "这是一张{}数据表，主要用于存储{}相关数据。包含{}个核心字段。",
        table_name,
        columns.first().map(|s| s.as_str()).unwrap_or("业务"),
        columns.len()
    );

    if !config.ai_url.is_empty() && !config.ai_key.is_empty() {
        match get_embedding(summary.clone(), &config).await {
            Ok(vec) => {
                let vec_bytes: Vec<u8> = vec.iter().flat_map(|f| f.to_ne_bytes()).collect();
                conn.execute(
                    "INSERT OR REPLACE INTO kb_docs (table_name, content, description, dashboard_links, vec) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![table_name, summary, description, dashboard_links_json, vec_bytes],
                )
                .map_err(|e| e.to_string())?;
            }
            Err(e) => {
                eprintln!("Embedding 失败: {}", e);
            }
        }
    }

    emit_progress(&app, 100, "入库完成".to_string(), error_rows);

    if error_rows > 0 {
        let _ = app.emit("ingest-complete", serde_json::json!({
            "message": format!("入库成功，但跳过了 {} 行异常数据", error_rows)
        }));
    }

    Ok(())
}

/// 快速将单个文件原样入库（不做 AI 清洗），供聊天附件预入库使用。
/// 返回 DbTablePreviewPayload，方便前端直接加入 dbTablePreviews。
#[tauri::command]
async fn quick_ingest_file(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<DbTablePreviewPayload, String> {
    let path = std::path::Path::new(&file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // 1. 生成唯一表名（复用前端 toTargetName + ensureUniqueName 逻辑）
    let base_name = {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("data");
        let sanitized: String = stem
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
            .collect();
        if sanitized.is_empty() || sanitized.chars().all(|c| c == '_') {
            "t_data".to_string()
        } else {
            sanitized
        }
    };

    let conn = init_db()?;
    let existing_tables: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let table_name = {
        if !existing_tables.contains(&base_name) {
            base_name.clone()
        } else {
            let mut idx = 2;
            loop {
                let candidate = format!("{}_{}", base_name, idx);
                if !existing_tables.contains(&candidate) {
                    break candidate;
                }
                idx += 1;
            }
        }
    };

    // 2. 读取表头
    let columns: Vec<String>;
    if ext == "csv" {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut rdr = csv::Reader::from_reader(file);
        columns = rdr
            .headers()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|s| sanitize_col(s))
            .collect();
    } else if ext == "xlsx" || ext == "xls" {
        let range = if ext == "xlsx" {
            let cursor = remove_cdata_from_xlsx(path)?;
            let mut workbook = calamine::open_workbook_auto_from_rs(cursor)
                .map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        } else {
            let mut workbook = calamine::open_workbook_auto(path).map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        };
        columns = range
            .rows()
            .next()
            .map(|r| r.iter().map(|c| sanitize_col(&c.to_string())).collect())
            .unwrap_or_default();
    } else {
        return Err("仅支持 xlsx/xls/csv".to_string());
    }

    if columns.is_empty() {
        return Err("无法读取表头".to_string());
    }

    // 3. 建表（全部 TEXT）
    let cols_def = columns
        .iter()
        .map(|c| format!("{} TEXT", c))
        .collect::<Vec<_>>()
        .join(", ");
    let _ = conn.execute(&format!("DROP TABLE IF EXISTS {}", table_name), []);
    conn.execute(
        &format!("CREATE TABLE {} ({})", table_name, cols_def),
        [],
    )
    .map_err(|e| format!("创建表失败: {}", e))?;

    // 4. 写入数据
    let chunk_size = 5000;
    if ext == "csv" {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut rdr = csv::Reader::from_reader(file);
        let mut chunk: Vec<Vec<String>> = vec![];
        for result in rdr.records() {
            if let Ok(rec) = result {
                chunk.push(rec.iter().map(|s| s.to_string()).collect());
                if chunk.len() >= chunk_size {
                    insert_chunk(&conn, &table_name, &columns, &chunk)?;
                    chunk.clear();
                }
            }
        }
        if !chunk.is_empty() {
            insert_chunk(&conn, &table_name, &columns, &chunk)?;
        }
    } else {
        let range = if ext == "xlsx" {
            let cursor = remove_cdata_from_xlsx(path)?;
            let mut workbook = calamine::open_workbook_auto_from_rs(cursor)
                .map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        } else {
            let mut workbook = calamine::open_workbook_auto(path).map_err(|e| e.to_string())?;
            let first_sheet = workbook.sheet_names().get(0).cloned().unwrap_or_default();
            workbook
                .worksheet_range(&first_sheet)
                .map_err(|e| e.to_string())?
        };
        let mut rows = range.rows();
        rows.next(); // skip header
        let mut chunk: Vec<Vec<String>> = vec![];
        for row in rows {
            let row_vals: Vec<String> = row.iter().map(|c| c.to_string()).collect();
            if row_vals.iter().all(|v| v.trim().is_empty()) {
                continue;
            }
            chunk.push(row_vals);
            if chunk.len() >= chunk_size {
                insert_chunk(&conn, &table_name, &columns, &chunk)?;
                chunk.clear();
            }
        }
        if !chunk.is_empty() {
            insert_chunk(&conn, &table_name, &columns, &chunk)?;
        }
    }

    // 5. 取前 5 行作为预览返回
    let preview_data: Vec<Vec<String>> = {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {} LIMIT 5", table_name))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let mut vals = vec![];
                for i in 0..columns.len() {
                    vals.push(row.get::<_, String>(i).unwrap_or_default());
                }
                Ok(vals)
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    Ok(DbTablePreviewPayload {
        table_name,
        remark: String::new(),
        columns,
        preview_data,
        column_remarks: std::collections::HashMap::new(),
    })
}

fn insert_chunk(
    conn: &rusqlite::Connection,
    table: &str,
    columns: &[String],
    chunk: &[Vec<String>],
) -> Result<(), String> {
    let placeholders = columns.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        table,
        columns.join(", "),
        placeholders
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    for row in chunk {
        let params: Vec<&dyn rusqlite::ToSql> =
            row.iter().map(|s: &String| s as &dyn rusqlite::ToSql).collect();
        if let Err(e) = stmt.execute(params.as_slice()) {
            eprintln!("插入行失败: {}", e);
        }
    }
    Ok(())
}

#[tauri::command]
async fn search_kb(app: tauri::AppHandle, query: String, top_k: i32) -> Result<Vec<String>, String> {
    let config = load_config(app).await?;
    let query_vec = get_embedding(query, &config).await?;
    let conn = init_db()?;

    let mut stmt = conn
        .prepare("SELECT content, vec FROM kb_docs")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let content: String = row.get(0)?;
            let vec_blob: Vec<u8> = row.get(1)?;
            Ok((content, vec_blob))
        })
        .map_err(|e| e.to_string())?;

    let mut scored: Vec<(f32, String)> = vec![];
    for row in rows {
        let (content, blob) = row.map_err(|e| e.to_string())?;
        let vec: Vec<f32> = blob
            .chunks_exact(4)
            .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        if vec.len() == query_vec.len() {
            let score = cosine_similarity(&query_vec, &vec);
            scored.push((score, content));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    Ok(scored.into_iter().take(top_k as usize).map(|(_, c)| c).collect())
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a * norm_b)
    }
}

#[tauri::command]
async fn start_share_server(
    app: tauri::AppHandle,
    board_id: String,
    allow_refresh: bool,
) -> Result<server::ShareInfo, String> {
    let dashboard = get_dashboard(board_id.clone()).await?;
    let board_data = serde_json::json!({
        "id": dashboard.id,
        "name": dashboard.name,
        "description": dashboard.description,
        "sql_template": dashboard.sql_template,
        "ui_filters": dashboard.ui_filters,
        "charts": dashboard.charts,
        "table_data": dashboard.table_data,
        "source_table": dashboard.source_table,
        "actions": dashboard.actions,
        "summary_cards": dashboard.summary_cards,
        "html_content": dashboard.html_content,
    });
    let info = server::start_share_server(board_id.clone(), allow_refresh, board_data, None).await?;
    let persisted = PersistedShareInfo {
        board_id,
        url: info.url.clone(),
        pin: info.pin.clone(),
        port: info.url.split(':').nth(2).and_then(|s| s.split('/').next()?.parse().ok()).unwrap_or(8080),
        allow_refresh,
    };
    let _ = save_share_status(app, persisted).await;
    Ok(info)
}

#[tauri::command]
async fn stop_share_server(app: tauri::AppHandle) -> Result<(), String> {
    server::stop_share_server().await?;
    clear_share_status(app).await?;
    Ok(())
}

#[tauri::command]
async fn get_share_status(app: tauri::AppHandle) -> Result<Option<PersistedShareInfo>, String> {
    // 先查内存
    let mem_status = server::get_share_status().await?;
    if let Some(mem) = mem_status {
        return Ok(Some(PersistedShareInfo {
            board_id: mem.board_id,
            url: mem.url,
            pin: mem.pin,
            port: mem.port,
            allow_refresh: mem.allow_refresh,
        }));
    }
    // 内存没有，查持久化
    load_share_status(app).await
}

// ========== Dashboard Pack / Import ==========

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ColumnDef {
    pub name: String,
    pub type_name: String,
    pub notnull: bool,
    pub dflt_value: Option<String>,
    pub pk: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TablePack {
    pub original_name: String,
    pub columns: Vec<ColumnDef>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DashboardPack {
    pub version: String,
    pub dashboard: Dashboard,
    pub table_data: Option<TablePack>,
}

#[tauri::command]
async fn pack_dashboard(dashboard_id: String) -> Result<String, String> {
    let dashboard = get_dashboard(dashboard_id.clone()).await?;

    let source_table = dashboard.source_table.clone();

    let table_pack = if let Some(ref table_name) = source_table {
        let conn = init_db()?;

        // 获取表结构
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({})", table_name))
            .map_err(|e| e.to_string())?;
        let col_rows = stmt.query_map([], |row| {
            Ok(ColumnDef {
                name: row.get(1)?,
                type_name: row.get(2)?,
                notnull: row.get::<_, i32>(3)? != 0,
                dflt_value: row.get(4)?,
                pk: row.get::<_, i32>(5)? != 0,
            })
        }).map_err(|e| e.to_string())?;

        let mut columns = vec![];
        for row in col_rows {
            columns.push(row.map_err(|e| e.to_string())?);
        }
        drop(stmt);

        // 获取所有数据
        let mut stmt = conn
            .prepare(&format!(r#"SELECT * FROM "{}""#, table_name))
            .map_err(|e| e.to_string())?;
        let col_count = columns.len();
        let rows = stmt.query_map([], move |row| {
            let mut vals: Vec<String> = vec![];
            for i in 0..col_count {
                let val_ref = row.get_ref(i)?;
                let val: String = match val_ref {
                    rusqlite::types::ValueRef::Null => String::new(),
                    rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                    rusqlite::types::ValueRef::Real(f) => f.to_string(),
                    rusqlite::types::ValueRef::Text(s) => String::from_utf8_lossy(s).to_string(),
                    rusqlite::types::ValueRef::Blob(_) => "<BLOB>".to_string(),
                };
                vals.push(val);
            }
            Ok(vals)
        }).map_err(|e| e.to_string())?;

        let mut data_rows = vec![];
        for row in rows {
            data_rows.push(row.map_err(|e| e.to_string())?);
        }

        Some(TablePack {
            original_name: table_name.clone(),
            columns,
            rows: data_rows,
        })
    } else {
        None
    };

    let pack = DashboardPack {
        version: "1.0".to_string(),
        dashboard,
        table_data: table_pack,
    };

    let json = serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())?;

    let download_dir = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .ok_or("无法获取下载目录")?;

    let file_name = format!("dashboard_pack_{}.json", dashboard_id);
    let file_path = download_dir.join(&file_name);
    std::fs::write(&file_path, json).map_err(|e| e.to_string())?;

    Ok(file_path.to_string_lossy().to_string())
}

fn find_available_table_name(conn: &rusqlite::Connection, base_name: &str) -> Result<String, String> {
    let exists: bool = conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [base_name],
        |_| Ok(true),
    ).unwrap_or(false);

    if !exists {
        return Ok(base_name.to_string());
    }

    let mut suffix = 1;
    loop {
        let candidate = format!("{}_{}", base_name, suffix);
        let exists: bool = conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [&candidate],
            |_| Ok(true),
        ).unwrap_or(false);

        if !exists {
            return Ok(candidate);
        }
        suffix += 1;

        if suffix > 1000 {
            return Err("无法找到可用的表名".to_string());
        }
    }
}

fn replace_table_name_in_sql(sql: &str, old_name: &str, new_name: &str) -> String {
    let pattern = format!(r#"\b{}\b"#, regex::escape(old_name));
    let re = regex::Regex::new(&pattern).unwrap();
    re.replace_all(sql, new_name).to_string()
}

#[tauri::command]
async fn import_dashboard_pack(file_path: String) -> Result<String, String> {
    let content = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let pack: DashboardPack = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let conn = init_db()?;

    // 1. 检查并自动重命名表
    let final_table_name = if let Some(ref table_pack) = pack.table_data {
        let original_name = &table_pack.original_name;
        let available_name = find_available_table_name(&conn, original_name)?;

        if available_name != *original_name {
            println!("[import] 表名 {} 已存在，重命名为 {}", original_name, available_name);
        }

        // 2. 创建新表
        let cols_def = table_pack.columns.iter().map(|c| {
            let default = match &c.dflt_value {
                Some(d) => format!(" DEFAULT '{}'", d),
                None => String::new(),
            };
            let notnull = if c.notnull { " NOT NULL" } else { "" };
            format!("{} {}{}{}", c.name, c.type_name, notnull, default)
        }).collect::<Vec<_>>().join(", ");

        let pk_cols: Vec<String> = table_pack.columns.iter()
            .filter(|c| c.pk)
            .map(|c| c.name.clone())
            .collect();

        let pk_clause = if !pk_cols.is_empty() {
            format!(", PRIMARY KEY ({})", pk_cols.join(", "))
        } else {
            String::new()
        };

        let create_sql = format!(
            r#"CREATE TABLE "{}" ({}{})"#,
            available_name, cols_def, pk_clause
        );
        conn.execute(&create_sql, []).map_err(|e| e.to_string())?;

        // 3. 插入数据（使用事务批量插入）
        let placeholders = table_pack.columns.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let insert_sql = format!(
            r#"INSERT INTO "{}" ({}) VALUES ({})"#,
            available_name,
            table_pack.columns.iter().map(|c| format!("\"{}\"", c.name)).collect::<Vec<_>>().join(", "),
            placeholders
        );

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(&insert_sql).map_err(|e| e.to_string())?;
            for row in &table_pack.rows {
                let params: Vec<&dyn rusqlite::ToSql> =
                    row.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
                stmt.execute(params.as_slice()).map_err(|e| e.to_string())?;
            }
            drop(stmt);
        }
        tx.commit().map_err(|e| e.to_string())?;

        Some(available_name)
    } else {
        None
    };

    // 4. 插入看板记录，生成新ID
    let new_dashboard_id = Uuid::new_v4().to_string();
    let mut dashboard = pack.dashboard;
    dashboard.id = new_dashboard_id.clone();

    // 5. 替换 sql_template 和 html_content 中的旧表名
    if let Some(ref old_table) = pack.table_data {
        if let Some(ref new_table) = final_table_name {
            if let Some(ref mut sql) = dashboard.sql_template {
                *sql = replace_table_name_in_sql(sql, &old_table.original_name, new_table);
            }
            if let Some(ref mut html) = dashboard.html_content {
                *html = replace_table_name_in_sql(html, &old_table.original_name, new_table);
            }
        }
    }

    // 更新 source_table
    if final_table_name.is_some() {
        dashboard.source_table = final_table_name;
    }

    conn.execute(
        "INSERT INTO dashboards (id, name, description, sql_template, ui_filters, charts, table_data, source_table, actions, summary_cards, html_content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'), datetime('now'))",
        rusqlite::params![
            dashboard.id,
            dashboard.name,
            dashboard.description,
            dashboard.sql_template,
            dashboard.ui_filters,
            dashboard.charts,
            dashboard.table_data,
            dashboard.source_table,
            dashboard.actions,
            dashboard.summary_cards,
            dashboard.html_content,
        ],
    ).map_err(|e| e.to_string())?;

    Ok(new_dashboard_id)
}

/// 重新生成指定看板的 table_data：从 source_table 拉取全量数据写入 JSON
#[tauri::command]
fn refresh_dashboard_table_data(id: String) -> Result<usize, String> {
    let conn = init_db()?;

    // 1. 读取看板的 source_table
    let source_table: String = conn
        .query_row(
            "SELECT source_table FROM dashboards WHERE id = ?1",
            [&id],
            |row| row.get(0),
        )
        .map_err(|e| format!("看板不存在或无关联数据表: {}", e))?;

    if source_table.is_empty() {
        return Err("该看板没有关联数据表(source_table)，无法重建数据".to_string());
    }

    // 2. 查询 source_table 的列名
    let mut col_stmt = conn
        .prepare(&format!("PRAGMA table_info({})", source_table))
        .map_err(|e| format!("读取表结构失败: {}", e))?;
    let col_rows = col_stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    let mut columns: Vec<String> = vec![];
    for row in col_rows {
        columns.push(row.map_err(|e| e.to_string())?);
    }

    if columns.is_empty() {
        return Err(format!("数据表 '{}' 没有任何列", source_table));
    }

    // 3. 查询 source_table 全部数据（转成 JSON 数组）
    let sql = format!("SELECT * FROM \"{}\"", source_table);
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("查询数据失败: {}", e))?;
    let col_count = columns.len();
    let rows = stmt
        .query_map([], |row| {
            let mut obj = serde_json::Map::new();
            for i in 0..col_count {
                let key = &columns[i];
                let val = match row.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => serde_json::Value::Number(n.into()),
                    rusqlite::types::ValueRef::Real(f) => {
                        serde_json::Value::Number(serde_json::Number::from_f64(f).unwrap_or(serde_json::Number::from(0)))
                    }
                    rusqlite::types::ValueRef::Text(s) => serde_json::Value::String(String::from_utf8_lossy(s).to_string()),
                    rusqlite::types::ValueRef::Blob(_) => serde_json::Value::String("<BLOB>".to_string()),
                };
                obj.insert(key.clone(), val);
            }
            Ok(serde_json::Value::Object(obj))
        })
        .map_err(|e| e.to_string())?;

    let mut data: Vec<serde_json::Value> = vec![];
    for r in rows {
        data.push(r.map_err(|e| e.to_string())?);
    }

    let table_data_json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    let row_count = data.len();

    // 4. 写回 dashboards.table_data
    conn.execute(
        "UPDATE dashboards SET table_data = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        rusqlite::params![&table_data_json, &id],
    )
    .map_err(|e| format!("更新看板数据失败: {}", e))?;

    println!("[refresh_dashboard_table_data] 看板 {} 的 table_data 已重建，共 {} 行", id, row_count);
    Ok(row_count)
}

#[tauri::command]
async fn start_bot(app: tauri::AppHandle) -> Result<(), String> {
    bot::start_bot(app).await
}

#[tauri::command]
async fn get_bot_status() -> serde_json::Value {
    bot::get_bot_status().await
}

// ========== Task 3: HTML 模板 + 数据源一键生成看板 ==========

const HTML_TABLE_DESIGN_SYSTEM_PROMPT: &str = r#"你是 SQLite 建表专家。用户上传了一个看板设计稿（HTML 摘要）和若干表格文件预览，需要你为每个表格设计 SQLite 建表与清洗 SQL，以及字段中文备注。

【硬约束】
- 数据库是 SQLite，不能用 MySQL 语法（不能用 AUTO_INCREMENT，不能用 ENUM，VARCHAR 改为 TEXT）
- 列名只能用 ASCII 字母数字下划线，不能用中文（中文放到 column_remarks 里）
- 列名顺序必须与原始数据列顺序完全一致（系统会把原始数据先放到 temp_table，再用你给的 clean_sql 把数据写入正式表）
- 不要重复使用已存在的表名

【clean_sql 格式说明】
clean_sql 是一段可被 SQLite execute_batch 执行的 SQL，必须包含两条语句，分号分隔：
1) CREATE TABLE 正式表名 (...);  — 字段类型可以是 TEXT/INTEGER/REAL，按列含义合理选择
2) INSERT INTO 正式表名 SELECT [必要的 CAST/转换] FROM temp_table;
注意：写 SQL 时使用字符串 "temp_table"，系统会自动替换。temp_table 中所有列都是 TEXT，需要时显式 CAST(col AS INTEGER) 之类的。

【列名硬约束 — 必须遵守】
- 下方文件预览中的 "columns" 列表就是 temp_table 的精确列名，clean_sql 的 SELECT 子句必须逐字使用这些列名，禁止改名、禁止增减列、禁止省略列。
- 如果列名含中文或特殊符号，系统已自动转义为安全的 ASCII 标识符，你直接使用预览中给出的列名即可。

【输出要求 — 必须严格遵守】
返回纯 JSON 对象，不要 markdown 围栏：
{
  "tables": [
    {
      "table_name": "英文表名",
      "clean_sql": "CREATE TABLE ...; INSERT INTO ... SELECT ... FROM temp_table;",
      "column_remarks": {"col1": "中文备注", "col2": "中文备注"}
    }
  ]
}
"#;

const HTML_DASHBOARD_DESIGN_SYSTEM_PROMPT: &str = r#"你是 SQLite 数据看板专家。用户提供了一个看板设计稿（HTML 摘要）和数据库中已有的表 schema，请根据设计稿生成一个数据看板配置。

【SQLite 与 MySQL 主要差异 — 必须遵守】
- 禁止 GROUP_CONCAT(... SEPARATOR x)，改用 GROUP_CONCAT(expr, '分隔符')
- 禁止 DATE_FORMAT，改用 strftime('%Y-%m-%d', col)
- 字符串拼接用 ||，不能用 CONCAT(...)
- 禁止 LIMIT n,m，改用 LIMIT n OFFSET m
- 没有 IF(cond, a, b)，用 CASE WHEN 或 IIF
- 禁止 RIGHT/LEFT(str, n)，用 substr
- 只能引用提示中给出的真实表名和列名

【输出要求 — 必须严格遵守】
返回纯 JSON 对象，不要 markdown 围栏：
{
  "action": "create_dashboard",
  "name": "看板中文名",
  "description": "简短描述（50字以内），说明这个看板主要展示什么业务数据和分析价值",
  "source_table": "主表英文名",
  "sql_template": "完整可执行的 SELECT 语句，可包含 {{filter_id}} 占位符",
  "ui_filters": [{"id":"filter_id","label":"中文","type":"input|select","default":"可选默认值"}],
  "charts": ["pie","bar","table"]
}
"#;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NewFileSpec {
    pub file_path: String,
    pub target_table_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CreateDashboardResult {
    pub dashboard_id: String,
    pub dashboard_name: String,
    pub created_tables: Vec<String>,
    pub warnings: Vec<String>,
}

fn emit_create_progress(
    app: &tauri::AppHandle,
    stage: &str,
    message: &str,
    detail: serde_json::Value,
) {
    let _ = app.emit(
        "create-dashboard-progress",
        serde_json::json!({
            "stage": stage,
            "message": message,
            "detail": detail,
        }),
    );
}

fn dashboard_ai_url(config: &AppConfig) -> String {
    if config.ai_url.ends_with("/v1/chat/completions") {
        config.ai_url.clone()
    } else if config.ai_url.ends_with("/v1") {
        format!("{}/chat/completions", config.ai_url)
    } else if config.ai_url.ends_with('/') {
        format!("{}v1/chat/completions", config.ai_url)
    } else {
        format!("{}/v1/chat/completions", config.ai_url)
    }
}

fn resolve_query_model(config: &AppConfig) -> String {
    if config.query_model.is_empty() {
        config.ai_model.clone()
    } else {
        config.query_model.clone()
    }
}

fn parse_ai_json(raw: &str) -> Result<serde_json::Value, String> {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(cleaned) {
        return Ok(v);
    }
    if let (Some(s), Some(e)) = (cleaned.find('{'), cleaned.rfind('}')) {
        if e > s {
            return serde_json::from_str(&cleaned[s..=e])
                .map_err(|err| format!("AI 返回不是合法 JSON: {}", err));
        }
    }
    Err("AI 返回不是合法 JSON".to_string())
}

#[tauri::command]
fn compress_html_for_ai(html: String) -> Result<String, String> {
    let mut s = html;

    // 1. 剥离 <script>...</script>
    loop {
        let lower = s.to_lowercase();
        let Some(start) = lower.find("<script") else { break };
        if let Some(rel_end) = lower[start..].find("</script>") {
            let end = start + rel_end + "</script>".len();
            s.replace_range(start..end, "");
        } else {
            s.truncate(start);
            break;
        }
    }

    // 2. 剥离 <style>...</style>
    loop {
        let lower = s.to_lowercase();
        let Some(start) = lower.find("<style") else { break };
        if let Some(rel_end) = lower[start..].find("</style>") {
            let end = start + rel_end + "</style>".len();
            s.replace_range(start..end, "");
        } else {
            s.truncate(start);
            break;
        }
    }

    // 3. 剥离 HTML 注释 <!-- ... -->
    loop {
        let Some(start) = s.find("<!--") else { break };
        if let Some(rel_end) = s[start..].find("-->") {
            let end = start + rel_end + 3;
            s.replace_range(start..end, "");
        } else {
            s.truncate(start);
            break;
        }
    }

    // 4. 剥离 base64 内联资源（data:...;base64,...）
    let mut out = String::with_capacity(s.len());
    let lower = s.to_lowercase();
    let mut idx = 0usize;
    while idx < s.len() {
        match lower[idx..].find("data:") {
            Some(rel) => {
                let data_start = idx + rel;
                out.push_str(&s[idx..data_start]);
                let after = &s[data_start..];
                let stop_rel = after
                    .find(|c: char| c == '"' || c == '\'' || c == ')')
                    .unwrap_or(after.len());
                out.push_str("[data-uri-stripped]");
                idx = data_start + stop_rel;
            }
            None => {
                out.push_str(&s[idx..]);
                break;
            }
        }
    }
    s = out;

    // 5. 折叠空白
    let mut compact = String::with_capacity(s.len());
    let mut last_was_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_was_ws {
                compact.push(' ');
                last_was_ws = true;
            }
        } else {
            compact.push(c);
            last_was_ws = false;
        }
    }
    s = compact.trim().to_string();

    // 6. 截断到 8KB
    if s.len() > 8192 {
        let mut end = 8192;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("... [HTML 已截断]");
    }

    Ok(s)
}

async fn create_dashboard_from_template_inner(
    app: tauri::AppHandle,
    html_content: String,
    new_files: Vec<NewFileSpec>,
    existing_tables: Vec<String>,
    dashboard_name: Option<String>,
) -> Result<CreateDashboardResult, String> {
    let config = load_config(app.clone()).await?;
    if config.ai_url.is_empty() || config.ai_key.is_empty() {
        return Err("请先配置 AI 接口地址和 API Key".to_string());
    }

    let mut warnings: Vec<String> = vec![];
    let mut created_tables: Vec<String> = vec![];

    // ------ Stage A: 压缩 HTML ------
    emit_create_progress(
        &app,
        "parse_html",
        "正在解析并压缩 HTML 模板",
        serde_json::Value::Null,
    );
    let html_summary = compress_html_for_ai(html_content.clone())?;
    if html_summary.len() > 8000 {
        warnings.push("HTML 摘要较长，AI 可能忽略部分细节".to_string());
    }

    // ------ Stage B: 读取每个文件预览 ------
    emit_create_progress(
        &app,
        "read_data",
        &format!("正在读取 {} 个数据文件", new_files.len()),
        serde_json::Value::Null,
    );
    let mut file_previews: Vec<serde_json::Value> = vec![];
    for (i, f) in new_files.iter().enumerate() {
        emit_create_progress(
            &app,
            "read_data",
            &format!("读取文件 {}/{}: {}", i + 1, new_files.len(), f.file_path),
            serde_json::json!({"current": i+1, "total": new_files.len()}),
        );
        let preview = parse_excel(f.file_path.clone())
            .await
            .map_err(|e| format!("解析 {} 失败: {}", f.file_path, e))?;
        let sheet = preview
            .sheets
            .into_iter()
            .next()
            .ok_or_else(|| format!("文件 {} 没有有效工作表", f.file_path))?;
        file_previews.push(serde_json::json!({
            "file_path": f.file_path,
            "target_table_name": f.target_table_name,
            "columns": sheet.columns,
            "preview_rows": sheet.preview_data.into_iter().take(5).collect::<Vec<_>>(),
        }));
    }

    // ------ Stage C: AI 设计建表/清洗方案 ------
    let mut new_table_specs: Vec<(String, String, std::collections::HashMap<String, String>)> =
        vec![];
    if !new_files.is_empty() {
        emit_create_progress(
            &app,
            "ai_design_tables",
            "AI 正在设计建表方案",
            serde_json::Value::Null,
        );

        let url = dashboard_ai_url(&config);
        let model = if config.ai_model.is_empty() {
            "deepseek-chat".to_string()
        } else {
            config.ai_model.clone()
        };
        let client = reqwest::Client::new();

        let existing_table_names_str = existing_tables.join(", ");
        let user_prompt = format!(
            "【看板设计稿 HTML 摘要】\n{}\n\n【现有数据库表名（避免冲突）】\n{}\n\n【需要新建的数据文件预览】\n{}\n\n【重要提醒】\n每个文件预览里的 \"columns\" 就是 temp_table 的精确列名，你的 clean_sql 中 SELECT 子句必须一字不差地使用这些列名，禁止改名或增减列。请按系统消息中的 JSON 格式返回建表方案。",
            html_summary,
            existing_table_names_str,
            serde_json::to_string_pretty(&file_previews).unwrap_or_default()
        );

        let mut ai_value: Option<serde_json::Value> = None;
        for attempt in 1..=2 {
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", config.ai_key))
                .json(&ChatRequest {
                    model: model.clone(),
                    messages: vec![
                        ChatMessage {
                            role: "system".into(),
                            content: HTML_TABLE_DESIGN_SYSTEM_PROMPT.into(),
                        },
                        ChatMessage {
                            role: "user".into(),
                            content: serde_json::Value::String(user_prompt.clone()),
                        },
                    ],
                    temperature: 0.1,
                })
                .send()
                .await
                .map_err(|e| format!("请求 AI 失败: {}", e))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if attempt == 2 {
                    return Err(format!("AI 接口返回错误 {}: {}", status, text));
                }
                continue;
            }
            let completion: ChatCompletion = resp
                .json()
                .await
                .map_err(|e| format!("解析 AI 响应失败: {}", e))?;
            let raw = completion
                .choices
                .get(0)
                .map(|c| c.message.content.clone())
                .unwrap_or_default();
            match parse_ai_json(&raw) {
                Ok(v) => {
                    ai_value = Some(v);
                    break;
                }
                Err(_) if attempt < 2 => continue,
                Err(e) => return Err(format!("AI 建表方案 JSON 解析失败: {}", e)),
            }
        }
        let ai_value = ai_value.ok_or("AI 未返回建表方案")?;

        let tables_arr = ai_value
            .get("tables")
            .and_then(|v| v.as_array())
            .ok_or("AI 返回缺少 tables 字段")?;
        for t in tables_arr {
            let table_name = t
                .get("table_name")
                .and_then(|v| v.as_str())
                .ok_or("table_name 缺失")?
                .to_string();
            let clean_sql = t
                .get("clean_sql")
                .and_then(|v| v.as_str())
                .ok_or("clean_sql 缺失")?
                .to_string();
            let mut remarks: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            if let Some(remarks_obj) = t.get("column_remarks").and_then(|v| v.as_object()) {
                for (k, v) in remarks_obj {
                    if let Some(s) = v.as_str() {
                        remarks.insert(k.clone(), s.to_string());
                    }
                }
            }
            new_table_specs.push((table_name, clean_sql, remarks));
        }

        // ------ Stage D: 入库（ingest_full_data 内部会建临时表 + 跑 clean_sql 建正式表）------
        for (i, (table_name, clean_sql, remarks)) in new_table_specs.iter().enumerate() {
            emit_create_progress(
                &app,
                "create_tables",
                &format!(
                    "正在创建表 {}/{}: {}",
                    i + 1,
                    new_table_specs.len(),
                    table_name
                ),
                serde_json::json!({"table": table_name, "current": i+1, "total": new_table_specs.len()}),
            );

            // 找到对应的源文件
            let file_spec = new_files
                .iter()
                .find(|f| &f.target_table_name == table_name)
                .or_else(|| new_files.get(i))
                .ok_or_else(|| format!("找不到表 {} 对应的源文件", table_name))?;

            ingest_full_data(
                app.clone(),
                file_spec.file_path.clone(),
                clean_sql.clone(),
                table_name.clone(),
            )
            .await
            .map_err(|e| format!("导入 {} 数据失败: {}", table_name, e))?;

            created_tables.push(table_name.clone());

            // 写中文备注
            for (col, remark) in remarks {
                let _ = set_column_remark(table_name.clone(), col.clone(), remark.clone());
            }
        }
    }

    // ------ Stage E: AI 设计看板配置 ------
    emit_create_progress(
        &app,
        "ai_design_dashboard",
        "AI 正在设计看板配置",
        serde_json::Value::Null,
    );

    let all_tables_schema = collect_schema_summary();
    let dashboard_url = dashboard_ai_url(&config);
    let model = if config.ai_model.is_empty() {
        "deepseek-chat".to_string()
    } else {
        config.ai_model.clone()
    };
    let client = reqwest::Client::new();
    let dashboard_user_prompt = format!(
        "【看板设计稿 HTML 摘要】\n{}\n\n【数据库所有用户表 schema（含中文备注）】\n{}\n\n{}请按系统消息中的 JSON 格式返回看板配置。",
        html_summary,
        all_tables_schema,
        dashboard_name
            .as_ref()
            .map(|n| format!("【期望看板名称】{}\n\n", n))
            .unwrap_or_default()
    );

    let mut dashboard_value: Option<serde_json::Value> = None;
    let mut last_err = String::new();
    for attempt in 1..=2 {
        let user_content = if last_err.is_empty() {
            dashboard_user_prompt.clone()
        } else {
            format!(
                "{}\n\n上次返回的 SQL 执行报错: {}\n请修正",
                dashboard_user_prompt, last_err
            )
        };
        let resp = client
            .post(&dashboard_url)
            .header("Authorization", format!("Bearer {}", config.ai_key))
            .json(&ChatRequest {
                model: model.clone(),
                messages: vec![
                    ChatMessage {
                        role: "system".into(),
                        content: HTML_DASHBOARD_DESIGN_SYSTEM_PROMPT.into(),
                    },
                    ChatMessage {
                        role: "user".into(),
                        content: serde_json::Value::String(user_content),
                    },
                ],
                temperature: 0.2,
            })
            .send()
            .await
            .map_err(|e| format!("请求 AI 失败: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if attempt == 2 {
                return Err(format!("AI 接口返回错误 {}: {}", status, text));
            }
            continue;
        }
        let completion: ChatCompletion = resp
            .json()
            .await
            .map_err(|e| format!("解析 AI 响应失败: {}", e))?;
        let raw = completion
            .choices
            .get(0)
            .map(|c| c.message.content.clone())
            .unwrap_or_default();
        let value = match parse_ai_json(&raw) {
            Ok(v) => v,
            Err(_) if attempt < 2 => continue,
            Err(e) => return Err(format!("AI 看板方案 JSON 解析失败: {}", e)),
        };
        // 用 EXPLAIN 预校验 sql_template（把 Result 抽出来避免 conn 生命周期问题）
        let explain_ok: Result<(), String> = if let Some(sql_t) = value.get("sql_template").and_then(|v| v.as_str()) {
            let test_sql = sql_t.replace("{{", "''").replace("}}", "''");
            let conn = init_db()?;
            conn.prepare(&format!("EXPLAIN {}", test_sql))
                .map(|_| ())
                .map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        match explain_ok {
            Ok(()) => {
                dashboard_value = Some(value);
                break;
            }
            Err(e) => {
                last_err = e;
                if attempt == 2 {
                    warnings.push(format!(
                        "看板 SQL EXPLAIN 校验失败，但仍创建（可由 AI 自动纠错）: {}",
                        last_err
                    ));
                    dashboard_value = Some(value);
                    break;
                }
            }
        }
    }
    let dashboard_value = dashboard_value.ok_or("AI 未返回看板配置")?;

    // ------ Stage F: 落库 ------
    emit_create_progress(
        &app,
        "finalize",
        "正在保存看板",
        serde_json::Value::Null,
    );
    let final_name = dashboard_value
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| dashboard_name.clone())
        .unwrap_or_else(|| "未命名看板".to_string());
    let description = dashboard_value
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from);
    let sql_template = dashboard_value
        .get("sql_template")
        .and_then(|v| v.as_str())
        .map(String::from);
    let ui_filters = dashboard_value.get("ui_filters").map(|v| v.to_string());
    let charts = dashboard_value.get("charts").map(|v| v.to_string());
    let table_data = dashboard_value
        .get("table_data")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| dashboard_value.get("table_data").map(|v| v.to_string()));
    let source_table = dashboard_value
        .get("source_table")
        .and_then(|v| v.as_str())
        .map(String::from);

    let dashboard_id = create_dashboard(
        final_name.clone(),
        description,
        sql_template,
        ui_filters,
        charts,
        table_data,
        source_table,
        None,
        None,
        Some(html_content.clone()),
        None,
        None,
        None,
    )
    .await?;

    emit_create_progress(
        &app,
        "done",
        "看板创建完成",
        serde_json::json!({
            "dashboard_id": dashboard_id,
            "dashboard_name": final_name,
            "created_tables": created_tables.clone(),
        }),
    );

    Ok(CreateDashboardResult {
        dashboard_id,
        dashboard_name: final_name,
        created_tables,
        warnings,
    })
}

#[tauri::command]
fn rollback_created_tables(table_names: Vec<String>) -> Result<(), String> {
    for t in table_names {
        let _ = drop_user_table(t);
    }
    Ok(())
}

/// 基于 AI 已经写好的完整 HTML 创建看板：
/// - 仍然走 Stage B/C/D 把 new_files 入库（如果有），并写中文备注；
/// - 跳过 Stage E（AI 不再设计 JSON 看板配置）；
/// - Stage F 直接用用户给的 html_content 落库，source_table 选第一张新建表，否则第一张 existing_tables。
async fn create_dashboard_from_ai_html_inner(
    app: tauri::AppHandle,
    html_content: String,
    new_files: Vec<NewFileSpec>,
    existing_tables: Vec<String>,
    dashboard_name: Option<String>,
) -> Result<CreateDashboardResult, String> {
    let config = load_config(app.clone()).await?;
    if config.ai_url.is_empty() || config.ai_key.is_empty() {
        return Err("请先配置 AI 接口地址和 API Key".to_string());
    }

    if html_content.trim().is_empty() {
        return Err("AI 没有返回 HTML 内容".to_string());
    }

    let mut warnings: Vec<String> = vec![];
    let mut created_tables: Vec<String> = vec![];

    // ------ Stage B: 读取每个文件预览 ------
    let mut file_previews: Vec<serde_json::Value> = vec![];
    if !new_files.is_empty() {
        emit_create_progress(
            &app,
            "read_data",
            &format!("正在读取 {} 个数据文件", new_files.len()),
            serde_json::Value::Null,
        );
        for (i, f) in new_files.iter().enumerate() {
            emit_create_progress(
                &app,
                "read_data",
                &format!("读取文件 {}/{}: {}", i + 1, new_files.len(), f.file_path),
                serde_json::json!({"current": i+1, "total": new_files.len()}),
            );
            let preview = parse_excel(f.file_path.clone())
                .await
                .map_err(|e| format!("解析 {} 失败: {}", f.file_path, e))?;
            let sheet = preview
                .sheets
                .into_iter()
                .next()
                .ok_or_else(|| format!("文件 {} 没有有效工作表", f.file_path))?;
            file_previews.push(serde_json::json!({
                "file_path": f.file_path,
                "target_table_name": f.target_table_name,
                "columns": sheet.columns,
                "preview_rows": sheet.preview_data.into_iter().take(5).collect::<Vec<_>>(),
            }));
        }
    }

    // ------ Stage C+D: 如果有新文件，让 AI 设计建表方案并入库 ------
    let mut new_table_specs: Vec<(String, String, std::collections::HashMap<String, String>)> =
        vec![];
    if !new_files.is_empty() {
        emit_create_progress(
            &app,
            "ai_design_tables",
            "AI 正在设计建表方案",
            serde_json::Value::Null,
        );

        let url = dashboard_ai_url(&config);
        let model = if config.ai_model.is_empty() {
            "deepseek-chat".to_string()
        } else {
            config.ai_model.clone()
        };
        let client = reqwest::Client::new();

        let existing_table_names_str = existing_tables.join(", ");
        let user_prompt = format!(
            "【AI 已生成的看板 HTML 摘要（仅供你判断字段口径，不要复述）】\n（已省略，仅根据下方文件预览设计建表）\n\n【现有数据库表名（避免冲突）】\n{}\n\n【需要新建的数据文件预览】\n{}\n\n【重要提醒】\n每个文件预览里的 \"columns\" 就是 temp_table 的精确列名，你的 clean_sql 中 SELECT 子句必须一字不差地使用这些列名，禁止改名或增减列。请按系统消息中的 JSON 格式返回建表方案。",
            existing_table_names_str,
            serde_json::to_string_pretty(&file_previews).unwrap_or_default()
        );

        let mut ai_value: Option<serde_json::Value> = None;
        for attempt in 1..=2 {
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", config.ai_key))
                .json(&ChatRequest {
                    model: model.clone(),
                    messages: vec![
                        ChatMessage {
                            role: "system".into(),
                            content: HTML_TABLE_DESIGN_SYSTEM_PROMPT.into(),
                        },
                        ChatMessage {
                            role: "user".into(),
                            content: serde_json::Value::String(user_prompt.clone()),
                        },
                    ],
                    temperature: 0.1,
                })
                .send()
                .await
                .map_err(|e| format!("请求 AI 失败: {}", e))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if attempt == 2 {
                    return Err(format!("AI 接口返回错误 {}: {}", status, text));
                }
                continue;
            }
            let completion: ChatCompletion = resp
                .json()
                .await
                .map_err(|e| format!("解析 AI 响应失败: {}", e))?;
            let raw = completion
                .choices
                .get(0)
                .map(|c| c.message.content.clone())
                .unwrap_or_default();
            match parse_ai_json(&raw) {
                Ok(v) => {
                    ai_value = Some(v);
                    break;
                }
                Err(_) if attempt < 2 => continue,
                Err(e) => return Err(format!("AI 建表方案 JSON 解析失败: {}", e)),
            }
        }
        let ai_value = ai_value.ok_or("AI 未返回建表方案")?;

        let tables_arr = ai_value
            .get("tables")
            .and_then(|v| v.as_array())
            .ok_or("AI 返回缺少 tables 字段")?;
        for t in tables_arr {
            let table_name = t
                .get("table_name")
                .and_then(|v| v.as_str())
                .ok_or("table_name 缺失")?
                .to_string();
            let clean_sql = t
                .get("clean_sql")
                .and_then(|v| v.as_str())
                .ok_or("clean_sql 缺失")?
                .to_string();
            let mut remarks: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            if let Some(remarks_obj) = t.get("column_remarks").and_then(|v| v.as_object()) {
                for (k, v) in remarks_obj {
                    if let Some(s) = v.as_str() {
                        remarks.insert(k.clone(), s.to_string());
                    }
                }
            }
            new_table_specs.push((table_name, clean_sql, remarks));
        }

        for (i, (table_name, clean_sql, remarks)) in new_table_specs.iter().enumerate() {
            emit_create_progress(
                &app,
                "create_tables",
                &format!(
                    "正在创建表 {}/{}: {}",
                    i + 1,
                    new_table_specs.len(),
                    table_name
                ),
                serde_json::json!({"table": table_name, "current": i+1, "total": new_table_specs.len()}),
            );

            let file_spec = new_files
                .iter()
                .find(|f| &f.target_table_name == table_name)
                .or_else(|| new_files.get(i))
                .ok_or_else(|| format!("找不到表 {} 对应的源文件", table_name))?;

            ingest_full_data(
                app.clone(),
                file_spec.file_path.clone(),
                clean_sql.clone(),
                table_name.clone(),
            )
            .await
            .map_err(|e| format!("导入 {} 数据失败: {}", table_name, e))?;

            created_tables.push(table_name.clone());

            for (col, remark) in remarks {
                let _ = set_column_remark(table_name.clone(), col.clone(), remark.clone());
            }
        }
    }

    // ------ 跳过 Stage E（AI 不再设计 JSON 看板配置）------

    // ------ Stage F: 直接用 AI 给的 HTML 落库 ------
    emit_create_progress(
        &app,
        "finalize",
        "正在保存看板",
        serde_json::Value::Null,
    );

    let source_table = created_tables
        .first()
        .cloned()
        .or_else(|| existing_tables.first().cloned())
        .ok_or("缺少 source_table：既没有新建表，也没有选择已有表")?;

    // 防御：source_table 必须真实存在于 SQLite，否则视为创建失败（避免看板挂着不存在的表）
    {
        let conn = init_db()?;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?1",
                rusqlite::params![&source_table],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(format!(
                "看板关联的数据表 '{}' 在数据库中不存在，看板创建未完成",
                source_table
            ));
        }
    }

    let final_name = dashboard_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "AI 生成看板".to_string());

    // 生成看板描述（使用查询模型，失败不阻塞）
    let dashboard_description = if !html_content.is_empty() {
        let desc_prompt = format!(
            "请根据以下数据看板 HTML 内容，生成一段简短的看板描述（30-80字），说明这个看板主要展示什么业务数据、有什么分析价值。只返回描述文本，不要加引号或其他格式。\n\nHTML 内容前 800 字符：\n{}\n关联数据表：{}",
            html_content.chars().take(800).collect::<String>(),
            source_table
        );
        let url = dashboard_ai_url(&config);
        let model = resolve_query_model(&config);
        let client = reqwest::Client::new();
        let req_body = ChatRequest {
            model,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: serde_json::Value::String(desc_prompt),
            }],
            temperature: 0.3,
        };
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.ai_key))
            .json(&req_body)
            .send()
            .await
        {
            Ok(resp) => match resp.json::<ChatCompletion>().await {
                Ok(completion) => completion
                    .choices
                    .get(0)
                    .map(|c| c.message.content.trim().to_string())
                    .filter(|s| !s.is_empty() && s != "null"),
                Err(_) => None,
            },
            Err(_) => None,
        }
    } else {
        None
    };

    let dashboard_id = create_dashboard(
        final_name.clone(),
        dashboard_description,
        None,
        None,
        None,
        None,
        Some(source_table.clone()),
        None,
        None,
        Some(html_content.clone()),
        None,
        None,
        None,
    )
    .await?;

    emit_create_progress(
        &app,
        "done",
        "看板创建完成",
        serde_json::json!({
            "dashboard_id": dashboard_id,
            "dashboard_name": final_name,
            "created_tables": created_tables.clone(),
        }),
    );

    Ok(CreateDashboardResult {
        dashboard_id,
        dashboard_name: final_name,
        created_tables,
        warnings,
    })
}

// ========== 看板创建失败暂存 / 重试 / 导出 ==========

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PendingDashboard {
    pub id: String,
    pub name: String,
    pub html_content: String,
    pub new_files: Vec<NewFileSpec>,
    pub existing_tables: Vec<String>,
    pub source: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn stash_pending_dashboard(
    id: &str,
    name: &str,
    html_content: &str,
    new_files: &[NewFileSpec],
    existing_tables: &[String],
    source: &str,
    last_error: &str,
) -> Result<(), String> {
    let conn = init_db()?;
    let new_files_json = serde_json::to_string(new_files).unwrap_or_else(|_| "[]".to_string());
    let existing_json = serde_json::to_string(existing_tables).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO pending_dashboards (id, name, html_content, new_files, existing_tables, source, last_error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now','localtime'))
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            html_content=excluded.html_content,
            new_files=excluded.new_files,
            existing_tables=excluded.existing_tables,
            source=excluded.source,
            last_error=excluded.last_error,
            updated_at=datetime('now','localtime')",
        rusqlite::params![id, name, html_content, new_files_json, existing_json, source, last_error],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_pending_row(id: &str) -> Result<(), String> {
    let conn = init_db()?;
    conn.execute("DELETE FROM pending_dashboards WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn finalize_create_result(
    app: &tauri::AppHandle,
    pending_id: &str,
    name_for_pending: &str,
    html_content: &str,
    new_files: &[NewFileSpec],
    existing_tables: &[String],
    source: &str,
    result: Result<CreateDashboardResult, String>,
) -> Result<CreateDashboardResult, String> {
    match result {
        Ok(r) => {
            let _ = delete_pending_row(pending_id);
            Ok(r)
        }
        Err(e) => {
            let _ = stash_pending_dashboard(
                pending_id,
                name_for_pending,
                html_content,
                new_files,
                existing_tables,
                source,
                &e,
            );
            emit_create_progress(
                app,
                "error",
                &e,
                serde_json::json!({
                    "pending_id": pending_id,
                    "error": e,
                }),
            );
            Err(format!(
                "{}\n\n看板已暂存到「待创建看板」，可在看板列表中重试或导出 HTML。",
                e
            ))
        }
    }
}

#[tauri::command]
async fn create_dashboard_from_ai_html(
    app: tauri::AppHandle,
    html_content: String,
    new_files: Vec<NewFileSpec>,
    existing_tables: Vec<String>,
    dashboard_name: Option<String>,
) -> Result<CreateDashboardResult, String> {
    let pending_id = Uuid::new_v4().to_string();
    let name_for_pending = dashboard_name
        .clone()
        .unwrap_or_else(|| "AI 看板".to_string());
    let result = create_dashboard_from_ai_html_inner(
        app.clone(),
        html_content.clone(),
        new_files.clone(),
        existing_tables.clone(),
        dashboard_name,
    )
    .await;
    finalize_create_result(
        &app,
        &pending_id,
        &name_for_pending,
        &html_content,
        &new_files,
        &existing_tables,
        "ai_html",
        result,
    )
}

#[tauri::command]
async fn create_dashboard_from_template(
    app: tauri::AppHandle,
    html_content: String,
    new_files: Vec<NewFileSpec>,
    existing_tables: Vec<String>,
    dashboard_name: Option<String>,
) -> Result<CreateDashboardResult, String> {
    let pending_id = Uuid::new_v4().to_string();
    let name_for_pending = dashboard_name
        .clone()
        .unwrap_or_else(|| "模板看板".to_string());
    let result = create_dashboard_from_template_inner(
        app.clone(),
        html_content.clone(),
        new_files.clone(),
        existing_tables.clone(),
        dashboard_name,
    )
    .await;
    finalize_create_result(
        &app,
        &pending_id,
        &name_for_pending,
        &html_content,
        &new_files,
        &existing_tables,
        "template",
        result,
    )
}

#[tauri::command]
async fn list_pending_dashboards() -> Result<Vec<PendingDashboard>, String> {
    let conn = init_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, html_content, new_files, existing_tables, source, last_error, created_at, updated_at
             FROM pending_dashboards ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let new_files_json: String = row.get(3)?;
            let existing_json: String = row.get(4)?;
            Ok(PendingDashboard {
                id: row.get(0)?,
                name: row.get(1)?,
                html_content: row.get(2)?,
                new_files: serde_json::from_str(&new_files_json).unwrap_or_default(),
                existing_tables: serde_json::from_str(&existing_json).unwrap_or_default(),
                source: row.get(5)?,
                last_error: row.get(6).ok(),
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        if let Ok(p) = r {
            out.push(p);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn delete_pending_dashboard(id: String) -> Result<(), String> {
    delete_pending_row(&id)
}

#[tauri::command]
async fn retry_pending_dashboard(
    app: tauri::AppHandle,
    id: String,
    new_files: Vec<NewFileSpec>,
    existing_tables: Vec<String>,
) -> Result<CreateDashboardResult, String> {
    let conn = init_db()?;
    let (name, html_content, source): (String, String, String) = conn
        .query_row(
            "SELECT name, html_content, source FROM pending_dashboards WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("找不到待创建看板: {}", e))?;
    drop(conn);

    let result = if source == "template" {
        create_dashboard_from_template_inner(
            app.clone(),
            html_content.clone(),
            new_files.clone(),
            existing_tables.clone(),
            Some(name.clone()),
        )
        .await
    } else {
        create_dashboard_from_ai_html_inner(
            app.clone(),
            html_content.clone(),
            new_files.clone(),
            existing_tables.clone(),
            Some(name.clone()),
        )
        .await
    };

    finalize_create_result(
        &app,
        &id,
        &name,
        &html_content,
        &new_files,
        &existing_tables,
        &source,
        result,
    )
}

#[tauri::command]
async fn export_pending_html(id: String, save_path: String) -> Result<(), String> {
    let conn = init_db()?;
    let html_content: String = conn
        .query_row(
            "SELECT html_content FROM pending_dashboards WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("找不到待创建看板: {}", e))?;
    std::fs::write(&save_path, html_content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--flag1", "--flag2"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 启动时加载配置到内存缓存
            tauri::async_runtime::spawn(async move {
                if let Ok(cfg) = load_config(app_handle.clone()).await {
                    if let Ok(mut cache) = CONFIG_CACHE.lock() {
                        *cache = cfg;
                        println!("[startup] 配置已加载到内存缓存");
                    }
                }
            });

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(Some(status)) = load_share_status(app_handle.clone()).await {
                    println!("[startup] 发现之前分享的看板，正在恢复: {}", status.board_id);
                    if let Err(e) = restart_share_server(app_handle.clone(), status.board_id, status.allow_refresh).await {
                        eprintln!("[startup] 恢复分享服务器失败: {}", e);
                        let _ = clear_share_status(app_handle).await;
                    }
                }
            });

            // 启动定时任务调度器
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    check_and_run_schedules(app_handle.clone()).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_config,
            load_config,
            test_dingtalk_conn,
            parse_excel,
            chat_with_ai,
            chat_workbench,
            ingest_full_data,
            quick_ingest_file,
            search_kb,
            get_db_tables,
            list_db_tables_for_chat,
            get_table_schema,
            query_table_data,
            drop_user_table,
            start_share_server,
            stop_share_server,
            get_share_status,
            start_bot,
            get_bot_status,
            create_session,
            get_sessions,
            get_session,
            update_session,
            delete_session,
            create_dashboard,
            get_dashboards,
            get_dashboard,
            update_dashboard,
            delete_dashboard,
            execute_dashboard_sql,
            run_sql_query_for_chat,
            execute_dashboard_sql_with_repair,
            modify_dashboard,
            get_local_db_path,
            get_local_ip,
            update_table_row,
            batch_update_rows,
            import_excel_to_table,
            get_table_primary_key,
            get_column_remarks,
            set_column_remark,
            get_table_remark,
            refresh_dashboard_table_data,
            set_table_remark,
            get_table_mappings,
            save_table_mappings,
            compress_html_for_ai,
            create_dashboard_from_template,
            create_dashboard_from_ai_html,
            list_pending_dashboards,
            delete_pending_dashboard,
            retry_pending_dashboard,
            export_pending_html,
            rollback_created_tables,
            rollback_dashboard,
            log_to_terminal,
            render_html_dashboard,
            check_refresh_signals,
            pack_dashboard,
            import_dashboard_pack,
            read_file_base64,
            create_schedule,
            update_schedule,
            delete_schedule,
            get_schedules,
            get_schedule_logs,
            test_private_message,
            test_schedule_run,
            sync_dingtalk_sheet,
            import_dingtalk_sheet,
            get_unionid_by_mobile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

