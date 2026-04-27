use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tokio::sync::Mutex;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;

use crate::{init_db, load_config, resolve_query_model, AppConfig};

static BOT_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct BotStatus {
    pub connected: bool,
    pub last_ping: String,
}

static STATUS: once_cell::sync::Lazy<Mutex<BotStatus>> =
    once_cell::sync::Lazy::new(|| {
        Mutex::new(BotStatus {
            connected: false,
            last_ping: "--".to_string(),
        })
    });

const BOT_SYSTEM_PROMPT: &str = r#"你是企业数据助手"小妮"，专门帮助不懂技术的小白用户查看业务数据。

你拥有以下工具：
- query_sql(sql: string): 执行本地 SQLite 查询并返回结果。

工作流：
1. 分析用户问题，判断是否需要查询数据库。
2. 如果我在上下文中已经给了你看板明细数据（前 20 行预览），并且这些数据已经能回答用户问题，请直接引用这些数据作答，不要调用 query_sql。
3. 只有看板明细中确实找不到答案时，才生成 SQL 去原始表里查询。
4. 根据结果友好回复用户。如果查无数据，请说："小妮查了一下，数据库里好像没有找到相关记录哦，要不检查一下款号对不对？"

回复风格要求（非常重要）：
- 不要讲数据库、表、字段、SQL 这些技术术语，用户完全听不懂。
- 用大白话解释数据，就像跟同事聊天一样。
- 如果用户问题不清晰，主动告诉他系统里有哪些数据可以看，比如："目前系统里有销售数据、库存数据，你想看哪一块？"
- 数据结果用 Markdown 表格呈现，表格上面加一句简单说明。
- 如果某个表关联了数据看板，主动告诉用户："这个问题在看板《XXX》里也能看到可视化图表哦~"
- 保持语气亲切、活泼，适当加 emoji。

看板优先规则（绝对优先）：
- 如果用户问题提到了具体的款号、编码、SKU、店铺名等，并且我在上下文中已经提供了该看板的明细数据（table_data 预览），请直接引用这些现成数据回答。
- 看板明细数据是已经计算/汇总好的结果，比去原始表里重新查询更准确、更完整。
- 严禁在看板预览明明有数据的情况下，还说"数据库里没有记录"。
- 只有当看板预览中确实找不到相关记录时，才去原始表查询。

举例：
- 不要这样说："表 sales 包含 quantity 字段，使用 SELECT SUM..."
- 要这样说："目前这款商品总共卖了 1,250 件，其中黑色最畅销 👍"
"#;

#[derive(Deserialize, Debug)]
struct StreamMessage {
    #[serde(rename = "specVersion")]
    spec_version: String,
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(rename = "headers")]
    header: StreamHeader,
    data: String,
}

#[derive(Deserialize, Debug)]
struct StreamHeader {
    #[serde(rename = "appId")]
    app_id: String,
    #[serde(rename = "messageId")]
    message_id: String,
}

#[derive(Deserialize, Debug)]
struct StreamData {
    #[serde(rename = "senderStaffId")]
    sender_staff_id: String,
    #[serde(rename = "conversationType")]
    conversation_type: String,
    #[serde(rename = "conversationId")]
    conversation_id: Option<String>,
    #[serde(rename = "openConversationId")]
    open_conversation_id: Option<String>,
    #[serde(rename = "robotCode")]
    robot_code: String,
    #[serde(rename = "msgtype")]
    msg_type: String,
    text: Option<serde_json::Value>,
    #[serde(rename = "content")]
    raw_content: Option<String>,
    #[serde(rename = "sessionWebhook")]
    session_webhook: Option<String>,
}

#[derive(Serialize)]
struct ToolCallRequest {
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Vec<serde_json::Value>,
    temperature: f32,
}

pub async fn start_bot(app: tauri::AppHandle) -> Result<(), String> {
    if BOT_RUNNING.load(Ordering::Relaxed) {
        return Ok(());
    }
    BOT_RUNNING.store(true, Ordering::Relaxed);

    // 第一次连接直接运行并返回错误，让用户立即知道结果
    let first_result = run_bot_loop(&app).await;
    if let Err(ref e) = first_result {
        BOT_RUNNING.store(false, Ordering::Relaxed);
        let mut st = STATUS.lock().await;
        st.connected = false;
        let _ = app.emit("bot-status-change", serde_json::json!({"status": "disconnected"}));
        return Err(e.clone());
    }

    // 成功后进入后台重连循环
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
        loop {
            if !BOT_RUNNING.load(Ordering::Relaxed) {
                break;
            }
            let _ = run_bot_loop(&app).await;
            interval.tick().await;
        }
    });
    Ok(())
}

pub fn stop_bot() {
    BOT_RUNNING.store(false, Ordering::Relaxed);
    STATUS.blocking_lock().connected = false;
}

