#!/bin/bash
set -euo pipefail
umask 022

fail() { printf '准备失败：%s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == 0 ]] || fail '请在服务器的 root 终端执行。'
[[ "$(uname -s)" == Linux ]] || fail '仅支持 Ubuntu Linux。'
[[ "$(uname -m)" == x86_64 ]] || fail '此准备脚本仅支持 x86_64。'
[[ -r /etc/os-release ]] || fail '无法确认操作系统。'
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || fail '仅支持 Ubuntu，不会修改其他系统。'

for command in curl sha256sum tar xz python3 nginx getent groupadd useradd install stat; do
    command -v "$command" >/dev/null 2>&1 || fail "缺少 $command，请先安装对应的 Ubuntu 官方软件包。"
done

printf 'Ubuntu %s · x86_64\n' "${VERSION_ID:-unknown}"
printf '\n8443 监听状态：\n'
if command -v ss >/dev/null 2>&1; then
    ss -ltn '( sport = :8443 )'
else
    printf '未找到 ss；请安装 iproute2 后检查 8443 是否空闲。\n'
fi

python3 - <<'PY'
from pathlib import Path
import re

print('\n现有 Certbot 全局配置（仅报告键名，不显示值）：')
for name in ['/etc/letsencrypt/cli.ini', '/root/.config/letsencrypt/cli.ini']:
    path = Path(name)
    if not path.exists():
        print(f'{name}: 不存在')
        continue
    print(f'{name}: 存在')
    try:
        keys = set()
        unrecognized = False
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith(('#', ';', '[')):
                continue
            key, separator, _ = line.partition('=')
            key = key.strip()
            if separator and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', key):
                keys.add(key)
            else:
                unrecognized = True
        print('  键名: ' + (', '.join(sorted(keys)) or '无'))
        if unrecognized:
            print('  有非标准条目，内容未显示；签发前需人工核对。')
    except (OSError, UnicodeError) as error:
        print(f'  无法读取，签发前需人工核对（{type(error).__name__}）。')
PY

python3 -c 'import ensurepip' >/dev/null 2>&1 || fail '缺少 python3-venv。请执行 apt-get install --no-install-recommends python3-venv 后重试；不需要全系统升级。'

APP=/opt/custom-attendance
NODE_DIR="$APP/runtime/node"
CERTBOT_VENV="$APP/certbot-venv"
for directory in "$APP" "$APP/runtime" "$NODE_DIR" "$CERTBOT_VENV" "$APP/data" /etc/custom-attendance /etc/custom-attendance/acme /var/lib/custom-attendance-acme /var/log/custom-attendance-acme; do
    [[ ! -L "$directory" ]] || fail "目录不可为符号链接：$directory"
    if [[ -e "$directory" && ! -d "$directory" ]]; then
        fail "路径已存在且不是目录：$directory"
    fi
done
for directory in "$APP" "$APP/runtime" "$NODE_DIR" "$CERTBOT_VENV"; do
    if [[ -d "$directory" && "$(stat -c '%u' "$directory")" != 0 ]]; then
        fail "$directory 必须由 root 拥有；请先核对已有目录，不会递归修改代码所有权。"
    fi
done
install -d -m 0755 -o root -g root "$APP" "$APP/runtime"

if [[ -d "$NODE_DIR" ]]; then
    [[ -x "$NODE_DIR/bin/node" ]] || fail '已有隔离 Node 目录不完整，请人工核对后重试。'
    version=$("$NODE_DIR/bin/node" --version) || fail '已有隔离 Node 无法运行。'
    [[ "$version" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || fail "已有隔离 Node 不是稳定的 24 版本：$version；未覆盖。"
else
    archive=node-v24.22.3-linux-x64.tar.xz
    download_dir=$(mktemp -d "$APP/runtime/.node-download.XXXXXX")
    trap 'rm -rf -- "$download_dir"' EXIT
    for filename in "$archive" SHASUMS256.txt; do
        curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
            --connect-timeout 15 --max-time 300 \
            "https://nodejs.org/dist/v24.22.3/$filename" --output "$download_dir/$filename"
    done
    checksum=''
    matches=0
    while read -r sum filename; do
        if [[ "$filename" == "$archive" ]]; then
            checksum=$sum
            matches=$((matches + 1))
        fi
    done < "$download_dir/SHASUMS256.txt"
    [[ "$matches" == 1 && "$checksum" =~ ^[[:xdigit:]]{64}$ ]] || fail '官方校验文件中未找到唯一有效的 Node SHA-256。'
    printf '%s  %s\n' "$checksum" "$archive" > "$download_dir/selected.sha256"
    (cd "$download_dir" && sha256sum --check --strict selected.sha256)
    tar --extract --xz --file "$download_dir/$archive" --directory "$download_dir" --no-same-owner --no-same-permissions
    [[ "$("$download_dir/node-v24.22.3-linux-x64/bin/node" --version)" == v24.22.3 ]] || fail '下载的 Node 版本不正确。'
    mv "$download_dir/node-v24.22.3-linux-x64" "$NODE_DIR"
fi

if [[ ! -d "$CERTBOT_VENV" ]]; then
    python3 -m venv "$CERTBOT_VENV"
fi
[[ -x "$CERTBOT_VENV/bin/python" ]] || fail '已有 Certbot 虚拟环境不完整，请人工核对后重试。'
"$CERTBOT_VENV/bin/python" -c 'import sys; assert sys.prefix != sys.base_prefix' || fail 'Certbot 路径不是独立 Python 虚拟环境。'
if ! "$CERTBOT_VENV/bin/python" -c 'from importlib.metadata import version; assert version("certbot") == "5.10.0"' >/dev/null 2>&1; then
    "$CERTBOT_VENV/bin/python" -m pip --isolated install --disable-pip-version-check \
        --index-url https://pypi.org/simple certbot==5.10.0
fi

if ! getent group custom-attendance >/dev/null; then
    groupadd --system custom-attendance
fi
if ! id -u custom-attendance >/dev/null 2>&1; then
    useradd --system --gid custom-attendance --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin custom-attendance
fi
[[ "$(id -u custom-attendance)" != 0 && "$(id -gn custom-attendance)" == custom-attendance ]] || fail '已有 custom-attendance 用户权限不符合预期，请人工核对。'
install -d -m 0700 -o custom-attendance -g custom-attendance "$APP/data"
chown -R --no-dereference custom-attendance:custom-attendance "$APP/data"
install -d -m 0700 -o root -g root /etc/custom-attendance/acme /var/lib/custom-attendance-acme /var/log/custom-attendance-acme

printf '\n隔离 Node：\n'
"$NODE_DIR/bin/node" --version
printf '\n隔离 Certbot：\n'
"$CERTBOT_VENV/bin/python" -c 'from importlib.metadata import version; print("certbot " + version("certbot"))'
printf '\nNginx 版本（未测试或重载配置）：\n'
nginx -v
printf '\n准备完成。未签发证书、未接受服务条款、未改 Nginx、未启用服务或定时器。\n'
printf '未修改 /usr/bin/node、/usr/bin/certbot 或旧证书配置；签发前请先核对上面报告的全局配置键名。\n'
