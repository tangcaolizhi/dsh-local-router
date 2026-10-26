# 发布到 GitHub

本目录已经整理成可直接上传的仓库结构。当前机器没有安装 Git，也没有登录 GitHub CLI，
所以最后一步需要你在本机完成。

## 方式 A：网页上传（最简单）

1. 解压 `dsh-local-router-github.zip`。
2. 打开 GitHub → New repository：
   - Repository name: `dsh-local-router`
   - 选择 Public
   - 不要勾选 “Add a README file”（仓库里已有）
3. 创建后进入仓库 → Add file → Upload files。
4. 把解压后的**内容**（不是外层文件夹）拖进去：
   `README.md`、`index.js`、`package.json`、`LICENSE`、`cordis.patch.yml`、
   `locale/`、`docs/`、`test/`、`.github/` 等。
5. Commit changes。
6. 编辑 `README.md` 和 `package.json`，把 `<your-account>` 换成你的 GitHub 用户名
   （如果使用网页上传，`.github/` 是隐藏目录；可以在 Add file → Create new file
   里手动创建 `.github/workflows/ci.yml`，内容见本仓库同名文件）。

## 方式 B：Git 命令（推荐，能保留 `.github`）

1. 安装 [Git for Windows](https://git-scm.com/download/win)，或 GitHub Desktop。
2. 在 GitHub 新建空仓库 `dsh-local-router`（不要初始化 README）。
3. 在本目录执行：

```bash
cd /d/deepseek-workspace/dsh-local-router

git init
git add .
git commit -m "feat: initial dsh-local-router"
git branch -M main
git remote add origin https://github.com/<your-account>/dsh-local-router.git
git push -u origin main
```

4. 如果使用 GitHub Desktop，直接 Add local repository → Publish repository 即可。
5. 推送后，把 README / package.json 里的 `<your-account>` 替换成实际用户名，
   再提交一次。

## 注意

- 不要提交 `.env`、API Key、AppSecret、QQ 群号/成员信息或任何私密对话。
- 仓库默认不包含 `node_modules`、`out/`、`stills/`，这些已在 `.gitignore` 里忽略。
- `private: true` 表示不通过 npm 发布；如果以后要发 npm，改成 `false` 并补充
  `repository` / `homepage` / `bugs` 字段。
- 当前版本未在 macOS/Linux 实测；README 已写明兼容性边界。
