use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone, Serialize, Deserialize)]
pub struct ShareServerInstance {
    pub board_id: String,
    pub url: String,
    pub pin: String,
    pub port: u16,
    pub allow_refresh: bool,
}

pub struct GlobalShareState {
    pub instance: Option<ShareServerInstance>,
    pub join_handle: Option<tokio::task::JoinHandle<()>>,
}

use once_cell::sync::Lazy;
static GLOBAL_SHARE: Lazy<RwLock<GlobalShareState>> = Lazy::new(|| {
    RwLock::new(GlobalShareState {
        instance: None,
        join_handle: None,
    })
});

#[derive(Clone)]
pub struct ShareState {
    pub pin: String,
    pub board_id: String,
    pub allow_refresh: bool,
    pub token: Arc<Mutex<Option<String>>>,
    pub chart_data: serde_json::Value,
}

#[derive(Serialize)]
pub struct ShareInfo {
    pub url: String,
    pub pin: String,
}

#[derive(Deserialize)]
struct VerifyPayload {
    pin: String,
}

#[derive(Serialize)]
struct VerifyResp {
    token: String,
}

#[derive(Serialize)]
struct BoardData {
    board_id: String,
    data: serde_json::Value,
    allow_refresh: bool,
}

fn generate_pin() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!(
        "{:04}",
        rng.gen_range(0..10000)
    )
}

fn generate_token() -> String {
    format!("token_{}", uuid::Uuid::new_v4())
}

// ========== 数据库实时查询辅助函数（独立实现，避免与lib.rs循环依赖） ==========

fn db_path() -> Result<std::path::PathBuf, String> {
    let mut path = dirs::data_dir().ok_or("无法获取数据目录")?;
    path.push("ai_dashboard");
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {}", e))?;
    path.push("data.db");
    Ok(path)
}

fn is_safe_select(sql: &str) -> bool {
    let trimmed = sql.trim();
    let lower = trimmed.to_lowercase();
    lower.starts_with("select") || lower.starts_with("with")
}

fn get_column_remarks_local(
    table_name: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let conn = rusqlite::Connection::open(db_path()?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT column_name, remark FROM table_column_remarks WHERE table_name = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([table_name], |row| {
            let col: String = row.get(0)?;
            let remark: String = row.get(1)?;
            Ok((col, remark))
        })
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for r in rows {
        let (c, rk) = r.map_err(|e| e.to_string())?;
        map.insert(c, rk);
    }
    Ok(map)
}

fn inject_html_with_data(
    html_content: &str,
    source_table: &str,
) -> Result<String, String> {
    let sql = format!(r#"SELECT * FROM "{}""#, source_table);
    if !is_safe_select(&sql) {
        return Ok(html_content.to_string());
    }
    let conn = rusqlite::Connection::open(db_path()?).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    let mut columns: Vec<String> = vec![];
    for i in 0..col_count {
        columns.push(stmt.column_name(i).unwrap_or("?").to_string());
    }
    let remarks = get_column_remarks_local(source_table).unwrap_or_default();

    let mut data: Vec<serde_json::Map<String, serde_json::Value>> = vec![];
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut obj = serde_json::Map::new();
        for (i, col) in columns.iter().enumerate() {
            let val_ref = row.get_ref(i).map_err(|e| e.to_string())?;
            let val: String = match val_ref {
                rusqlite::types::ValueRef::Null => String::new(),
                rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                rusqlite::types::ValueRef::Real(f) => f.to_string(),
                rusqlite::types::ValueRef::Text(s) => String::from_utf8_lossy(s).to_string(),
                rusqlite::types::ValueRef::Blob(_) => "<BLOB>".to_string(),
            };
            obj.insert(col.clone(), serde_json::Value::String(val.clone()));
            if let Some(cn) = remarks.get(col) {
                if cn != col && !cn.is_empty() {
                    obj.insert(cn.clone(), serde_json::Value::String(val));
                }
            }
        }
        data.push(obj);
    }
    drop(rows);
    drop(stmt);
    drop(conn);

    let mut html = html_content.to_string();
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

fn get_dashboard_data_realtime(
    dashboard_config: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let sql_template = dashboard_config.get("sql_template").and_then(|v| v.as_str());
    let html_content = dashboard_config.get("html_content").and_then(|v| v.as_str());
    let source_table = dashboard_config.get("source_table").and_then(|v| v.as_str());

    let mut updated_config = dashboard_config.clone();

    // 如果有 html_content + source_table，注入实时数据（与桌面端 render_html_dashboard 行为一致）
    if let (Some(html), Some(src)) = (html_content, source_table) {
        if !html.is_empty() && !src.is_empty() {
            match inject_html_with_data(html, src) {
                Ok(rendered) => {
                    updated_config["html_content"] = serde_json::Value::String(rendered);
                }
                Err(e) => {
                    eprintln!("[Share] HTML 数据注入失败: {}", e);
                }
            }
        }
    }

    // 如果有 sql_template，实时执行查询并更新 table_data
    if let Some(sql_template) = sql_template {
        let sql = sql_template.to_string();

        if !is_safe_select(&sql) {
            return Err("仅支持 SELECT 查询".to_string());
        }

        let conn = rusqlite::Connection::open(db_path()?).map_err(|e| e.to_string())?;
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
        drop(rows);
        drop(stmt);
        drop(conn);

        // 转换为对象数组格式（兼容前端）
        let mut records: Vec<serde_json::Map<String, serde_json::Value>> = vec![];
        for row in &data {
            let mut obj = serde_json::Map::new();
            for (i, col) in columns.iter().enumerate() {
                let val = row.get(i).cloned().unwrap_or_default();
                let num = val.parse::<f64>();
                if let Ok(n) = num {
                    obj.insert(col.clone(), serde_json::Value::Number(serde_json::Number::from_f64(n).unwrap_or(serde_json::Number::from(0))));
                } else {
                    obj.insert(col.clone(), serde_json::Value::String(val));
                }
            }
            records.push(obj);
        }

        // 复制原始配置，更新 table_data
        updated_config["table_data"] = json!(serde_json::to_string(&records).unwrap_or_default());
        return Ok(updated_config);
    }

    // 没有 sql_template，返回（可能已注入 html_content 数据的）配置
    Ok(updated_config)
}

// ========== HTTP Handlers ==========

async fn verify_pin(
    State(state): State<Arc<ShareState>>,
    Json(payload): Json<VerifyPayload>,
) -> impl IntoResponse {
    if payload.pin == state.pin {
        let token = generate_token();
        *state.token.lock().await = Some(token.clone());
        Json(json!({ "token": token }))
    } else {
        Json(json!({ "error": "提取码不正确" }))
    }
}

async fn board_data(State(state): State<Arc<ShareState>>, req: Request) -> impl IntoResponse {
    let auth = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let expected = state.token.lock().await.clone().unwrap_or_default();
    let valid = auth == format!("Bearer {}", expected) || auth == format!("Token {}", expected);
    if !valid {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "未授权"})));
    }

    // 实时查询数据库获取最新数据
    let chart_data = state.chart_data.clone();
    let result = tokio::task::spawn_blocking(move || {
        get_dashboard_data_realtime(&chart_data)
    }).await;

    match result {
        Ok(Ok(data)) => (
            StatusCode::OK,
            Json(json!({
                "board_id": state.board_id,
                "data": data,
                "allow_refresh": state.allow_refresh,
            })),
        ),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("查询失败: {}", e)})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("任务执行失败: {}", e)})),
        ),
    }
}

