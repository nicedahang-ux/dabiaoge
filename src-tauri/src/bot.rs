use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tokio::sync::Mutex;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;

use crate::{init_db, load_config, AppConfig};

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
2. 如果需要，生成合法的 SQLite SQL。
3. 调用 query_sql 获取结果。
4. 根据结果友好回复用户。如果查无数据，请说："小妮查了一下，数据库里好像没有找到相关记录哦，要不检查一下款号对不对？"

回复风格要求（非常重要）：
- 不要讲数据库、表、字段、SQL 这些技术术语，用户完全听不懂。
- 用大白话解释数据，就像跟同事聊天一样。
- 如果用户问题不清晰，主动告诉他系统里有哪些数据可以看，比如："目前系统里有销售数据、库存数据，你想看哪一块？"
- 数据结果用 Markdown 表格呈现，表格上面加一句简单说明。
- 如果某个表关联了数据看板，主动告诉用户："这个问题在看板《XXX》里也能看到可视化图表哦~"
- 保持语气亲切、活泼，适当加 emoji。

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

const MEMORY_EXPIRE_HOURS: i64 = 8;
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
            let _ = reply_via_webhook(&webhook_clone, &user_clone, ack).await;
            println!("[Bot Ack to {}]: {}", user_clone, ack);
        });
    }

    // 如果数据库还没有任何用户表，直接回复引导语
    if !has_user_tables(&conn)? {
        let welcome = "你好！我是小妮 👋 目前系统里还没有数据表哦~\n\n你可以在电脑端上传 Excel 或 CSV 文件，我会帮你整理成漂亮的报表和看板。上传完后记得@我查数据！";
        let _ = reply_via_webhook(webhook_url, user_id, welcome).await;
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
        round_count = 0;
        let ack = "好的，咱们重新开始！之前的话题我已经忘光光啦，有什么新需求尽管说 😊";
        let _ = reply_via_webhook(webhook_url, user_id, ack).await;
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
    } else {
        messages = vec![json!({"role": "system", "content": BOT_SYSTEM_PROMPT})];
        round_count = 0;
    }

    messages.push(json!({"role": "user", "content": content}));

    // 2. RAG: 检索相关表，并附带小白友好的看板信息
    let kb = crate::search_kb(app.clone(), content.to_string(), 3).await.unwrap_or_default();

    // 查询所有看板，用于小白友好提示
    let dashboard_list: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM dashboards ORDER BY updated_at DESC LIMIT 10")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let name: String = row.get(0)?;
                Ok(name)
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let kb_hint = if kb.is_empty() {
        if dashboard_list.is_empty() {
            "当前知识库暂无相关表信息。".to_string()
        } else {
            format!("目前系统里有这些看板可以查看：{}。你可以直接问我看某个看板的数据，或者上传新数据哦~", dashboard_list.join("、"))
        }
    } else {
        format!("相关数据表信息:\n{}\n\n目前系统里的看板：{}", kb.join("\n"), dashboard_list.join("、"))
    };
    messages.push(json!({"role": "system", "content": kb_hint}));

    // 3. Tool Call 循环
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", config.ai_url.trim_end_matches('/'));
    let mut max_rounds = 3;
    let mut final_reply = String::new();

    while max_rounds > 0 {
        max_rounds -= 1;
        let req_body = ToolCallRequest {
            model: config.ai_model.clone(),
            messages: messages.clone(),
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
            messages.push(choice["message"].clone());

            for call in tool_calls {
                if let Some(func) = call.get("function") {
                    let name = func["name"].as_str().unwrap_or("");
                    let args = func["arguments"].as_str().unwrap_or("{}");
                    if name == "query_sql" {
                        let sql: serde_json::Value = serde_json::from_str(args).unwrap_or_default();
                        let sql_str = sql["sql"].as_str().unwrap_or("");
                        let result = run_local_sql(sql_str).await;
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call["id"].as_str().unwrap_or(""),
                            "content": result
                        }));
                    }
                }
            }
        } else {
            final_reply = choice["message"]["content"]
                .as_str()
                .unwrap_or("小妮处理中...")
                .to_string();
            break;
        }
    }

    if final_reply.is_empty() {
        final_reply = "小妮查了一下，数据库里好像没有找到相关记录哦，要不检查一下款号对不对？".to_string();
    }

    // 轮数提醒
    round_count += 1;
    if round_count >= ROUND_REMINDER_THRESHOLD {
        final_reply.push_str("\n\n💡 【小提示】咱们已经聊了挺多轮啦，如果需要换个话题查别的数据，可以直接跟我说「开始新对话」，我会清空之前的上下文重新开始哦~");
    }

    // 4. 保存记忆（最近 5 轮）
    messages.push(json!({"role": "assistant", "content": &final_reply}));
    if messages.len() > 12 {
        let skip = messages.len() - 12;
        messages = messages.into_iter().skip(skip).collect();
    }
    let memory_json = serde_json::to_string(&messages).unwrap_or_default();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO bot_chat_memory (user_id, messages, last_time, round_count) VALUES (?1, ?2, datetime('now'), ?3)",
        rusqlite::params![user_id, &memory_json, round_count],
    );

    // 5. 发送回复（Stream 模式优先使用 sessionWebhook）
    if let Err(e) = reply_via_webhook(webhook_url, user_id, &final_reply).await {
        eprintln!("发送回复失败: {}", e);
        let _ = app.emit("bot-send-error", serde_json::json!({"error": e}));
    }
    // 6. 同步到系统 AI 分析助手会话历史
    let _ = sync_dingtalk_to_session(&conn, user_id, &messages);

    println!("[Bot Reply to {}]: {}", user_id, final_reply);
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

async fn reply_via_webhook(webhook_url: &str, user_id: &str, content: &str) -> Result<(), String> {
    if webhook_url.is_empty() {
        return Err("sessionWebhook 为空，无法发送回复".to_string());
    }
    let client = reqwest::Client::new();
    let body = json!({
        "msgtype": "text",
        "text": {
            "content": content
        },
        "at": {
            "atUserIds": [user_id]
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
