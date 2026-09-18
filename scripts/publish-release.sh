#!/usr/bin/env bash
# 打包 macOS 安装包、打 tag、推送，并创建 GitHub Release。
# 用法: npm run publish:release
#       bash scripts/publish-release.sh [--skip-tests] [--npm] [--notes FILE]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_TESTS=0
NPM_PUBLISH=0
NOTES_FILE=""

usage() {
  echo "用法: $0 [--skip-tests] [--npm] [--notes FILE]"
  echo "读取 package.json 的 version，运行 pack-release.sh，打 git tag，push，创建 GitHub Release。"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1; shift ;;
    --npm) NPM_PUBLISH=1; shift ;;
    --notes)
      NOTES_FILE="${2:-}"
      if [[ -z "$NOTES_FILE" ]]; then
        echo "--notes 需要文件路径" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage
      exit 1
      ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"
TAG="v${VERSION}"
REPO="Tm-Ys/socode"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "工作区有未提交的已跟踪改动，先提交再发布。" >&2
  git status
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "本地已有 tag $TAG" >&2
  exit 1
fi

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  npm test
fi

bash scripts/pack-release.sh

TGZ="$ROOT/release/${NAME}-${VERSION}.tgz"
TAR="$ROOT/release/${NAME}-${VERSION}-macos.tar.gz"
PKG="$ROOT/release/${NAME}-${VERSION}.pkg"
DMG="$ROOT/release/${NAME}-${VERSION}.dmg"
for file in "$TGZ" "$TAR" "$PKG" "$DMG"; do
  if [[ ! -f "$file" ]]; then
    echo "缺少产物: $file" >&2
    exit 1
  fi
done

NOTES="$(mktemp)"
cleanup() { rm -f "$NOTES"; }
trap cleanup EXIT

if [[ -n "$NOTES_FILE" ]]; then
  cp "$NOTES_FILE" "$NOTES"
else
  {
    echo "## socode ${VERSION}"
    echo
    PREV="$(git describe --tags --abbrev=0 2>/dev/null || true)"
    if [[ -n "$PREV" ]]; then
      git log --pretty='- %s' "${PREV}..HEAD"
    else
      echo "- 见提交记录。"
    fi
    echo
    echo "## 安装"
    echo
    echo "需要 Node 22+（macOS / Linux）。"
    echo
    echo '```bash'
    echo "npm install -g ./socode-${VERSION}.tgz"
    echo "# 或 macOS：双击 socode-${VERSION}.pkg / 打开 .dmg"
    echo '```'
  } > "$NOTES"
fi

git tag -a "$TAG" -m "socode ${VERSION}"
git push origin HEAD
git push origin "$TAG"

gh release create "$TAG" \
  --repo "$REPO" \
  --title "socode ${VERSION}" \
  --notes-file "$NOTES" \
  "$TGZ" "$TAR" "$PKG" "$DMG"

if [[ "$NPM_PUBLISH" -eq 1 ]]; then
  npm publish "$TGZ"
fi

echo
echo "已发布 https://github.com/${REPO}/releases/tag/${TAG}"
