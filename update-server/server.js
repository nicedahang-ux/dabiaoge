const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10024;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(cors());
app.use(express.json());

// 确保 public 目录存在
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

/**
 * GET /update.json
 * 返回最新版本信息，供 Tauri updater 检查更新
 *
 * Tauri updater 要求的 JSON 格式:
 * {
 *   "version": "0.1.1",
 *   "notes": "更新日志",
 *   "pub_date": "2023-01-01T00:00:00Z",
 *   "signature": "签名内容(可选)",
 *   "url": "https://excel.lidani.cn:8990/download/xxx.nsis.zip"
 * }
 */
app.get('/update.json', (req, res) => {
  const updateInfoPath = path.join(PUBLIC_DIR, 'update-info.json');

  if (!fs.existsSync(updateInfoPath)) {
    return res.status(404).json({
      error: '更新信息未配置',
      message: '请将 update-info.json 放入 public 目录'
    });
  }

  try {
    const raw = fs.readFileSync(updateInfoPath, 'utf-8');
    const info = JSON.parse(raw);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: '读取更新信息失败', message: err.message });
  }
});

/**
 * GET /download/:filename
 * 提供安装包/更新包下载
 */
app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(PUBLIC_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在', filename });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

/**
 * GET /health
 * 健康检查
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ai-excel-kanban-update-server' });
});

/**
 * POST /admin/update-info
 * 管理员接口：更新版本信息（可通过挂载 volume 或直接修改文件）
 */
app.post('/admin/update-info', (req, res) => {
  const updateInfoPath = path.join(PUBLIC_DIR, 'update-info.json');
  try {
    fs.writeFileSync(updateInfoPath, JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ success: true, message: '更新信息已保存' });
  } catch (err) {
    res.status(500).json({ error: '保存失败', message: err.message });
  }
});

/**
 * GET /versions.json
 * 返回所有历史版本列表，供客户端选择降级或查看历史
 */
app.get('/versions.json', (req, res) => {
  const versionsPath = path.join(PUBLIC_DIR, 'versions.json');

  if (!fs.existsSync(versionsPath)) {
    return res.status(404).json({
      error: '历史版本信息未配置',
      message: '请将 versions.json 放入 public 目录'
    });
  }

  try {
    const raw = fs.readFileSync(versionsPath, 'utf-8');
    const versions = JSON.parse(raw);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: '读取历史版本信息失败', message: err.message });
  }
});

/**
 * GET /admin/files
 * 列出 public 目录下的所有文件
 */
app.get('/admin/files', (req, res) => {
  try {
    const files = fs.readdirSync(PUBLIC_DIR).map((name) => {
      const stat = fs.statSync(path.join(PUBLIC_DIR, name));
      return {
        name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    });
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: '读取文件列表失败', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AI表格转看板 更新服务已启动`);
  console.log(`监听端口: ${PORT}`);
  console.log(`更新接口: http://localhost:${PORT}/update.json`);
  console.log(`下载接口: http://localhost:${PORT}/download/:filename`);
  console.log(`健康检查: http://localhost:${PORT}/health`);
  console.log(`文件目录: ${PUBLIC_DIR}`);
});
