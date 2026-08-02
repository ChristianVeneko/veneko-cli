#!/usr/bin/env bash
#
# veneko-cli installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/install.sh | bash
#
# Everything lands under $HOME. The installer never uses sudo and never writes
# outside the home directory, so an install can always be undone by deleting
# two paths (printed in the summary).

# -E matters: without errtrace the ERR trap is not inherited by functions, and
# every failure below happens inside one.
set -eEuo pipefail

REPO_OWNER="ChristianVeneko"
REPO_NAME="veneko-cli"
REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}"
API_URL="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"

MIN_NODE_MAJOR=20
TOTAL_STEPS=9

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

# Every flag below is also readable from the environment. `curl … | bash`
# cannot pass arguments, and that is the documented way to install, so an
# option that only exists as a flag is an option most people cannot reach.
VENEKO_HOME="${VENEKO_HOME:-$HOME/.veneko}"
BIN_DIR="${VENEKO_BIN_DIR:-$HOME/.local/bin}"
REQUESTED_VERSION="${VENEKO_VERSION:-}"
ASSUME_YES="${VENEKO_YES:-0}"
WITH_PYTHON=$([ "${VENEKO_NO_PYTHON:-0}" = "1" ] && echo 0 || echo 1)
WITH_FFMPEG=$([ "${VENEKO_NO_FFMPEG:-0}" = "1" ] && echo 0 || echo 1)
UPDATE_PATH=$([ "${VENEKO_NO_PATH:-0}" = "1" ] && echo 0 || echo 1)
VERBOSE="${VENEKO_VERBOSE:-0}"

usage() {
  cat <<EOF
veneko-cli installer

Usage: install.sh [options]

Options:
  -y, --yes            Do not ask anything; take the safe default for every prompt
      --version TAG    Install a specific release tag (default: the latest one)
      --prefix DIR     Where veneko is installed        (default: \$HOME/.veneko)
      --bin-dir DIR    Where the launcher is placed     (default: \$HOME/.local/bin)
      --no-python      Skip the optional Python tools (markitdown, yt-dlp)
      --no-ffmpeg      Skip the optional ffmpeg install
      --no-path        Do not touch your shell configuration
      --verbose        Show the full output of every command
  -h, --help           Show this message

Every option is also readable from the environment, which is how you set them
when installing through a pipe:

  VENEKO_HOME        same as --prefix
  VENEKO_BIN_DIR     same as --bin-dir
  VENEKO_VERSION     same as --version
  VENEKO_YES=1       same as --yes
  VENEKO_NO_PYTHON=1 same as --no-python
  VENEKO_NO_FFMPEG=1 same as --no-ffmpeg
  VENEKO_NO_PATH=1   same as --no-path
  VENEKO_VERBOSE=1   same as --verbose

  curl -fsSL .../install.sh | VENEKO_NO_PYTHON=1 bash
EOF
}

require_value() {
  if [ -z "${2:-}" ]; then
    printf 'Option %s needs a value.\n\n' "$1" >&2
    usage >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --version) require_value "$1" "${2:-}"; REQUESTED_VERSION="$2"; shift ;;
    --prefix) require_value "$1" "${2:-}"; VENEKO_HOME="$2"; shift ;;
    --bin-dir) require_value "$1" "${2:-}"; BIN_DIR="$2"; shift ;;
    --no-python) WITH_PYTHON=0 ;;
    --no-ffmpeg) WITH_FFMPEG=0 ;;
    --no-path) UPDATE_PATH=0 ;;
    --verbose) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

APP_DIR="$VENEKO_HOME/app"
STAGE_DIR="$VENEKO_HOME/.stage"
BACKUP_DIR="$VENEKO_HOME/.previous"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi

CURRENT_STEP=0
CURRENT_TASK="starting up"

step() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  CURRENT_TASK="$1"
  printf '%s[%d/%d]%s %s\n' "$CYAN$BOLD" "$CURRENT_STEP" "$TOTAL_STEPS" "$RESET" "$1"
}

