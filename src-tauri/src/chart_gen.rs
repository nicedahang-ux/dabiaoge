use plotters::prelude::*;
use std::path::Path;

/// 从 Markdown 文本中提取所有表格数据
pub fn extract_markdown_tables(content: &str) -> Vec<Vec<Vec<String>>> {
    let mut tables = vec![];
    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        // 找到表格行：以 | 开头
        if lines[i].trim().starts_with('|') {
            let mut table: Vec<Vec<String>> = vec![];
            // 收集连续以 | 开头的行
            while i < lines.len() && lines[i].trim().starts_with('|') {
                let line = lines[i].trim();
                // 跳过分隔行（如 |---|---|）
                if line.replace('|', "").trim().chars().all(|c| c == '-' || c == ':' || c == ' ') {
                    i += 1;
                    continue;
                }
                let cells: Vec<String> = line
                    .split('|')
                    .skip(1)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !cells.is_empty() {
                    table.push(cells);
                }
                i += 1;
            }
            if table.len() >= 2 {
                tables.push(table);
            }
        } else {
            i += 1;
        }
    }
    tables
}

/// 分析表格数据，提取类别-数值对
/// 返回 (类别名, 数值) 的列表，以及可能的图表类型建议
pub fn analyze_table_data(table: &[Vec<String>]) -> Option<(String, Vec<(String, f64)>)> {
    if table.len() < 2 {
        return None;
    }
    let headers = &table[0];
    if headers.len() < 2 {
        return None;
    }

    // 尝试找到数值列（从第二列开始找）
    let mut numeric_col_idx = 1usize;
    let mut numeric_col_name = headers.get(1)?.clone();

    for (idx, header) in headers.iter().enumerate().skip(1) {
        let mut all_numeric = true;
        let mut has_value = false;
        for row in table.iter().skip(1) {
            if let Some(cell) = row.get(idx) {
                let cleaned = cell.replace(',', "").replace('%', "").trim().to_string();
                if cleaned.parse::<f64>().is_ok() {
                    has_value = true;
                } else if !cleaned.is_empty() {
                    all_numeric = false;
                    break;
                }
            }
        }
        if all_numeric && has_value {
            numeric_col_idx = idx;
            numeric_col_name = header.clone();
            break;
        }
    }

    let _category_header = headers.first()?.clone();
    let mut data: Vec<(String, f64)> = vec![];

    for row in table.iter().skip(1) {
        let category = row.first()?.clone();
        let value_str = row.get(numeric_col_idx)?.replace(',', "").replace('%', "");
        let value = value_str.trim().parse::<f64>().ok()?;
        data.push((category, value));
    }

    if data.len() >= 2 && data.len() <= 20 {
        Some((numeric_col_name, data))
    } else {
        None
    }
}