async fn run_bot_loop(app: &tauri::AppHandle) -> Result<(), String> {
    let config = load_config(app.clone()).await?;
    if config.ding_app_key.is_empty() || config.ding_app_secret.is_empty() {
        return Err("钉钉配置不完整".to_string());
    }

    // 1. 获取 Stream 连接信息（直接传 clientId + clientSecret，不需要 access_token）
    let conn = open_connection(&config).await?;
    let ws_url = format!("{}?ticket={}", conn.endpoint, conn.ticket);
    println!("[DEBUG] WebSocket URL: {}", conn.endpoint);

    // 2. 连接 WebSocket
    let (ws_stream, _) = connect_async(&ws_url)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {}", e))?;

    {
        let mut st = STATUS.lock().await;
        st.connected = true;
        st.last_ping = chrono::Local::now().format("%H:%M").to_string();
    }
    let _ = app.emit("bot-status-change", serde_json::json!({"status": "connected"}));

    let (mut write, mut read) = ws_stream.split();

    // ACK channel
    let (ack_tx, mut ack_rx) = tokio::sync::mpsc::channel::<String>(100);

    // 心跳 + ACK（参考 Python SDK 格式）
    let heartbeat = tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let ping = tokio_tungstenite::tungstenite::Message::Ping(vec![]);
                    if write.send(ping).await.is_err() {
                        break;
                    }
                }
                Some(msg_id) = ack_rx.recv() => {
                    let ack = json!({
                        "code": 200,
                        "headers": {
                            "messageId": msg_id
                        },
                        "message": "OK",
                        "data": "{}"
                    }).to_string();
                    println!("[DEBUG] 发送 ACK: {}", ack);
                    if write.send(tokio_tungstenite::tungstenite::Message::Text(ack)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // 读取消息
    while let Some(msg) = read.next().await {
        match msg {
            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                println!("[DEBUG] 收到原始消息: {}", text);
                if let Ok(stream_msg) = serde_json::from_str::<StreamMessage>(&text) {
                    println!("[DEBUG] 消息类型: {}, messageId: {}", stream_msg.msg_type, stream_msg.header.message_id);
                    if stream_msg.msg_type == "CALLBACK" {
                        let _ = ack_tx.send(stream_msg.header.message_id.clone()).await;
                        // data 字段是 JSON 字符串，需要二次解析
                        let data: StreamData = match serde_json::from_str(&stream_msg.data) {
                            Ok(d) => d,
                            Err(e) => {
                                println!("[DEBUG] data 字段解析失败: {}, raw data: {}", e, stream_msg.data);
                                continue;
                            }
                        };
                        println!("[DEBUG] 消息详情 - senderStaffId: {}, msgtype: {}, conversationType: {}, robotCode: {}, sessionWebhook: {:?}",
                            data.sender_staff_id, data.msg_type, data.conversation_type, data.robot_code, data.session_webhook);
                        if data.msg_type == "text" {
                            let content = data
                                .text
                                .and_then(|t| t.get("content").and_then(|c| c.as_str().map(|s| s.to_string())))
                                .or(data.raw_content)
                                .unwrap_or_default();

                            let open_conv_id = data
                                .open_conversation_id
                                .or(data.conversation_id)
                                .unwrap_or_default();

                            let webhook = data.session_webhook.as_deref().unwrap_or("");
                            println!("[DEBUG] 解析结果 - 用户消息: \"{}\", 发送人: {}, 群聊ID: {}, webhook: {}",
                                content, data.sender_staff_id, open_conv_id, webhook);
                            if !content.is_empty() {
                                let _ = handle_message(
                                    app,
                                    &config,
                                    webhook,
                                    &data.sender_staff_id,
                                    &content,
                                ).await;
                            } else {
                                println!("[DEBUG] 消息内容为空，跳过处理");
                            }
                        } else {
                            println!("[DEBUG] 非文本消息，跳过处理");
                        }
                    } else {
                        println!("[DEBUG] 非 CALLBACK 消息，跳过处理");
                    }
                } else {
                    println!("[DEBUG] 消息解析失败");
                }
            }
            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                break;
            }
            Err(_) => break,
            _ => {}
        }
    }

    heartbeat.abort();
    {
        let mut st = STATUS.lock().await;
        st.connected = false;
        st.last_ping = chrono::Local::now().format("%H:%M").to_string();
    }
    let _ = app.emit("bot-status-change", serde_json::json!({"status": "disconnected"}));
    Ok(())
}

async fn get_dingtalk_token(config: &AppConfig) -> Result<String, String> {
    let client = reqwest::Client::new();
    // CorpSecret 和 AppSecret 是不同的凭证，这里始终使用 AppKey + AppSecret
    let url = format!(
        "https://oapi.dingtalk.com/gettoken?appkey={}&appsecret={}",
        config.ding_app_key, config.ding_app_secret
    );
    println!("[DEBUG] gettoken URL: {}", url.split("secret=").next().unwrap_or(""));
    let resp = client.get(&url).send().await.map_err(|e| format!("请求钉钉 token 失败: {}", e))?;
    let text = resp.text().await.unwrap_or_default();
    println!("[DEBUG] gettoken 响应: {}", text);
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    if let Some(errcode) = json.get("errcode").and_then(|v| v.as_i64()) {
        if errcode != 0 {
            let errmsg = json.get("errmsg").and_then(|v| v.as_str()).unwrap_or("未知错误");
            return Err(format!("获取钉钉 token 失败 [{}]: {}", errcode, errmsg));
        }
    }
    json.get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("获取钉钉 token 失败: 响应中无 access_token。原始响应: {}", text))
}

#[derive(Debug)]
pub struct StreamConnection {
    pub endpoint: String,
    pub ticket: String,
}