info()  { printf '      %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()    { printf '      %s✔%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '      %s○%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail()  { printf '\n%s✖ %s%s\n' "$RED$BOLD" "$1" "$RESET" >&2; }

banner() {
  printf '\n%s' "$CYAN$BOLD"
  cat <<'ART'
  ██╗   ██╗███████╗███╗   ██╗███████╗██╗  ██╗ ██████╗
  ██║   ██║██╔════╝████╗  ██║██╔════╝██║ ██╔╝██╔═══██╗
  ██║   ██║█████╗  ██╔██╗ ██║█████╗  █████╔╝ ██║   ██║
  ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║██╔══╝  ██╔═██╗ ██║   ██║
   ╚████╔╝ ███████╗██║ ╚████║███████╗██║  ██╗╚██████╔╝
    ╚═══╝  ╚══════╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝
ART
  printf '%s  installer for macOS and Linux%s\n\n' "$RESET$DIM" "$RESET"
}

# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------

LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/veneko-install-XXXXXX.log")"
WORK_DIR=""

cleanup() {
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
  rm -rf "$STAGE_DIR" 2>/dev/null || true
}

# Puts back the previous install when the swap already happened but a later
# step blew up. Better a working old version than a half-replaced one.
restore_backup() {
  if [ -d "$BACKUP_DIR" ] && [ ! -d "$APP_DIR" ]; then
    mv "$BACKUP_DIR" "$APP_DIR" 2>/dev/null || true
    warn "Restored the previous installation."
  fi
}

on_error() {
  local exit_code=$?
  local line=$1

  fail "Installation failed while: $CURRENT_TASK"
  printf '%s  (line %s, exit code %s)%s\n\n' "$DIM" "$line" "$exit_code" "$RESET" >&2

  if [ -s "$LOG_FILE" ]; then
    printf '%sLast lines of the command output:%s\n' "$BOLD" "$RESET" >&2
    tail -n 25 "$LOG_FILE" | sed 's/^/  /' >&2
    printf '\n%sFull log: %s%s\n' "$DIM" "$LOG_FILE" "$RESET" >&2
  fi

  printf '\n%sIf this looks like a bug, open an issue with the log attached:%s\n' "$DIM" "$RESET" >&2
  printf '%s  %s/issues%s\n\n' "$DIM" "$REPO_URL" "$RESET" >&2

  restore_backup
  cleanup
  exit "$exit_code"
}

trap 'on_error $LINENO' ERR
trap 'printf "\n%sInterrupted.%s\n" "$YELLOW" "$RESET"; restore_backup; cleanup; exit 130' INT TERM

# Runs a command, hiding its output unless --verbose or a failure happens.
run() {
  if [ "$VERBOSE" -eq 1 ]; then
    "$@" 2>&1 | tee -a "$LOG_FILE"
    return "${PIPESTATUS[0]}"
  fi
  "$@" >>"$LOG_FILE" 2>&1
}

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

# `curl … | bash` hands the script itself to stdin, so a plain `read` would eat
# the script. /dev/tty is the terminal the user is actually sitting at.
ask_yes_no() {
  local question="$1"
  local default_answer="${2:-y}"

  if [ "$ASSUME_YES" -eq 1 ] || [ ! -r /dev/tty ]; then
    [ "$default_answer" = "y" ]
    return
  fi

  local hint="[Y/n]"
  [ "$default_answer" = "n" ] && hint="[y/N]"

  local reply=""
  printf '      %s %s ' "$question" "$DIM$hint$RESET" > /dev/tty
  read -r reply < /dev/tty || reply=""
  reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"

  [ -z "$reply" ] && reply="$default_answer"
  [ "$reply" = "y" ] || [ "$reply" = "yes" ]
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 1. Environment
# ---------------------------------------------------------------------------

check_environment() {
  step "Checking this machine"

  local os
  os="$(uname -s)"
  case "$os" in
    Darwin) info "macOS $(sw_vers -productVersion 2>/dev/null || echo '') $(uname -m)" ;;
    Linux)  info "Linux $(uname -m)" ;;
    *)
      fail "Unsupported operating system: $os"
      printf '  This installer covers macOS and Linux. On Windows use install.ps1:\n' >&2
      printf '    irm https://raw.githubusercontent.com/%s/%s/main/scripts/install.ps1 | iex\n\n' \
        "$REPO_OWNER" "$REPO_NAME" >&2
      exit 1
      ;;
  esac

  for tool in tar; do
    if ! have "$tool"; then
      fail "\`$tool\` is required but was not found."
      exit 1
    fi
  done

  if ! have curl && ! have wget; then
    fail "Either curl or wget is required to download veneko."
    exit 1
  fi

  if ! have node; then
    fail "Node.js is not installed."
    printf '  veneko runs on Node.js %s or newer. Install it with:\n\n' "$MIN_NODE_MAJOR" >&2
    if [ "$(uname -s)" = "Darwin" ]; then
      printf '    brew install node          %s(or download it from https://nodejs.org)%s\n\n' "$DIM" "$RESET" >&2
    else
      printf '    sudo apt install nodejs npm    %s(Debian/Ubuntu)%s\n' "$DIM" "$RESET" >&2
      printf '    sudo dnf install nodejs        %s(Fedora)%s\n' "$DIM" "$RESET" >&2
      printf '    sudo pacman -S nodejs npm      %s(Arch)%s\n\n' "$DIM" "$RESET" >&2
    fi
    exit 1
  fi

  local node_version node_major
  node_version="$(node -v)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"

  if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node.js $node_version is too old — veneko needs $MIN_NODE_MAJOR or newer."
    printf '  Upgrade Node.js and run this installer again.\n\n' >&2
    exit 1
  fi
  ok "Node.js $node_version"

  if ! have npm; then
    fail "npm is not installed, but it ships with Node.js."
    printf '  Reinstall Node.js from https://nodejs.org and try again.\n\n' >&2
    exit 1
  fi
  ok "npm $(npm -v)"
}

