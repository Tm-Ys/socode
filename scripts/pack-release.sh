#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"

npm run build

rm -rf release
mkdir -p release

npm pack --pack-destination release

STAGE="$ROOT/release/stage"
mkdir -p "$STAGE/lib/socode"
cp -R dist skills bin package.json README.md "$STAGE/lib/socode/"
chmod +x "$STAGE/lib/socode/bin/socode.mjs"

PORTABLE_NAME="${NAME}-${VERSION}-macos"
PORTABLE="$ROOT/release/${PORTABLE_NAME}"
mkdir -p "$PORTABLE/lib"
cp -R "$STAGE/lib/socode" "$PORTABLE/lib/socode"

cat > "$PORTABLE/socode" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/lib/socode" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "socode 需要 Node 22+" >&2
  exit 1
fi
exec node "$ROOT/bin/socode.mjs" "$@"
EOF
chmod +x "$PORTABLE/socode"

cat > "$PORTABLE/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${PREFIX:-/usr/local}"
if ! command -v node >/dev/null 2>&1; then
  echo "socode 需要 Node 22+，请先安装 Node。" >&2
  exit 1
fi
mkdir -p "$PREFIX/lib" "$PREFIX/bin"
rm -rf "$PREFIX/lib/socode"
cp -R "$HERE/lib/socode" "$PREFIX/lib/socode"
cat > "$PREFIX/bin/socode" <<EOS
#!/usr/bin/env bash
exec node "$PREFIX/lib/socode/bin/socode.mjs" "\$@"
EOS
chmod +x "$PREFIX/bin/socode" "$PREFIX/lib/socode/bin/socode.mjs"
echo "已安装 $PREFIX/bin/socode"
echo "进入项目目录后运行：socode"
EOF
chmod +x "$PORTABLE/install.sh"

cat > "$PORTABLE/uninstall.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
PREFIX="${PREFIX:-/usr/local}"
rm -f "$PREFIX/bin/socode"
rm -rf "$PREFIX/lib/socode"
echo "已卸载 $PREFIX/bin/socode"
EOF
chmod +x "$PORTABLE/uninstall.sh"

tar -C "$ROOT/release" -czf "$ROOT/release/${PORTABLE_NAME}.tar.gz" "$PORTABLE_NAME"

PKGROOT="$ROOT/release/pkgroot"
mkdir -p "$PKGROOT/usr/local/lib" "$PKGROOT/usr/local/bin"
cp -R "$STAGE/lib/socode" "$PKGROOT/usr/local/lib/socode"
cat > "$PKGROOT/usr/local/bin/socode" <<'EOF'
#!/usr/bin/env bash
exec node /usr/local/lib/socode/bin/socode.mjs "$@"
EOF
chmod +x "$PKGROOT/usr/local/bin/socode" "$PKGROOT/usr/local/lib/socode/bin/socode.mjs"

pkgbuild \
  --root "$PKGROOT" \
  --identifier com.github.tm-ys.socode \
  --version "$VERSION" \
  --install-location / \
  "$ROOT/release/${NAME}-${VERSION}.pkg"

DMG="$ROOT/release/dmg"
mkdir -p "$DMG"
cp "$ROOT/release/${NAME}-${VERSION}.pkg" "$DMG/"
cp "$ROOT/release/${PORTABLE_NAME}.tar.gz" "$DMG/"
cat > "$DMG/安装说明.txt" <<EOF
socode ${VERSION}

需要本机已安装 Node 22+。未签名，Gatekeeper 可能会拦截。

方法一：双击 ${NAME}-${VERSION}.pkg
若提示无法打开，按住 Control 点击该文件 → 打开。

方法二：解压 ${PORTABLE_NAME}.tar.gz 后执行：
  sudo ./install.sh

安装后打开终端，进入要处理的项目目录，输入：
  socode
EOF

hdiutil create \
  -volname "socode ${VERSION}" \
  -srcfolder "$DMG" \
  -ov \
  -format UDZO \
  "$ROOT/release/${NAME}-${VERSION}.dmg"

echo
echo "Artifacts:"
ls -lh "$ROOT/release/${NAME}-${VERSION}.tgz" \
  "$ROOT/release/${PORTABLE_NAME}.tar.gz" \
  "$ROOT/release/${NAME}-${VERSION}.pkg" \
  "$ROOT/release/${NAME}-${VERSION}.dmg"
