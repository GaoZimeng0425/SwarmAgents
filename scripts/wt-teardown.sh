#!/usr/bin/env bash
#
# wt-teardown.sh — safe cleanup before removing a git worktree.
#
# Removes the node_modules symlinks that wt-setup created so the subsequent
# `git worktree remove` (or the ExitWorktree tool) has nothing left to trip on,
# and warns about state that would need manual attention. It does NOT remove the
# worktree itself — that stays the caller's job.
#
# Usage:
#   pnpm wt:teardown              # clean up the current directory's worktree
#   pnpm wt:teardown <worktree>   # clean up an explicit worktree path

set -euo pipefail

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi
info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()   { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

TARGET="${1:-$PWD}"
[ -d "$TARGET" ] || die "worktree path does not exist: $TARGET"

git -C "$TARGET" rev-parse --git-common-dir >/dev/null 2>&1 \
  || die "not inside a git repository: $TARGET"
COMMON_DIR="$(git -C "$TARGET" rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(cd "$COMMON_DIR/.." && pwd -P)"
WORKTREE_ROOT="$(git -C "$TARGET" rev-parse --show-toplevel)"

if [ "$WORKTREE_ROOT" = "$MAIN_ROOT" ]; then
  die "refusing to run in the main checkout ($MAIN_ROOT) — run this from inside a worktree"
fi

info "${BOLD}wt-teardown${RESET} ${DIM}cleaning${RESET} $WORKTREE_ROOT"

# --- warn about uncommitted / unmerged work so removal isn't a surprise ---
if [ -n "$(git -C "$WORKTREE_ROOT" status --porcelain)" ]; then
  warn "worktree has uncommitted changes — commit or discard before removing it"
fi

# --- remove node_modules symlinks; flag real dirs (an install ran here) ---
removed=0 real_dir_found=0
# A symlink at the worktree root or one level into any workspace dir.
while IFS= read -r -d '' nm; do
  if [ -L "$nm" ]; then
    rm "$nm"
    ok "unlinked ${nm#"$WORKTREE_ROOT"/}"
    removed=$((removed + 1))
  elif [ -d "$nm" ]; then
    warn "real directory (not a symlink): ${nm#"$WORKTREE_ROOT"/} — an install ran here"
    real_dir_found=1
  fi
done < <(
  # -maxdepth 3 covers <root>/node_modules and <root>/<glob>/<pkg>/node_modules.
  find "$WORKTREE_ROOT" -maxdepth 3 -name node_modules \
    \( -type l -o -type d \) -not -path '*/node_modules/*' -print0 2>/dev/null
)

if [ "$real_dir_found" -eq 1 ]; then
  warn "a real node_modules can dangle the main checkout's symlinks on removal."
  warn "if that happens, repair the main checkout with:"
  info "    CI=true pnpm --dir \"$MAIN_ROOT\" install --frozen-lockfile"
fi

info "${GREEN}done${RESET} — removed $removed symlink(s). Now remove the worktree (ExitWorktree, or 'git worktree remove')."