# ---------------------------------------------------------------------------
# 2. Which version
# ---------------------------------------------------------------------------

fetch_url() {
  if have curl; then
    curl -fsSL "$1"
  else
    wget -qO- "$1"
  fi
}

download_to() {
  if have curl; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
  else
    wget -q --tries=3 -O "$2" "$1"
  fi
}

RESOLVED_TAG=""
TARBALL_URL=""

resolve_version() {
  step "Resolving the version to install"

  if [ -n "$REQUESTED_VERSION" ]; then
    RESOLVED_TAG="$REQUESTED_VERSION"
    TARBALL_URL="$REPO_URL/archive/refs/tags/$RESOLVED_TAG.tar.gz"
    ok "Requested release $RESOLVED_TAG"
    return
  fi

  local payload=""
  payload="$(fetch_url "$API_URL" 2>/dev/null || true)"

  RESOLVED_TAG="$(printf '%s' "$payload" \
    | grep -m1 '"tag_name"' \
    | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)"

  if [ -n "$RESOLVED_TAG" ]; then
    TARBALL_URL="$REPO_URL/archive/refs/tags/$RESOLVED_TAG.tar.gz"
    ok "Latest release: $RESOLVED_TAG"
    return
  fi

  # No release yet. Fall back to the default branch — but ask GitHub which one
  # that is instead of assuming `main`, and treat an unreachable repository as
  # a hard error: downloading a 404 page and calling it a source tree is worse
  # than stopping here with an explanation.
  local repo_info default_branch
  repo_info="$(fetch_url "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME" 2>/dev/null || true)"

  default_branch="$(printf '%s' "$repo_info" \
    | grep -m1 '"default_branch"' \
    | sed -E 's/.*"default_branch"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)"

  if [ -z "$default_branch" ]; then
    fail "GitHub does not return anything for $REPO_OWNER/$REPO_NAME."
    printf '  The most likely reasons are:\n\n' >&2
    printf '    • the repository is private — a public repository is required for\n' >&2
    printf '      this installer, since it downloads without any credentials\n' >&2
    printf '    • GitHub rate-limited this IP address (try again in a few minutes)\n' >&2
    printf '    • you are offline\n\n' >&2
    printf '  Check it here: %s\n\n' "$REPO_URL" >&2
    exit 1
  fi

  RESOLVED_TAG="$default_branch"
  TARBALL_URL="$REPO_URL/archive/refs/heads/$default_branch.tar.gz"
  warn "No published release found — installing from the '$default_branch' branch instead."
}