async fn spa_handler(req: Request) -> Response {
    let dist_path = std::path::PathBuf::from("../dist");
    let path = req.uri().path().trim_start_matches('/');
    let file_path = dist_path.join(if path.is_empty() { "index.html" } else { path });

    if let Ok(contents) = tokio::fs::read(&file_path).await {
        let mime = mime_guess::from_path(&file_path).first_or_text_plain();
        Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(contents))
            .unwrap()
    } else {
        // fallback to index.html for SPA routes
        let index_path = dist_path.join("index.html");
        if let Ok(contents) = tokio::fs::read(index_path).await {
            Response::builder()
                .status(200)
                .header(header::CONTENT_TYPE, "text/html")
                .body(Body::from(contents))
                .unwrap()
        } else {
            Response::builder()
                .status(503)
                .body(Body::from("前端构建文件不存在，请先运行 npm run build"))
                .unwrap()
        }
    }
}

pub async fn start_share_server(
    board_id: String,
    allow_refresh: bool,
    dashboard_data: serde_json::Value,
    existing_pin: Option<String>,
) -> Result<ShareInfo, String> {
    // 检查是否已有分享在运行
    let mut global = GLOBAL_SHARE.write().await;
    if let Some(existing) = &global.instance {
        // 如果同一board_id，返回现有信息；否则先停止
        if existing.board_id == board_id {
            return Ok(ShareInfo {
                url: existing.url.clone(),
                pin: existing.pin.clone(),
            });
        }
        // 停止现有服务器
        if let Some(handle) = global.join_handle.take() {
            handle.abort();
        }
    }

    let pin = existing_pin
        .filter(|p| p.len() == 4 && p.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or_else(generate_pin);
    let state = Arc::new(ShareState {
        pin: pin.clone(),
        board_id: board_id.clone(),
        allow_refresh,
        token: Arc::new(Mutex::new(None)),
        chart_data: dashboard_data,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/verify_pin", post(verify_pin))
        .route("/api/board_data", get(board_data))
        .fallback(spa_handler)
        .layer(cors)
        .with_state(state);

    let mut port = 8080u16;
    let listener = loop {
        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => break l,
            Err(_) if port < 8090 => {
                port += 1;
                continue;
            }
            Err(e) => return Err(format!("无法绑定端口: {}", e)),
        }
    };

    let local_ip = local_ip_address::local_ip()
        .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)));
    let url = format!("http://{}:{}/#/share/{}", local_ip, port, board_id);

    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let instance = ShareServerInstance {
        board_id: board_id.clone(),
        url: url.clone(),
        pin: pin.clone(),
        port,
        allow_refresh,
    };

    global.instance = Some(instance);
    global.join_handle = Some(handle);

    Ok(ShareInfo { url, pin })
}

pub async fn stop_share_server() -> Result<(), String> {
    let mut global = GLOBAL_SHARE.write().await;
    if let Some(handle) = global.join_handle.take() {
        handle.abort();
    }
    global.instance = None;
    Ok(())
}

pub async fn get_share_status() -> Result<Option<ShareServerInstance>, String> {
    let global = GLOBAL_SHARE.read().await;
    Ok(global.instance.clone())
}