pub async fn open_connection(config: &AppConfig) -> Result<StreamConnection, String> {
    let client = reqwest::Client::new();
    let url = "https://api.dingtalk.com/v1.0/gateway/connections/open";

    let local_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let body = json!({
        "clientId": config.ding_app_key,
        "clientSecret": config.ding_app_secret,
        "subscriptions": [
            {"type": "CALLBACK", "topic": "/v1.0/im/bot/messages/get"}
        ],
        "ua": "dingtalk-sdk-rust/1.0",
        "localIp": local_ip
    });

    println!("[DEBUG] open_connection URL: {}", url);
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Stream 连接请求失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    println!("[DEBUG] open_connection 响应: status={}, body={}", status, text);

    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();

    if let Some(code) = json.get("code").and_then(|v| v.as_str()) {
        if !code.is_empty() && code != "0" {
            let msg = json.get("message").and_then(|v| v.as_str()).unwrap_or("");
            return Err(format!(
                "获取 Stream endpoint 失败 [{}]: {}。请检查应用是否已添加以下权限：1) 机器人信息权限 2) 机器人Stream模式 3) 企业内部机器人发送消息权限",
                code, msg
            ));
        }
    }
    if let Some(errcode) = json.get("errcode").and_then(|v| v.as_i64()) {
        if errcode != 0 {
            let errmsg = json.get("errmsg").and_then(|v| v.as_str()).unwrap_or("");
            return Err(format!(
                "获取 Stream endpoint 失败 [{}]: {}", errcode, errmsg
            ));
        }
    }

    if !status.is_success() {
        return Err(format!("获取 Stream endpoint 失败: HTTP {}", status));
    }

    let endpoint = json
        .get("endpoint")
        .and_then(|v| v.as_str())
        .ok_or("获取 Stream endpoint 失败: 响应中无 endpoint")?
        .to_string();
    let ticket = json
        .get("ticket")
        .and_then(|v| v.as_str())
        .ok_or("获取 Stream endpoint 失败: 响应中无 ticket")?
        .to_string();

    Ok(StreamConnection { endpoint, ticket })
}

fn has_user_tables(conn: &rusqlite::Connection) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let name: String = row.get(0)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let name = row.map_err(|e| e.to_string())?;
        if name != "kb_docs" && name != "chat_sessions" && !name.starts_with("sqlite_") && !name.starts_with("temp_") {
            return Ok(true);
        }
    }
    Ok(false)
}

const SYSTEM_TABLES: &[&str] = &[
    "chat_sessions",
    "dashboards",
    "column_remarks",
    "table_column_remarks",
    "table_mappings",
    "table_upload_mappings",
    "bot_chat_memory",
    "kb_chunks",
    "kb_docs",
    "app_config",
    "table_remarks",
    "dashboard_revisions",
];

fn list_business_tables(conn: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = match conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = stmt.query_map([], |row| row.get::<_, String>(0));
    let mut out = vec![];
    if let Ok(iter) = rows {
        for r in iter.flatten() {
            if !SYSTEM_TABLES.contains(&r.as_str()) && !r.starts_with("temp_") {
                out.push(r);
            }
        }
    }
    out
}

/// 用主 AI 模型从用户消息中抽取候选关键词（货号/SKU/编号/品类等具体取值）
/// 返回去重后的关键词列表；失败时返回空 Vec（不阻塞主流程）
async fn extract_search_keywords(
    client: &reqwest::Client,
    config: &AppConfig,
    content: &str,
) -> Vec<String> {
    let url = format!("{}/chat/completions", config.ai_url.trim_end_matches('/'));
    let prompt = format!(
        r#"从下面这段用户提问中，抽取出最可能用于在数据库里精确/模糊匹配的"具体取值"，比如货号、SKU、订单号、款式编码、店铺名、人名等。
注意：
- 只输出取值本身，不要输出字段名/类目词（如不要输出"销量"、"占比"、"店铺"这种词）。
- 如果用户只说了数字（如"3458"），但常见货号格式带字母前缀（如 LDN3458），把字母前缀的全称也一并补出来。
- 用 JSON 数组输出，最多 6 个，按相关性从高到低。如果没有任何具体取值，输出 []。

用户提问: {}

只输出 JSON 数组，不要任何额外说明。"#,
        content
    );

    let body = json!({
        "model": config.ai_model,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.0,
    });

    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.ai_key))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let parsed: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let raw = parsed["choices"][0]["message"]["content"].as_str().unwrap_or("").trim();
    // 容错：去掉可能的 markdown 围栏
    let cleaned = raw.trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let arr: Vec<String> = serde_json::from_str(cleaned).unwrap_or_default();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = vec![];
    for kw in arr {
        let k = kw.trim().to_string();
        if k.is_empty() || k.len() > 64 { continue; }
        if seen.insert(k.clone()) {
            out.push(k);
        }
    }
    out
}

