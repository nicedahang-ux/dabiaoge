# AI表格转看板 更新服务部署文档

## 服务说明

这是一个基于 Node.js + Express 的轻量级更新服务，用于托管 AI表格转看板 的在线更新包。

## 部署步骤

### 1. 上传到服务器

将 `update-server/` 目录下的所有文件上传到服务器任意目录：

```
update-server/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── server.js
└── public/           <-- 更新包存放目录
    ├── update-info.json
    ├── versions.json
    └── AI表格转看板_xxx_x64-setup.nsis.zip
```

### 2. 启动服务

```bash
cd update-server
docker-compose up -d
```

服务将监听 **10024** 端口。

### 3. 配置反向代理（Nginx 示例）

如果你需要通过 `https://excel.lidani.cn:8990` 访问，配置 Nginx：

```nginx
server {
    listen 8990 ssl;
    server_name excel.lidani.cn;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:10024;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 发布新版本流程

### 1. 修改版本号

修改以下文件中的版本号：
- `src-tauri/tauri.conf.json` -> `version`
- `src-tauri/Cargo.toml` -> `version`
- `package.json` -> `version`
- `src/pages/SoftwareInfo.tsx` -> `CURRENT_VERSION`

### 2. 构建

```bash
# Windows PowerShell
$env:TAURI_SIGNING_PRIVATE_KEY="dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5eHVsVldFME1ZemZ0dmJ2N2VxbzlveVh0UlhFK1duUTVVSXdVWnhHbFNPOEFBQkFBQUFBQUFBQUFBQUlBQUFBQUF2ZWVTdmdlUDU0SmJvVnhUTDB1Q0JlQmpWeGE3OGxybWZCZEluZFJUTCtaREpnejRNTzFIc2txaS94R3ZoY2ZVZnpHay9lVTQ2QXcxNjBYd0p3Qi9tN2ZBTkw1dWdrbXdNNmFkaUErNVBNcHY4ZHJuamRBWFl2bHpFZEZwd2gwSFpua2JkZ3JtU2M9Cg=="
npx tauri build --bundles nsis
```

### 3. 上传更新包

将生成的 `.nsis.zip` 复制到 `update-server/public/`：

```bash
cp src-tauri/target/release/bundle/nsis/AI表格转看板_0.x.x_x64-setup.nsis.zip update-server/public/
```

### 4. 更新版本信息

修改 `update-server/public/update-info.json`，**必须包含 `signature` 字段**：

```json
{
  "version": "0.x.x",
  "notes": "更新内容描述",
  "pub_date": "2026-04-26T12:00:00Z",
  "url": "https://excel.lidani.cn:8990/download/AI表格转看板_0.x.x_x64-setup.nsis.zip",
  "signature": "从 .sig 文件读取的签名内容"
}
```

**获取 signature 的方法**：

构建完成后，Tauri 会生成 `.nsis.zip.sig` 签名文件，读取其内容填入 signature：

```bash
# PowerShell
cat src-tauri/target/release/bundle/nsis/AI表格转看板_0.x.x_x64-setup.nsis.zip.sig
```

> **注意**：`signature` 字段必须存在且内容正确，否则客户端检查更新会报错 `the signature field was not set on the updater response`。

### 5. 更新历史版本记录

修改 `update-server/public/versions.json`，在数组开头插入新版本：

```json
[
  {
    "version": "0.x.x",
    "date": "2026-04-26",
    "notes": "更新内容",
    "filename": "AI表格转看板_0.x.x_x64-setup.nsis.zip"
  },
  ...
]
```

### 6. 重启服务

```bash
cd update-server
docker-compose restart
```

## 管理接口

- `GET /health` - 健康检查
- `GET /admin/files` - 列出 public 目录下所有文件
- `POST /admin/update-info` - 动态修改 update-info.json

## 注意事项

1. 私钥环境变量 `TAURI_SIGNING_PRIVATE_KEY` 必须每次构建时设置
2. 公钥已硬编码在 `tauri.conf.json` 中，不要修改
3. 每次发版务必保留旧版本的 `.nsis.zip`，以便用户降级