# ---------------------------------------------------------------------------
# 3. Download
# ---------------------------------------------------------------------------

download_source() {
  step "Downloading veneko $RESOLVED_TAG"

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/veneko-XXXXXX")"
  local archive="$WORK_DIR/source.tar.gz"

  if ! download_to "$TARBALL_URL" "$archive"; then
    fail "Could not download $TARBALL_URL"
    printf '  Check your internet connection, or that the tag exists:\n    %s/releases\n\n' "$REPO_URL" >&2
    exit 1
  fi

  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  # --strip-components drops the `veneko-cli-<tag>/` wrapper GitHub adds.
  run tar -xzf "$archive" -C "$STAGE_DIR" --strip-components=1

  if [ ! -f "$STAGE_DIR/package.json" ]; then
    fail "The downloaded archive does not look like veneko-cli."
    exit 1
  fi

  ok "Source extracted ($(du -sh "$STAGE_DIR" 2>/dev/null | cut -f1 || echo '?'))"
}

# ---------------------------------------------------------------------------
# 4. JavaScript dependencies and build
# ---------------------------------------------------------------------------

build_app() {
  step "Installing JavaScript dependencies"
  info "npm is downloading packages — this takes a minute the first time."

  # `npm ci` is reproducible but refuses to run when the lockfile drifted from
  # package.json, which is exactly when a plain install is the right answer.
  if [ -f "$STAGE_DIR/package-lock.json" ]; then
    if ! (cd "$STAGE_DIR" && run npm ci --no-audit --no-fund); then
      warn "npm ci failed; retrying with npm install."
      (cd "$STAGE_DIR" && run npm install --no-audit --no-fund)
    fi
  else
    (cd "$STAGE_DIR" && run npm install --no-audit --no-fund)
  fi
  ok "Dependencies installed"

  step "Building veneko"
  (cd "$STAGE_DIR" && run npm run build)

  if [ ! -f "$STAGE_DIR/dist/index.js" ]; then
    fail "The build finished but dist/index.js is missing."
    exit 1
  fi

  # Build tools are dead weight once dist/ exists; dropping them saves ~150 MB.
  (cd "$STAGE_DIR" && run npm prune --omit=dev) || warn "Could not prune build dependencies (harmless)."
  ok "Built $RESOLVED_TAG"
}

# ---------------------------------------------------------------------------
# 5. Install
# ---------------------------------------------------------------------------

install_app() {
  step "Installing to $VENEKO_HOME"

  mkdir -p "$VENEKO_HOME" "$BIN_DIR"
  rm -rf "$BACKUP_DIR"

  if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "$BACKUP_DIR"
  fi

  mv "$STAGE_DIR" "$APP_DIR"
  rm -rf "$BACKUP_DIR"
  ok "Files in place at $APP_DIR"

  # The launcher resolves Node at run time so a later nvm/brew upgrade does not
  # break it, and falls back to the interpreter used during the install.
  local node_bin
  node_bin="$(command -v node)"

  cat > "$BIN_DIR/veneko" <<EOF
#!/bin/sh
# Generated by the veneko-cli installer. Do not edit; reinstalling overwrites it.
APP_DIR="$APP_DIR"

if command -v node >/dev/null 2>&1; then
  exec node "\$APP_DIR/dist/index.js" "\$@"
fi

if [ -x "$node_bin" ]; then
  exec "$node_bin" "\$APP_DIR/dist/index.js" "\$@"
fi

echo "veneko: Node.js was not found on PATH. Install Node.js $MIN_NODE_MAJOR+ and try again." >&2
exit 1
EOF

  chmod +x "$BIN_DIR/veneko"
  ok "Launcher written to $BIN_DIR/veneko"
}