/// 把一个看板的 table_data（JSON 字符串）渲染成"前 N 行"的简洁 Markdown 表
/// 只取前 20 行，避免上下文爆炸（与"附件上传规则"对齐）
fn format_dashboard_table_preview(table_data_json: &str, max_rows: usize) -> String {
    if table_data_json.trim().is_empty() {
        return String::new();
    }
    let parsed: Vec<serde_json::Map<String, serde_json::Value>> =
        match serde_json::from_str(table_data_json) {
            Ok(v) => v,
            Err(_) => return String::new(),
        };
    if parsed.is_empty() {
        return String::new();
    }
    let cols: Vec<String> = parsed[0].keys().cloned().collect();
    let total = parsed.len();
    let mut lines = vec![cols.join(" | ")];
    for row in parsed.iter().take(max_rows) {
        let vals: Vec<String> = cols
            .iter()
            .map(|c| match row.get(c) {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Number(n)) => n.to_string(),
                Some(serde_json::Value::Bool(b)) => b.to_string(),
                Some(serde_json::Value::Null) | None => String::new(),
                Some(other) => other.to_string(),
            })
            .collect();
        lines.push(vals.join(" | "));
    }
    if total > max_rows {
        lines.push(format!("... 还有 {} 行未展示", total - max_rows));
    }
    lines.join("\n")
}

/// 反向模糊查询：对每个关键词在每张业务表的 TEXT 列上做 LIKE 探查
/// 返回 (table_name, keyword, sample_row_text) 三元组，最多 limit 条
fn reverse_fuzzy_search(
    conn: &rusqlite::Connection,
    keywords: &[String],
    limit: usize,
) -> Vec<(String, String, String)> {
    if keywords.is_empty() {
        return vec![];
    }
    let tables = list_business_tables(conn);
    let mut results: Vec<(String, String, String)> = vec![];

    for table in &tables {
        // 取该表所有列名（用 scope 块释放 stmt 借用）
        let text_cols: Vec<String> = {
            let pragma = format!("PRAGMA table_info(\"{}\")", table);
            let mut stmt = match conn.prepare(&pragma) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let col_rows = stmt.query_map([], |row| {
                let name: String = row.get(1)?;
                let typ: String = row.get(2).unwrap_or_default();
                Ok((name, typ))
            });
            let mut cols: Vec<String> = vec![];
            if let Ok(iter) = col_rows {
                for r in iter.flatten() {
                    let typ_upper = r.1.to_uppercase();
                    // 文本类列（SQLite 类型亲和度宽松，TEXT/VARCHAR/CHAR/CLOB 都按文本处理）
                    if typ_upper.contains("TEXT") || typ_upper.contains("CHAR") || typ_upper.contains("CLOB") || typ_upper.is_empty() {
                        cols.push(r.0);
                    }
                }
            }
            cols
        };
        if text_cols.is_empty() {
            continue;
        }

        for kw in keywords {
            // 防 SQL 注入：关键词里只允许常见字符；其余跳过
            if kw.chars().any(|c| c == '"' || c == '\'' || c == ';' || c == '\\') {
                continue;
            }
            let where_parts: Vec<String> = text_cols
                .iter()
                .map(|c| format!("\"{}\" LIKE '%{}%'", c, kw))
                .collect();
            let sql = format!(
                "SELECT * FROM \"{}\" WHERE {} LIMIT 1",
                table,
                where_parts.join(" OR ")
            );
            let row_text: Option<String> = {
                let mut stmt2 = match conn.prepare(&sql) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let col_count = stmt2.column_count();
                let col_names: Vec<String> = (0..col_count)
                    .map(|i| stmt2.column_name(i).unwrap_or("?").to_string())
                    .collect();
                let mut rows = match stmt2.query([]) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                match rows.next() {
                    Ok(Some(row)) => {
                        let mut pairs: Vec<String> = vec![];
                        for i in 0..col_count {
                            let val = match row.get_ref(i) {
                                Ok(rusqlite::types::ValueRef::Null) => String::new(),
                                Ok(rusqlite::types::ValueRef::Integer(n)) => n.to_string(),
                                Ok(rusqlite::types::ValueRef::Real(f)) => f.to_string(),
                                Ok(rusqlite::types::ValueRef::Text(s)) => String::from_utf8_lossy(s).to_string(),
                                _ => String::new(),
                            };
                            pairs.push(format!("{}={}", col_names[i], val));
                        }
                        Some(pairs.join(", "))
                    }
                    _ => None,
                }
            };
            if let Some(sample) = row_text {
                results.push((table.clone(), kw.clone(), sample));
                if results.len() >= limit {
                    return results;
                }
            }
        }
    }
    results
}

const MEMORY_EXPIRE_HOURS: i64 = 24;
const ROUND_REMINDER_THRESHOLD: i32 = 3;

fn is_fresh_memory(last_time: &str) -> bool {
    if let Ok(last) = chrono::NaiveDateTime::parse_from_str(last_time, "%Y-%m-%d %H:%M:%S") {
        let now = chrono::Local::now().naive_local();
        let duration = now.signed_duration_since(last);
        duration.num_hours() < MEMORY_EXPIRE_HOURS
    } else {
        false
    }
}

fn is_new_conversation_command(content: &str) -> bool {
    let lowered = content.to_lowercase();
    lowered.contains("开始新对话")
        || lowered.contains("重新开始")
        || lowered.contains("新对话")
        || lowered.contains("清空")
        || lowered.contains("重置")
}

