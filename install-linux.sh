#!/bin/sh
set -eu

PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
ORCA_CLI=${ORCA_CLI:-orca}
if ! command -v "$ORCA_CLI" >/dev/null 2>&1; then
  printf '%s\n' '未找到 Orca CLI。请先安装并启动 Orca 1.4.251+，或设置 ORCA_CLI=/完整路径/orca。' >&2
  exit 1
fi

"$ORCA_CLI" plugin validate "$PLUGIN_DIR"
result_code=0
result=$("$ORCA_CLI" plugin dev load "$PLUGIN_DIR" --json 2>&1) || result_code=$?
printf '%s\n' "$result"
if [ "$result_code" -ne 0 ]; then
  fingerprint=$(printf '%s\n' "$result" | sed -n 's/.*"approvalFingerprint"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -z "$fingerprint" ]; then
    printf '%s\n' '加载失败。请确认新版 Orca 正在运行，并查看上面的错误。' >&2
    exit "$result_code"
  fi
  printf '%s\n' '插件将读取本机对话记录，在 Orca 中显示统计，并保存插件设置。'
  printf '%s' '同意上面列出的权限并加载插件？输入 yes：'
  IFS= read -r answer
  if [ "$answer" != yes ]; then
    printf '%s\n' '未批准加载。'
    exit 3
  fi
  "$ORCA_CLI" plugin dev load "$PLUGIN_DIR" --approve "$fingerprint"
fi
"$ORCA_CLI" plugin system on
"$ORCA_CLI" plugin list
printf '\n%s\n' '插件已加载。请在右侧活动栏打开「对话 TPS」。请保留当前插件目录。'
