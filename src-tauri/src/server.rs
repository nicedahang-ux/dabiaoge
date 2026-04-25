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
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

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
    (
        StatusCode::OK,
        Json(json!({
            "board_id": state.board_id,
            "data": state.chart_data,
            "allow_refresh": state.allow_refresh,
        })),
    )
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
) -> Result<ShareInfo, String> {
    let pin = generate_pin();
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

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    Ok(ShareInfo { url, pin })
}
