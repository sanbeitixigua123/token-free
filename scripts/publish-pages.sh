#!/usr/bin/env bash
# ============================================================
#  publish-pages.sh — 把 public/ 部署到 GitHub Pages（gh-pages 分支）
#
#  ⚠️ 本脚本是「备用发布通道」，不是默认通道。
#
#  默认通道是 .github/workflows/deploy.yml（Pages 源 = "GitHub Actions"），
#  它与 daily-crawl.yml 构成闭环：抓取 → 导出 public/data → 回写 main
#  → deploy.yml 因 public/** 变更自动触发部署。**无需人工干预。**
#
#  本脚本仅在以下场景使用：
#    - 你希望 Pages 源设为 "Deploy from a branch"（例如组织策略限制）
#    - 需要在本地一次性推送产物，而不想等 CI
#
#  🚫 两条通道**不可同时启用**：Pages 源只能选一个。若已把源设为
#  "GitHub Actions"，请不要运行本脚本，否则线上内容会与 CI 产物分叉。
#
#  工作方式：
#    1. npm run build  →  重新导出 public/data/（保证数据最新）
#    2. 临时 git worktree 检出 gh-pages 分支（不存在则自动创建）
#    3. 用 public/ 的内容覆盖该分支工作区并提交
#    4. push 到 origin gh-pages
#    5. 清理 worktree
#
#  为什么用 worktree 而不是 subtree / docs 目录？
#    - `git subtree push --prefix public` 会遍历整个历史，速度慢，
#      且 public/ 是每日常量重写的产物，subtree 会积累大量噪音提交。
#    - 用 `docs/` 目录则要求 Pages 源固定为 "main /docs"，
#      且 docs/ 会混进主分支历史，既污染主分支又无法干净地只保留产物。
#    - 临时 worktree 把产物隔离在独立分支，主分支零污染，
#      推送历史线性干净（每次一个部署提交），清理后本地不留痕迹。
#
#  前置条件：
#    - 仓库已存在且已配置 remote（本脚本只做 push，不创建仓库）
#    - 本机 GitHub 凭据在 Git Credential Manager 中
#      （GitHub 连接器只有只读权限，无法建仓库，故不在此处建库）
#
#  用法：
#    bash scripts/publish-pages.sh
#    REPO=https://github.com/me/token-free.git bash scripts/publish-pages.sh
#    BRANCH=gh-pages REMOTE=origin bash scripts/publish-pages.sh
#
#  环境变量：
#    REPO    目标仓库地址（默认取当前仓库 origin）
#    REMOTE  远端名（默认 origin）
#    BRANCH  Pages 分支（默认 gh-pages）
#    SKIP_BUILD=1  跳过 npm run build（调试用，直接用现有 public/）
# ============================================================

set -euo pipefail

# ---------------- 彩色输出 ----------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'; C_CYAN=$'\033[0;36m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''; C_BOLD=''; C_RESET=''
fi

