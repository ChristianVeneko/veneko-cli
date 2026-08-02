#!/usr/bin/env bash
#
# Removes veneko-cli from macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/uninstall.sh | bash
#
# Your API keys live in ~/.veneko/config.json and are kept unless you pass
# --purge. The Python tools (markitdown, yt-dlp) and ffmpeg are left alone:
# they are useful on their own and were probably not installed only for veneko.

set -eEuo pipefail

VENEKO_HOME="${VENEKO_HOME:-$HOME/.veneko}"
BIN_DIR="${VENEKO_BIN_DIR:-$HOME/.local/bin}"
PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    --prefix) VENEKO_HOME="${2:?--prefix needs a value}"; shift ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir needs a value}"; shift ;;
    -h|--help)
      cat <<EOF
veneko-cli uninstaller

Usage: uninstall.sh [--purge] [--prefix DIR] [--bin-dir DIR]

  --purge      Also delete your configuration and stored API keys
  --prefix     Installation directory  (default: \$HOME/.veneko)
  --bin-dir    Launcher directory      (default: \$HOME/.local/bin)
EOF
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RESET=""
fi

removed=0

remove_path() {
  if [ -e "$1" ]; then
    rm -rf "$1"
    printf '  %s✔%s removed %s\n' "$GREEN" "$RESET" "$1"
    removed=$((removed + 1))
  fi
}

printf '\n%sUninstalling veneko-cli%s\n\n' "$BOLD" "$RESET"

remove_path "$VENEKO_HOME/app"
remove_path "$VENEKO_HOME/.stage"
remove_path "$VENEKO_HOME/.previous"
remove_path "$BIN_DIR/veneko"

if [ "$PURGE" -eq 1 ]; then
  remove_path "$VENEKO_HOME"
elif [ -f "$VENEKO_HOME/config.json" ]; then
  printf '  %s○%s kept %s %s(use --purge to delete it)%s\n' \
    "$YELLOW" "$RESET" "$VENEKO_HOME/config.json" "$DIM" "$RESET"
else
  # An empty ~/.veneko left behind is just litter. $BIN_DIR is deliberately
  # left alone: other tools live there too.
  rmdir "$VENEKO_HOME" 2>/dev/null || true
fi

if [ "$removed" -eq 0 ]; then
  printf '\n  Nothing to remove — veneko was not installed at %s.\n\n' "$VENEKO_HOME"
  exit 0
fi

printf '\n%sveneko-cli is uninstalled.%s\n\n' "$GREEN$BOLD" "$RESET"

# The PATH line is left in place: removing a line from someone else's shell
# config is the kind of edit that breaks setups nobody can then debug.
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" \
          "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; do
  if [ -f "$rc" ] && grep -q "veneko-cli installer" "$rc" 2>/dev/null; then
    printf '  %sOne line is still in %s — delete it when convenient:%s\n' "$DIM" "$rc" "$RESET"
    printf '  %s  # added by the veneko-cli installer%s\n\n' "$DIM" "$RESET"
  fi
done