# ---------------------------------------------------------------------------
# 6. PATH
# ---------------------------------------------------------------------------

PATH_UPDATED=""

add_to_path() {
  step "Making \`veneko\` available on your PATH"

  case ":$PATH:" in
    *":$BIN_DIR:"*)
      ok "$BIN_DIR is already on your PATH"
      return
      ;;
  esac

  if [ "$UPDATE_PATH" -eq 0 ]; then
    warn "Skipped (--no-path). Add this to your shell config yourself:"
    info "export PATH=\"$BIN_DIR:\$PATH\""
    return
  fi

  local shell_name rc_file
  shell_name="$(basename "${SHELL:-/bin/sh}")"

  case "$shell_name" in
    zsh)  rc_file="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      # macOS Terminal starts login shells, which read .bash_profile, not .bashrc.
      if [ "$(uname -s)" = "Darwin" ] && [ -f "$HOME/.bash_profile" ]; then
        rc_file="$HOME/.bash_profile"
      else
        rc_file="$HOME/.bashrc"
      fi
      ;;
    fish) rc_file="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
    *)    rc_file="$HOME/.profile" ;;
  esac

  mkdir -p "$(dirname "$rc_file")"
  touch "$rc_file"

  if grep -q "veneko-cli installer" "$rc_file" 2>/dev/null; then
    ok "Your $shell_name configuration already sets it up"
    PATH_UPDATED="$rc_file"
    return
  fi

  if [ "$shell_name" = "fish" ]; then
    {
      printf '\n# added by the veneko-cli installer\n'
      printf 'if test -d "%s"\n    fish_add_path "%s"\nend\n' "$BIN_DIR" "$BIN_DIR"
    } >> "$rc_file"
  else
    {
      printf '\n# added by the veneko-cli installer\n'
      printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
    } >> "$rc_file"
  fi

  PATH_UPDATED="$rc_file"
  ok "Added $BIN_DIR to $rc_file"

  export PATH="$BIN_DIR:$PATH"
}

# ---------------------------------------------------------------------------
# 7. Optional tools
# ---------------------------------------------------------------------------

PYTHON_BIN=""

find_python() {
  for candidate in python3 python; do
    if have "$candidate"; then
      local version major minor
      version="$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
      [ -z "$version" ] && continue
      major="${version%%.*}"
      minor="${version##*.}"
      if [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 10 ]; }; then
        PYTHON_BIN="$candidate"
        return 0
      fi
    fi
  done
  return 1
}

# Installs into an isolated pipx environment. A plain `pip install` is refused
# outright by Homebrew and Debian Pythons (PEP 668), and forcing past that is
# how people break their system Python.
pipx_install() {
  local package="$1"
  local label="$2"

  if run pipx install "$package"; then
    ok "$label installed"
    return 0
  fi

  if run pipx upgrade "${package%%\[*}"; then
    ok "$label is already installed and up to date"
    return 0
  fi

  warn "Could not install $label automatically."
  info "Try it by hand: pipx install '$package'"
  return 1
}

install_python_tools() {
  step "Setting up the optional Python tools"

  if [ "$WITH_PYTHON" -eq 0 ]; then
    warn "Skipped (--no-python). Document conversion and downloads will not work until you install them."
    return
  fi

  if ! find_python; then
    warn "No Python 3.10+ found — skipping markitdown and yt-dlp."
    info "They power the document and download tools. Install Python, then run: veneko doctor"
    return
  fi
  ok "Python $("$PYTHON_BIN" -c 'import platform; print(platform.python_version())') found"

  if ! have pipx; then
    if ! ask_yes_no "pipx is missing. Install it (isolated, user-level)?" "y"; then
      warn "Skipped. Install the tools yourself with: pipx install 'markitdown[all]' yt-dlp"
      return
    fi

    info "Installing pipx..."
    if ! run "$PYTHON_BIN" -m pip install --user pipx; then
      warn "Could not install pipx."
      info "Install it with your package manager, then run this installer again:"
      if [ "$(uname -s)" = "Darwin" ]; then
        info "  brew install pipx"
      else
        info "  sudo apt install pipx     # or: sudo dnf install pipx"
      fi
      return
    fi

    run "$PYTHON_BIN" -m pipx ensurepath || true
    # pipx puts its shims in ~/.local/bin, which this install already adds.
    export PATH="$HOME/.local/bin:$PATH"
    hash -r 2>/dev/null || true

    if ! have pipx; then
      warn "pipx was installed but is not on PATH yet. Open a new terminal and run: veneko doctor"
      return
    fi
    ok "pipx installed"
  fi

  info "Installing markitdown (document to Markdown conversion)..."
  pipx_install "markitdown[all]" "markitdown" || true

  info "Installing yt-dlp (video and audio downloads)..."
  pipx_install "yt-dlp" "yt-dlp" || true
}