info()  { printf '%s[publish]%s %s\n' "$C_BLUE"   "$C_RESET" "$*"; }
ok()    { printf '%s[publish]%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }
warn()  { printf '%s[publish]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
step()  { printf '\n%s%s▸ %s%s\n' "$C_BOLD" "$C_CYAN" "$*" "$C_RESET"; }
fail()  { printf '\n%s[publish] 错误：%s%s\n' "$C_RED$C_BOLD" "$*" "$C_RESET" >&2; exit 1; }

# ---------------- 定位项目根 ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BRANCH="${BRANCH:-gh-pages}"
REMOTE="${REMOTE:-origin}"
SKIP_BUILD="${SKIP_BUILD:-0}"

printf '%s%s Token Free → GitHub Pages%s\n' "$C_BOLD" "$C_CYAN" "$C_RESET"
info "项目根目录：$ROOT_DIR"

# ---------------- 前置检查 ----------------
command -v git >/dev/null 2>&1 || fail "未找到 git，请先安装 Git。"
command -v npm >/dev/null 2>&1 || fail "未找到 npm，请先安装 Node.js 22+。"
[ -d "$ROOT_DIR/public" ] || fail "未找到 public/ 目录，确认在项目根目录执行。"
[ -f "$ROOT_DIR/package.json" ] || fail "未找到 package.json。"

# 是否在 git 仓库内
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  fail "当前目录不是 git 仓库。请先初始化并关联远端，例如：
    git init && git remote add origin <REPO> && git add -A && git commit -m init"
fi

# 解析仓库地址：优先环境变量 REPO，其次 remote
if [ -n "${REPO:-}" ]; then
  REPO_URL="$REPO"
  # 若远端不存在则创建
  if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
    info "未找到远端 '$REMOTE'，用 REPO 创建之"
    git remote add "$REMOTE" "$REPO_URL"
  elif [ "$(git remote get-url "$REMOTE")" != "$REPO_URL" ]; then
    info "更新远端 '$REMOTE' → $REPO_URL"
    git remote set-url "$REMOTE" "$REPO_URL"
  fi
else
  REPO_URL="$(git remote get-url "$REMOTE" 2>/dev/null || true)"
  [ -n "$REPO_URL" ] || fail "未配置远端 '$REMOTE'，且未提供 REPO 环境变量。
  请执行：git remote add $REMOTE <仓库地址>
  或：REPO=https://github.com/<user>/<repo>.git bash scripts/publish-pages.sh"
fi

# 规范化仓库 URL（去 .git / 末尾斜杠），并推导网页地址
web_url() {
  local u="$1"
  u="${u%.git}"; u="${u%/}"
  if [[ "$u" =~ ^git@([^:]+):(.+)$ ]]; then
    u="https://${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  elif [[ "$u" =~ ^ssh://git@([^/]+)/(.+)$ ]]; then
    u="https://${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  fi
  echo "$u"
}
REPO_WEB="$(web_url "$REPO_URL")"
# 站点地址：<user>.github.io/<repo>/ ；若仓库本身是 <user>.github.io 则无子路径
REPO_NAME="$(basename "$REPO_WEB")"
REPO_OWNER="$(basename "$(dirname "$REPO_WEB")")"
if [[ "$REPO_NAME" == *.github.io ]]; then
  SITE_URL="https://${REPO_NAME}/"
else
  SITE_URL="https://${REPO_OWNER}.github.io/${REPO_NAME}/"
fi

info "远端仓库：$REPO_URL"
info "目标分支：$BRANCH"
info "预计站点：$SITE_URL"

# ---------------- 1. 构建静态数据 ----------------
if [ "$SKIP_BUILD" = "1" ]; then
  warn "SKIP_BUILD=1，跳过 npm run build（将使用现有 public/）"
else
  step "1/4 导出静态数据（npm run build）"
  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    info "未发现 node_modules，先执行 npm ci"
    npm ci
  fi
  npm run build || fail "npm run build 失败，已中止部署。"
  [ -f "$ROOT_DIR/public/data/activities.json" ] || fail "构建后未生成 public/data/activities.json，导出可能异常。"
  [ -f "$ROOT_DIR/public/index.html" ] || fail "未找到 public/index.html，Pages 首页缺失。"
  ok "静态数据已导出"
fi

# ---------------- 2. 准备临时 worktree ----------------
step "2/4 准备 gh-pages 分支（临时 worktree）"

WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/tokenfree-pages.XXXXXX")"
# mktemp -d 已创建目录，git worktree 要求目标不存在，故移除
rmdir "$WORKTREE"

cleanup() {
  if [ -d "$ROOT_DIR/.git" ] || git rev-parse --git-dir >/dev/null 2>&1; then
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
    git worktree prune >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 远端是否已有该分支
if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  info "远端已存在分支 '$BRANCH'，检出中"
  git fetch --no-tags "$REMOTE" "$BRANCH" || fail "拉取远端分支失败（检查网络与凭据）。"
  git worktree add --force -B "$BRANCH" "$WORKTREE" FETCH_HEAD \
    || fail "创建 worktree 失败。"
else
  info "远端无 '$BRANCH'，创建孤立分支（orphan）"
  git worktree add --force --no-checkout "$WORKTREE" >/dev/null
  git -C "$WORKTREE" checkout --orphan "$BRANCH" >/dev/null \
    || fail "创建孤立分支 '$BRANCH' 失败。"
  git -C "$WORKTREE" rm -rf --cached . >/dev/null 2>&1 || true
  ok "已创建新分支 '$BRANCH'"
fi

# ---------------- 3. 同步 public/ 内容 ----------------
step "3/4 同步 public/ 到 '$BRANCH'"

# 清空工作区（保留 .git），再整目录复制，确保删除已移除的旧文件
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

# 复制 public/ 下所有内容（含隐藏文件）
shopt -s dotglob nullglob
cp -R "$ROOT_DIR/public/." "$WORKTREE/"
shopt -u dotglob nullglob

# GitHub Pages 用 Jekyll 处理静态站，会忽略下划线开头的文件/目录，
# 这里加 .nojekyll 保证纯静态资源（如 _next、_astro 等）也能被直接访问。
: > "$WORKTREE/.nojekyll"

# 让 Pages 默认显示中文
printf 'zh-CN\n' > "$WORKTREE/.locale" 2>/dev/null || true

git -C "$WORKTREE" add -A

if git -C "$WORKTREE" diff --cached --quiet; then
  warn "内容与 '$BRANCH' 现有内容完全一致，无可提交变更（可能数据未更新）。"
  SYNCED=0
else
  SYNCED=1
fi

# ---------------- 4. 提交并推送 ----------------
step "4/4 提交并推送到 $REMOTE/$BRANCH"

BUILD_TIME="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
# 尽量用仓库身份；缺失时兜底
GIT_NAME="$(git config user.name 2>/dev/null || echo 'Token Free Bot')"
GIT_EMAIL="$(git config user.email 2>/dev/null || echo 'tokenfree@users.noreply.github.com')"
git -C "$WORKTREE" -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
  commit -m "deploy(pages): 静态站发布 @ ${BUILD_TIME}" --quiet \
  || fail "提交失败。"

# 用 Credential Manager 推送（本机 GitHub 凭据存放于此）
git -c credential.helper=manager -C "$WORKTREE" push --force "$REMOTE" "$BRANCH" \
  || fail "推送失败。常见原因：
  - 凭据失效：执行 git -c credential.helper=manager ls-remote $REPO_URL
  - 无写权限：确认当前凭据对应仓库有 push 权限（连接器只读，需本机凭据）
  - 分支保护：gh-pages 若设了保护规则需先解除"

ok "已推送 '$BRANCH'（提交：$(git -C "$WORKTREE" rev-parse --short HEAD)）"

# ---------------- 完成 ----------------
printf '\n%s%s✔ 部署完成%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '  站点地址：%s%s%s\n' "$C_CYAN" "$SITE_URL" "$C_RESET"
printf '  数据快照：%sdata/activities.json%s\n' "$C_BLUE" "$C_RESET"
printf '\n  首次部署后请在仓库 Settings → Pages 中确认：\n'
printf '    Source = Deploy from a branch → Branch = %s / (root)\n' "$BRANCH"
printf '  或改用 GitHub Actions 部署（见 .github/workflows/deploy.yml），二者选其一。\n\n'
