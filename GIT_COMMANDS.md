# Windows Git 常用指令速查手册

## 1. 查看修改状态
git status

## 3. 添加修改到暂存区
git add .

## 4. 打修改说明（提交到本地）
git commit -m "修复钉钉三次同步问题"

# 带详细说明的提交
git commit -m "功能标题" -m "详细描述修改内容"

## 5. 提交代码到远程仓库
git push

## 6. 查看最近10条提交记录
```bash
# 简洁模式（推荐）
git log --oneline -n 10

# 详细模式
git log -n 10

# 带图形分支线
git log --oneline --graph -n 10
```

---

## 7. 拉取最新代码
```bash
# 拉取并自动合并（常用）
git pull

# 仅拉取不合并
git fetch

# 拉取指定分支
git pull origin main
```

---

## 8. 拉取指定版本代码
```bash
# 查看所有提交记录，复制commit ID
git log --oneline

# 切换到指定版本（ detached HEAD 状态，只读查看）
git checkout abc1234

# 回退到指定版本并丢弃之后的所有修改（危险！）
git reset --hard abc1234

# 撤销到指定版本但保留修改（安全）
git revert abc1234
```
> **注意**：`abc1234` 替换为实际的 commit ID（前7位即可）。

---

## 常用组合流程

### 日常提交流程
```bash
git status              # 1. 查看修改
git add .               # 2. 添加所有修改
git commit -m "说明"    # 3. 打修改说明
git push                # 4. 提交到远程
```

### 开始工作前更新代码
```bash
git pull                # 拉取同事最新代码
```

---

## 常见问题

| 问题 | 解决指令 |
|------|----------|
| 忘记添加文件就提交了 | `git commit --amend` |
| 误删了本地修改 | `git checkout -- 文件名` |
| 代码冲突了 | 手动解决冲突后 → `git add .` → `git commit` |
| 忽略文件不生效 | `git rm -r --cached .` → `git add .` → `git commit` |