install_ffmpeg() {
  step "Checking ffmpeg"

  if have ffmpeg; then
    ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -n1 | cut -d' ' -f3)"
    return
  fi

  if [ "$WITH_FFMPEG" -eq 0 ]; then
    warn "ffmpeg is missing (--no-ffmpeg). Audio extraction and high-quality video will not work."
    return
  fi

  # Homebrew never needs sudo, so it can be run unattended. Everything else
  # would require a password, which a piped installer must not ask for.
  if [ "$(uname -s)" = "Darwin" ] && have brew; then
    if ask_yes_no "ffmpeg is missing. Install it with Homebrew?" "y"; then
      info "Installing ffmpeg..."
      if run brew install ffmpeg; then
        ok "ffmpeg installed"
      else
        warn "Homebrew could not install ffmpeg. Run: brew install ffmpeg"
      fi
      return
    fi
  fi

  warn "ffmpeg is not installed — yt-dlp needs it for audio and merged video."
  if [ "$(uname -s)" = "Darwin" ]; then
    info "Install it with: brew install ffmpeg"
  elif have apt; then
    info "Install it with: sudo apt install ffmpeg"
  elif have dnf; then
    info "Install it with: sudo dnf install ffmpeg"
  elif have pacman; then
    info "Install it with: sudo pacman -S ffmpeg"
  else
    info "Install ffmpeg with your distribution's package manager."
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

summary() {
  local installed_version
  installed_version="$(node -e "process.stdout.write(require('$APP_DIR/package.json').version)" 2>/dev/null || echo "$RESOLVED_TAG")"

  printf '\n%s✔ veneko %s is installed.%s\n\n' "$GREEN$BOLD" "$installed_version" "$RESET"
  printf '  %sInstalled to%s  %s\n' "$DIM" "$RESET" "$APP_DIR"
  printf '  %sLauncher%s      %s\n' "$DIM" "$RESET" "$BIN_DIR/veneko"
  printf '  %sConfig%s        %s\n\n' "$DIM" "$RESET" "$HOME/.veneko/config.json"

  if [ -n "$PATH_UPDATED" ]; then
    printf '  %sYour PATH was updated in %s.%s\n' "$YELLOW" "$PATH_UPDATED" "$RESET"
    printf '  %sOpen a new terminal, or run:%s  source "%s"\n\n' "$YELLOW" "$RESET" "$PATH_UPDATED"
  fi

  printf '  %sNext steps%s\n' "$BOLD" "$RESET"
  printf '    veneko            %s open the interactive menu%s\n' "$DIM" "$RESET"
  printf '    veneko doctor     %s confirm everything is wired up%s\n' "$DIM" "$RESET"
  printf '    veneko config     %s add an AI provider API key%s\n' "$DIM" "$RESET"
  printf '    veneko update     %s upgrade to a newer release%s\n\n' "$DIM" "$RESET"
  printf '  %s%s%s\n\n' "$DIM" "$REPO_URL" "$RESET"
}

# ---------------------------------------------------------------------------

main() {
  banner
  check_environment
  resolve_version
  download_source
  build_app
  install_app
  add_to_path
  install_python_tools
  install_ffmpeg
  cleanup
  summary
}

main "$@"