/// 尝试加载系统中文字体文件路径
fn find_cjk_font_path() -> Option<String> {
    let candidates = [
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
        r"C:\Windows\Fonts\simkai.ttf",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
    ];
    for path in &candidates {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

/// 使用字体文件创建 TextStyle
fn make_text_style(size: f64, font_path: Option<&str>) -> TextStyle {
    match font_path {
        Some(_path) => {
            // plotters 0.3 支持从文件加载字体
            // 通过 into_font() 方法
            let style: TextStyle = ("sans-serif", size).into();
            style
        }
        None => ("sans-serif", size).into(),
    }
}

/// 生成柱状图
pub fn generate_bar_chart(
    output_path: &str,
    title: &str,
    data: &[(String, f64)],
) -> Result<(), String> {
    if data.is_empty() {
        return Err("数据为空".to_string());
    }

    let width = (data.len() * 120).max(600).min(1200) as u32;
    let height = 500u32;

    let root = BitMapBackend::new(output_path, (width, height))
        .into_drawing_area();
    root.fill(&WHITE).map_err(|e| e.to_string())?;

    let max_val = data.iter().map(|(_, v)| *v).fold(0.0, f64::max) * 1.2;
    let categories: Vec<String> = data.iter().map(|(k, _)| k.clone()).collect();

    let mut chart = ChartBuilder::on(&root)
        .caption(title, ("sans-serif", 24.0f64))
        .margin(20)
        .x_label_area_size(60)
        .y_label_area_size(60)
        .build_cartesian_2d(0..data.len(), 0.0..max_val)
        .map_err(|e| e.to_string())?;

    chart
        .configure_mesh()
        .x_labels(data.len())
        .x_label_formatter(&|i| {
            if *i < categories.len() {
                // 标签过长时截断
                let label = &categories[*i];
                if label.chars().count() > 8 {
                    format!("{}...", label.chars().take(6).collect::<String>())
                } else {
                    label.clone()
                }
            } else {
                "".to_string()
            }
        })
        .y_label_formatter(&|v| format!("{:.0}", v))
        .draw()
        .map_err(|e| e.to_string())?;

    let bar_color = RGBColor(70, 130, 180);
    chart
        .draw_series(data.iter().enumerate().map(|(i, (_, v))| {
            Rectangle::new([(i, 0.0), (i + 1, *v)], bar_color.filled())
        }))
        .map_err(|e| e.to_string())?;

    root.present().map_err(|e| e.to_string())?;
    Ok(())
}

/// 生成饼图
pub fn generate_pie_chart(
    output_path: &str,
    title: &str,
    data: &[(String, f64)],
) -> Result<(), String> {
    if data.is_empty() {
        return Err("数据为空".to_string());
    }

    let root = BitMapBackend::new(output_path, (700, 500))
        .into_drawing_area();
    root.fill(&WHITE).map_err(|e| e.to_string())?;

    let total: f64 = data.iter().map(|(_, v)| *v).sum();
    if total == 0.0 {
        return Err("数值总和为0".to_string());
    }

    let colors = [
        RGBColor(255, 99, 132),
        RGBColor(54, 162, 235),
        RGBColor(255, 206, 86),
        RGBColor(75, 192, 192),
        RGBColor(153, 102, 255),
        RGBColor(255, 159, 64),
        RGBColor(199, 199, 199),
        RGBColor(83, 102, 255),
        RGBColor(255, 99, 255),
        RGBColor(99, 255, 132),
    ];

    let center = (350, 220);
    let radius = 150;
    let mut start_angle = 0.0;

    // 绘制标题
    root.draw_text(
        title,
        &TextStyle::from(("sans-serif", 24).into_font()).color(&BLACK),
        (350, 30),
    )
    .map_err(|e| e.to_string())?;

    for (idx, (_label, value)) in data.iter().enumerate() {
        let ratio = value / total;
        let angle = ratio * 2.0 * std::f64::consts::PI;
        let end_angle = start_angle + angle;

        let color = colors[idx % colors.len()];

        // 简化的饼图扇形绘制：使用多边形近似
        let mut points = vec![center];
        let segments = 30.max((angle * 50.0) as i32);
        for s in 0..=segments {
            let a = start_angle + angle * (s as f64 / segments as f64);
            let x = center.0 + (radius as f64 * a.cos()) as i32;
            let y = center.1 + (radius as f64 * a.sin()) as i32;
            points.push((x, y));
        }
        root.draw(&plotters::element::Polygon::new(points, color.filled()),
        )
        .map_err(|e| e.to_string())?;

        start_angle = end_angle;
    }

    // 绘制图例
    let legend_x = 520;
    let mut legend_y = 120;
    for (idx, (label, value)) in data.iter().enumerate() {
        let color = colors[idx % colors.len()];
        let pct = value / total * 100.0;
        let display_label = if label.chars().count() > 10 {
            format!("{}...", label.chars().take(8).collect::<String>())
        } else {
            label.clone()
        };

        root.draw(
            &plotters::element::Rectangle::new(
                [(legend_x, legend_y), (legend_x + 15, legend_y + 12)],
                color.filled(),
            ),
        )
        .map_err(|e| e.to_string())?;

        root.draw_text(
            &format!("{} {:.1}%", display_label, pct),
            &TextStyle::from(("sans-serif", 14).into_font()).color(&BLACK),
            (legend_x + 20, legend_y - 2),
        )
        .map_err(|e| e.to_string())?;

        legend_y += 22;
    }

    root.present().map_err(|e| e.to_string())?;
    Ok(())
}

/// 上传图片到服务器，返回在线 URL
pub async fn upload_image(image_path: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let base = "http://122.224.15.26:10012";
    let url = format!("{}/upload/image/", base);

    let file_bytes = tokio::fs::read(image_path)
        .await
        .map_err(|e| format!("读取图片文件失败: {}", e))?;

    let filename = Path::new(image_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("chart.png")
        .to_string();

    let mime_type = if filename.ends_with(".jpg") || filename.ends_with(".jpeg") {
        "image/jpeg"
    } else if filename.ends_with(".png") {
        "image/png"
    } else if filename.ends_with(".gif") {
        "image/gif"
    } else if filename.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str(mime_type)
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new().part("file", part);

    let resp = client
        .post(&url)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("上传图片请求失败: {}", e))?;

    let status = resp.status();
    let body = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;

    if body.get("code").and_then(|v| v.as_i64()) == Some(200) {
        let path = body
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or("上传响应中缺少 url 字段")?;
        let full_url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", base, path)
        };
        Ok(full_url)
    } else {
        Err(format!("上传图片失败 [{}]: {:?}", status, body))
    }
}

/// 从 AI 回复中提取表格、生成图表、上传，返回图片 URL 列表和加工后的 markdown
pub async fn process_tables_into_charts(
    content: &str,
    temp_dir: &str,
) -> Result<(String, Vec<String>), String> {
    let tables = extract_markdown_tables(content);
    if tables.is_empty() {
        return Ok((content.to_string(), vec![]));
    }

    let mut image_urls: Vec<String> = vec![];
    let mut modified_content = content.to_string();

    for (idx, table) in tables.iter().enumerate() {
        if let Some((metric_name, data)) = analyze_table_data(table) {
            // 根据数据特点选择图表类型
            let chart_type = if data.len() <= 6 {
                "pie"
            } else {
                "bar"
            };

            let file_name = format!("{}_chart_{}.png", chrono::Local::now().format("%Y%m%d_%H%M%S"), idx);
            let file_path = Path::new(temp_dir).join(&file_name);
            let file_path_str = file_path.to_string_lossy().to_string();

            let title = format!("{}分布", metric_name);
            let gen_result = if chart_type == "pie" {
                generate_pie_chart(&file_path_str, &title, &data)
            } else {
                generate_bar_chart(&file_path_str, &title, &data)
            };

            match gen_result {
                Ok(_) => {
                    match upload_image(&file_path_str).await {
                        Ok(url) => {
                            image_urls.push(url.clone());
                            // 在表格后面插入图片标记
                            if let Some(table_end) = find_table_end(&modified_content, idx) {
                                let insert_text = format!("\n\n![{}图表]({})\n", metric_name, url);
                                modified_content.insert_str(table_end, &insert_text);
                            }
                        }
                        Err(e) => {
                            eprintln!("[Chart Upload Error] 上传图表失败: {}", e);
                        }
                    }
                    // 清理临时文件
                    let _ = tokio::fs::remove_file(&file_path).await;
                }
                Err(e) => {
                    eprintln!("[Chart Gen Error] 生成图表失败: {}", e);
                }
            }
        }
    }

    Ok((modified_content, image_urls))
}

/// 找到第 idx 个 markdown 表格的结束位置
fn find_table_end(content: &str, idx: usize) -> Option<usize> {
    let mut count = 0;
    let mut in_table = false;
    let mut last_pipe_line_end = 0;

    for (pos, ch) in content.char_indices() {
        if ch == '\n' {
            let line_start = content[..pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
            let line = &content[line_start..pos];
            if line.trim().starts_with('|') {
                if !in_table {
                    in_table = true;
                }
                last_pipe_line_end = pos;
            } else {
                if in_table {
                    if count == idx {
                        return Some(last_pipe_line_end);
                    }
                    count += 1;
                    in_table = false;
                }
            }
        }
    }

    if in_table && count == idx {
        return Some(last_pipe_line_end);
    }

    None
}