async fn handle_message(
    app: &tauri::AppHandle,
    config: &AppConfig,
    webhook_url: &str,
    user_id: &str,
    content: &str,
) -> Result<(), String> {
    // 1. 加载记忆
    let conn = init_db()?;

    // 立即回复"已收到",避免用户在 AI/SQL 处理(10s+)期间没有反馈
    // 跳过新对话/重置命令(它们有自己的确认文案),其他分支并发发出 ack
    if !is_new_conversation_command(content) {
        let webhook_clone = webhook_url.to_string();
        let user_clone = user_id.to_string();
        tokio::spawn(async move {
            let ack = "已收到消息，正在查询处理中，请稍等~";
            let _ = reply_via_webhook(&webhook_clone, &user_clone, ack, "text", &[]).await;
            println!("[Bot Ack to {}]: {}", user_clone, ack);
        });
    }

    // 如果数据库还没有任何用户表，直接回复引导语
    if !has_user_tables(&conn)? {
        let welcome = "你好！我是小妮 👋 目前系统里还没有数据表哦~\n\n你可以在电脑端上传 Excel 或 CSV 文件，我会帮你整理成漂亮的报表和看板。上传完后记得@我查数据！";
        let _ = reply_via_webhook(webhook_url, user_id, welcome, "text", &[]).await;
        println!("[Bot Reply to {}]: {}", user_id, welcome);
        return Ok(());
    }

    let (memory_json, last_time, round_count): (String, String, i32) = conn
        .query_row(
            "SELECT messages, last_time, round_count FROM bot_chat_memory WHERE user_id = ?1",
            [user_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap_or_else(|_| ("".to_string(), "".to_string(), 0));

    let mut messages: Vec<serde_json::Value>;
    let mut round_count = round_count;

    // 检查是否需要重置记忆
    if is_new_conversation_command(content) {
        messages = vec![json!({"role": "system", "content": BOT_SYSTEM_PROMPT})];
        let ack = "好的，咱们重新开始！之前的话题我已经忘光光啦，有什么新需求尽管说 😊";
        let _ = reply_via_webhook(webhook_url, user_id, ack, "text", &[]).await;
        println!("[Bot Reply to {}]: {}", user_id, ack);
        // 保存重置后的状态
        let memory_str = serde_json::to_string(&messages).unwrap_or_default();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO bot_chat_memory (user_id, messages, last_time, round_count) VALUES (?1, ?2, datetime('now'), 0)",
            [user_id, &memory_str],
        );
        return Ok(());
    }

    if !memory_json.is_empty() && is_fresh_memory(&last_time) {
        messages = serde_json::from_str(&memory_json).unwrap_or_else(|_| {
            vec![json!({"role": "system", "content": BOT_SYSTEM_PROMPT})]
        });
        println!("[Bot Memory] 用户 {} 记忆已加载，共 {} 条消息", user_id, messages.len());
    } else {
        messages = vec![json!({"role": "system", "content": BOT_SYSTEM_PROMPT})];
        round_count = 0;
        if !memory_json.is_empty() {
            println!("[Bot Memory] 用户 {} 记忆已过期，重置对话", user_id);
        } else {
            println!("[Bot Memory] 用户 {} 无历史记忆，新建对话", user_id);
        }
    }

    messages.push(json!({"role": "user", "content": content}));

    // 2. RAG: 检索相关表，并附带小白友好的看板信息
    let kb = crate::search_kb(app.clone(), content.to_string(), 3).await.unwrap_or_default();

    // 查询所有看板（含描述、数据表、计算后的明细 table_data），用于小白友好提示和智能路由
    #[derive(Debug, Clone)]
    struct DashInfo {
        id: String,
        name: String,
        description: String,
        source_table: String,
        table_data: String,
    }
    let dashboards: Vec<DashInfo> = {
        let mut stmt = conn
            .prepare("SELECT id, name, description, source_table, table_data FROM dashboards ORDER BY updated_at DESC LIMIT 10")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(DashInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2).unwrap_or_default(),
                    source_table: row.get(3).unwrap_or_default(),
                    table_data: row.get(4).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 看板明细预览：优先用看板自身已计算好的 table_data（前 20 行），AI 直接看到现成结果，
    // 不需要再去原始表里硬算交叉表
    let mut dashboard_previews: Vec<String> = vec![];
    for d in &dashboards {
        let mut preview = format_dashboard_table_preview(&d.table_data, 20);
        if preview.is_empty() && !d.source_table.is_empty() {
            // 没有 table_data，退回原来的逻辑：取源表第 1 行
            let preview_sql = format!(r#"SELECT * FROM "{}" LIMIT 1"#, d.source_table);
            let raw = run_local_sql(&preview_sql).await;
            if !raw.is_empty() && !raw.starts_with("SQL") && !raw.starts_with("查询失败") {
                preview = raw;
            }
        }
        if !preview.is_empty() {
            dashboard_previews.push(format!(
                "【看板《{}》明细数据预览（前 20 行）】\n{}",
                d.name, preview
            ));
        }
    }

    // 反向模糊查询：让 AI 抽取候选关键词，去原始表里 LIKE 探查，命中的表反查关联看板
    let kw_client = reqwest::Client::new();
    let keywords = extract_search_keywords(&kw_client, config, content).await;

    // 在看板 table_data 中直接搜索匹配关键词的行（现成计算数据优先）
    let mut direct_hit_section = String::new();
    if !keywords.is_empty() {
        let mut direct_hits: Vec<(String, Vec<serde_json::Map<String, serde_json::Value>>)> = vec![];
        for d in &dashboards {
            if d.table_data.trim().is_empty() {
                continue;
            }
            let rows: Vec<serde_json::Map<String, serde_json::Value>> =
                match serde_json::from_str(&d.table_data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
            let mut matched_rows = vec![];
            for row in &rows {
                let row_text = row.values().map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => v.to_string(),
                }).collect::<Vec<String>>().join(" ");
                let row_lower = row_text.to_lowercase();
                for kw in &keywords {
                    if row_lower.contains(&kw.to_lowercase()) {
                        matched_rows.push(row.clone());
                        break;
                    }
                }
            }
            if !matched_rows.is_empty() {
                direct_hits.push((d.name.clone(), matched_rows));
            }
        }
        if !direct_hits.is_empty() {
            let mut buf = String::from("🎯【看板直接命中】用户提到的关键词在看板明细数据中已有完整记录，请直接根据以下数据回答，禁止再去原始表里查询！\n\n");
            for (board_name, rows) in &direct_hits {
                buf.push_str(&format!("看板《{}》匹配数据：\n", board_name));
                if let Some(first_row) = rows.first() {
                    let cols: Vec<String> = first_row.keys().cloned().collect();
                    let mut lines = vec![cols.join(" | ")];
                    for row in rows.iter().take(20) {
                        let vals: Vec<String> = cols.iter().map(|c| match row.get(c) {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(serde_json::Value::Number(n)) => n.to_string(),
                            Some(serde_json::Value::Bool(b)) => b.to_string(),
                            Some(serde_json::Value::Null) | None => String::new(),
                            Some(other) => other.to_string(),
                        }).collect();
                        lines.push(vals.join(" | "));
                    }
                    buf.push_str(&lines.join("\n"));
                    buf.push_str("\n\n");
                }
            }
            direct_hit_section = buf;
        }
    }

    let mut fuzzy_section = String::new();
    if !keywords.is_empty() {
        let hits = reverse_fuzzy_search(&conn, &keywords, 12);
        if !hits.is_empty() {
            // 命中的表 → 反查 dashboards 里 source_table 相同的看板
            let mut hit_table_set: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (t, _, _) in &hits {
                hit_table_set.insert(t.clone());
            }
            let related_boards: Vec<&DashInfo> = dashboards
                .iter()
                .filter(|d| hit_table_set.contains(&d.source_table))
                .collect();

            let mut buf = format!(
                "🔎【反向模糊查询命中】基于关键词 [{}]，在以下原始表里找到相关数据：\n",
                keywords.join("、")
            );
            for (t, kw, sample) in &hits {
                buf.push_str(&format!("- 表 \"{}\" 命中关键词「{}」，样本行：{}\n", t, kw, sample));
            }
            if !related_boards.is_empty() {
                buf.push_str("\n这些表关联了以下看板，可以**优先**从对应看板的明细数据里取答案：\n");
                for d in &related_boards {
                    buf.push_str(&format!("- 看板《{}》(数据表={})\n", d.name, d.source_table));
                }
            }
            fuzzy_section = buf;
        }
    }

    let dashboard_names: Vec<String> = dashboards.iter().map(|d| d.name.clone()).collect();
    let dashboard_details = dashboards.iter().map(|d| {
        format!("- 看板《{}》：描述={}，数据表={}", d.name, d.description, d.source_table)
    }).collect::<Vec<_>>().join("\n");

    let kb_hint = {
        let mut parts: Vec<String> = vec![];
        if !direct_hit_section.is_empty() {
            parts.push(direct_hit_section.clone());
        }
        if !kb.is_empty() {
            parts.push(format!("相关数据表信息:\n{}", kb.join("\n")));
        }
        if !fuzzy_section.is_empty() {
            parts.push(fuzzy_section);
        }
        if dashboard_names.is_empty() {
            if parts.is_empty() {
                parts.push("当前知识库暂无相关表信息。".to_string());
            }
        } else {
            parts.push(format!(
                "目前系统里的看板：{}\n\n看板详细信息（请根据用户问题，优先查询相关看板的数据表，并直接使用上面的明细数据预览作答）：\n{}\n\n{}",
                dashboard_names.join("、"),
                dashboard_details,
                dashboard_previews.join("\n\n")
            ));
        }
        parts.join("\n\n")
    };
    messages.push(json!({"role": "system", "content": kb_hint}));

    // 3. 查询迭代阶段（查询模型，最多10轮）
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", config.ai_url.trim_end_matches('/'));
    let query_model_str = resolve_query_model(config);
    let mut query_messages = messages.clone();
    // 如果看板直接命中数据已存在，给查询模型加一条强指令，避免它再去原始表查空结果
    if !direct_hit_section.is_empty() {
        query_messages.push(json!({
            "role": "system",
            "content": "【指令】上面的 🎯【看板直接命中】已经包含了用户问题的完整数据，请直接分析这些数据并总结回复，绝对不要调用 query_sql 去原始表里查询。"
        }));
    }
    let mut query_history: Vec<String> = vec![];
    let mut query_rounds = 10;

    while query_rounds > 0 {
        query_rounds -= 1;
        // 第1轮用主模型做规划和首次查询，后续轮次用查询模型迭代
        let round_model = if query_history.is_empty() {
            config.ai_model.clone()
        } else {
            query_model_str.clone()
        };
        let req_body = ToolCallRequest {
            model: round_model,
            messages: query_messages.clone(),
            tools: vec![json!({
                "type": "function",
                "function": {
                    "name": "query_sql",
                    "description": "执行本地 SQLite 查询",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "sql": {"type": "string", "description": "SQLite SQL 语句"}
                        },
                        "required": ["sql"]
                    }
                }
            })],
            temperature: 0.2,
        };

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.ai_key))
            .json(&req_body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let choice = body["choices"][0].clone();
        let finish_reason = choice["finish_reason"].as_str().unwrap_or("");

        if finish_reason == "tool_calls" {
            let tool_calls = choice["message"]["tool_calls"].as_array().cloned().unwrap_or_default();
            query_messages.push(choice["message"].clone());

            for call in tool_calls {
                if let Some(func) = call.get("function") {
                    let name = func["name"].as_str().unwrap_or("");
                    let args = func["arguments"].as_str().unwrap_or("{}");
                    if name == "query_sql" {
                        let sql: serde_json::Value = serde_json::from_str(args).unwrap_or_default();
                        let sql_str = sql["sql"].as_str().unwrap_or("");
                        let result = run_local_sql(sql_str).await;
                        query_history.push(format!("SQL: {}\n结果: {}", sql_str, result));
                        query_messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call["id"].as_str().unwrap_or(""),
                            "content": result
                        }));
                    }
                }
            }
        } else {
            let intermediate = choice["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if !intermediate.is_empty() {
                query_history.push(format!("分析: {}", intermediate));
            }
            break;
        }
    }

    // 把查询过程合并到主对话，用于保存记忆
    messages = query_messages;

    // 4. 最终回复阶段（主模型）
    let output_system = format!(
        r#"你是企业数据助手"小妮"。你已经通过数据查询获取了结果，现在需要根据查询结果生成最终回复。

用户原始问题：{}

回复要求（非常重要）：
1. 用大白话解释数据，不要讲数据库、表、字段、SQL
2. 数据结果用 Markdown 表格呈现，表格上面加一句简单说明
3. 主动告诉用户："这个问题在看板里也能看到可视化图表哦~"
4. 可以建议生成哪些图表（如饼图、柱状图、折线图）来更直观展示数据
5. 保持语气亲切、活泼，适当加 emoji
6. 如果查无数据，请说："小妮查了一下，数据库里好像没有找到相关记录哦，要不检查一下款号对不对？"
7. 如果前面的上下文中已经提供了看板直接命中的明细数据（🎯【看板直接命中】），请直接引用这些数据生成回复，不要再说"数据库里没有记录"。"#,
        content
    );

    let output_messages = vec![
        json!({"role": "system", "content": output_system}),
        json!({"role": "user", "content": format!("查询历史:\n\n{}\n\n请生成最终回复。", query_history.join("\n\n"))})
    ];

    let output_req = ToolCallRequest {
        model: config.ai_model.clone(),
        messages: output_messages,
        tools: vec![],
        temperature: 0.5,
    };

    let mut final_reply = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.ai_key))
        .json(&output_req)
        .send()
        .await
    {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(body) => body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("小妮处理中...")
                .to_string(),
            Err(_) => "小妮查了一下，数据库里好像没有找到相关记录哦，要不检查一下款号对不对？".to_string(),
        },
        Err(_) => "小妮查了一下，数据库里好像没有找到相关记录哦，要不检查一下款号对不对？".to_string(),
    };

    // 轮数提醒
    round_count += 1;
    if round_count >= ROUND_REMINDER_THRESHOLD {
        final_reply.push_str("\n\n💡 【小提示】咱们已经聊了挺多轮啦，如果需要换个话题查别的数据，可以直接跟我说「开始新对话」，我会清空之前的上下文重新开始哦~");
    }

    // 4. 生成图表并上传（如果回复包含数据表格）
    let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
    let (processed_reply, image_urls) = match crate::chart_gen::process_tables_into_charts(&final_reply, &temp_dir).await {
        Ok((reply, urls)) => {
            println!("[Bot Chart] 生成 {} 张图表", urls.len());
            (reply, urls)
        }
        Err(e) => {
            eprintln!("[Bot Chart] 图表处理失败: {}", e);
            (final_reply.clone(), vec![])
        }
    };

    // 5. 保存记忆（最近 5 轮）
    messages.push(json!({"role": "assistant", "content": &final_reply}));

    // 过滤掉临时 system message（如 kb_hint），保留核心 system prompt 和对话历史
    let memory_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| {
            if let (Some(role), Some(content)) = (m.get("role").and_then(|v| v.as_str()), m.get("content").and_then(|v| v.as_str())) {
                // 过滤掉 kb_hint（包含特定标记的临时 system message）
                if role == "system" && (content.contains("相关数据表信息") || content.contains("目前系统里有这些看板") || content.contains("目前系统里的看板") || content.contains("看板详细信息") || content.contains("反向模糊查询命中")) {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect();

    // 截断时保留开头的 system prompt，只截断旧的对话轮次
    let system_prompt = memory_messages.first().cloned().filter(|m| {
        m.get("role").and_then(|v| v.as_str()) == Some("system")
    });
    let non_system: Vec<serde_json::Value> = memory_messages.into_iter().skip(1).collect();
    let mut truncated = if non_system.len() > 10 {
        let skip = non_system.len() - 10;
        non_system.into_iter().skip(skip).collect::<Vec<_>>()
    } else {
        non_system
    };
    if let Some(sp) = system_prompt {
        truncated.insert(0, sp);
    }

    let memory_json = serde_json::to_string(&truncated).unwrap_or_default();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO bot_chat_memory (user_id, messages, last_time, round_count) VALUES (?1, ?2, datetime('now'), ?3)",
        rusqlite::params![user_id, &memory_json, round_count],
    );
    println!("[Bot Memory] 用户 {} 记忆已保存，共 {} 条消息（含 system prompt）", user_id, truncated.len());

    // 6. 发送回复（Stream 模式优先使用 sessionWebhook）
    if let Err(e) = reply_via_webhook(webhook_url, user_id, &processed_reply, "markdown", &image_urls).await {
        eprintln!("发送回复失败: {}", e);
        let _ = app.emit("bot-send-error", serde_json::json!({"error": e}));
    }
    // 7. 同步到系统 AI 分析助手会话历史
    let _ = sync_dingtalk_to_session(&conn, user_id, &messages);

    println!("[Bot Reply to {}]: {}", user_id, processed_reply);
    Ok(())
}

fn sync_dingtalk_to_session(
    conn: &rusqlite::Connection,
    user_id: &str,
    messages: &[serde_json::Value],
) -> Result<(), String> {
    let session_id = format!("dingtalk-{}", user_id);
    let title = format!("钉钉对话 {}", user_id);

    let payload_messages: Vec<crate::ChatMessagePayload> = messages
        .iter()
        .filter_map(|m| {
            let role = m.get("role")?.as_str()?;
            let content = m.get("content")?.as_str()?;
            if role == "system" || role == "tool" {
                return None;
            }
            Some(crate::ChatMessagePayload {
                role: role.to_string(),
                content: content.to_string(),
                timestamp: Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
                duration_ms: None,
                attachments: None,
            })
        })
        .collect();

    let messages_json = serde_json::to_string(&payload_messages).unwrap_or_default();

    conn.execute(
        "INSERT OR REPLACE INTO chat_sessions (id, title, messages, thought_guide_mode, token_count, dashboard_id, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, NULL, datetime('now'), datetime('now'))",
        rusqlite::params![session_id, title, messages_json],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

async fn reply_via_webhook(
    webhook_url: &str,
    user_id: &str,
    content: &str,
    msg_type: &str,
    image_urls: &[String],
) -> Result<(), String> {
    if webhook_url.is_empty() {
        return Err("sessionWebhook 为空，无法发送回复".to_string());
    }
    let client = reqwest::Client::new();

    let body = if msg_type == "markdown" {
        let markdown_text = if image_urls.is_empty() {
            content.to_string()
        } else {
            let mut text = content.to_string();
            for url in image_urls {
                text.push_str(&format!("\n\n![图表]({})", url));
            }
            text
        };
        json!({
            "msgtype": "markdown",
            "markdown": {
                "title": "小妮数据助手",
                "text": markdown_text
            },
            "at": {
                "atUserIds": [user_id]
            }
        })
    } else {
        json!({
            "msgtype": "text",
            "text": {
                "content": content
            },
            "at": {
                "atUserIds": [user_id]
            }
        })
    };

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

async fn send_group_message(
    token: &str,
    robot_code: &str,
    open_conversation_id: &str,
    content: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
    let body = json!({
        "robotCode": robot_code,
        "openConversationId": open_conversation_id,
        "msgKey": "sampleText",
        "msgParam": json!({"content": content}).to_string()
    });

    let resp = client
        .post(url)
        .header("x-acs-dingtalk-access-token", token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("发送群消息请求失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    println!("钉钉群消息响应: {} {}", status, text);

    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(code) = json.get("code").and_then(|v| v.as_str()) {
            if !code.is_empty() && code != "0" {
                let msg = json.get("message").and_then(|v| v.as_str()).unwrap_or("");
                return Err(format!(
                    "发送群消息失败 [{}]: {}。请检查应用是否已添加 '企业内部机器人发送消息权限' 和 '机器人信息权限'",
                    code, msg
                ));
            }
        }
    }

    if status.is_success() {
        Ok(())
    } else {
        Err(format!("发送群消息失败: {} {}", status, text))
    }
}

async fn run_local_sql(sql: &str) -> String {
    if sql.is_empty() {
        return "SQL 为空".to_string();
    }
    let conn = match init_db() {
        Ok(c) => c,
        Err(e) => return e,
    };
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => return format!("SQL 错误: {}", e),
    };
    let cols: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|s| s.to_string())
        .collect();
    let rows = stmt.query_map([], |row| {
        let vals: Vec<String> = (0..cols.len())
            .map(|i| row.get::<usize, String>(i).unwrap_or_default())
            .collect();
        Ok(vals)
    });
    match rows {
        Ok(iter) => {
            let mut lines = vec![cols.join(" | ")];
            for r in iter {
                if let Ok(vals) = r {
                    lines.push(vals.join(" | "));
                }
            }
            lines.join("\n")
        }
        Err(e) => format!("查询失败: {}", e),
    }
}

pub async fn get_bot_status() -> serde_json::Value {
    let st = STATUS.lock().await;
    json!({
        "status": if st.connected { "connected" } else { "disconnected" },
        "last_ping": st.last_ping,
    })
}
