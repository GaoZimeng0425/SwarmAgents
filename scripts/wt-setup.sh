#!/usr/bin/env bash
#
# wt-setup.sh — prepare a git worktree for building/testing without a fresh install.
#
# Symlinks every workspace node_modules from the main checkout into the worktree
# at the same relative path, so the worktree shares the main repo's already-installed
# dependencies (no per-worktree `pnpm install`, which is slow and can break the
# app's native-module ABI).
#
# Usage:
#   pnpm wt:setup              # link into the current directory's worktree
#   pnpm wt:setup <worktree>   # link into an explicit worktree path
#
# Idempotent: a correct symlink is skipped, a wrong symlink is replaced, and a
# real node_modules directory (from an accidental install) aborts so nothing is
# silently deleted.

set -euo pipefail

# --- colors (fall back to plain when not a TTY) ---
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; GREEN=''; RED=''; RESET=''
fi
info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
die()   { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# --- resolve the worktree and the main checkout ---
TARGET="${1:-$PWD}"
[ -d "$TARGET" ] || die "worktree path does not exist: $TARGET"

# git-common-dir points at the shared .git; its parent is the main checkout root.
git -C "$TARGET" rev-parse --git-common-dir >/dev/null 2>&1 \
  || die "not inside a git repository: $TARGET"
COMMON_DIR="$(git -C "$TARGET" rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(cd "$COMMON_DIR/.." && pwd -P)"
WORKTREE_ROOT="$(git -C "$TARGET" rev-parse --show-toplevel)"

if [ "$WORKTREE_ROOT" = "$MAIN_ROOT" ]; then
  die "refusing to run in the main checkout ($MAIN_ROOT) — run this from inside a worktree"
fi

info "${BOLD}wt-setup${RESET} ${DIM}linking node_modules from${RESET} $MAIN_ROOT"
info "${DIM}                        into${RESET} $WORKTREE_ROOT"

# --- discover every node_modules to mirror ---
# The root, plus each workspace package (apps/*, packages/*, tools/*) that has a
# real node_modules in the main checkout. Discovered dynamically so new packages
# are covered without editing this script.
rel_dirs=()
[ -d "$MAIN_ROOT/node_modules" ] && rel_dirs+=(".")
for glob in "apps" "packages" "tools"; do
  for pkg in "$MAIN_ROOT/$glob"/*/; do
    [ -d "${pkg}node_modules" ] || continue
    rel_dirs+=("${glob}/$(basename "$pkg")")
  done
done

[ "${#rel_dirs[@]}" -gt 0 ] || die "no node_modules found in $MAIN_ROOT — run 'pnpm install' there first"

linked=0 skipped=0
for rel in "${rel_dirs[@]}"; do
  src="$MAIN_ROOT/$rel/node_modules"
  # Normalize the "." root case so the path reads cleanly.
  if [ "$rel" = "." ]; then
    dest="$WORKTREE_ROOT/node_modules"; label="node_modules"
    src="$MAIN_ROOT/node_modules"
  else
    dest="$WORKTREE_ROOT/$rel/node_modules"; label="$rel/node_modules"
  fi

  if [ -L "$dest" ]; then
    if [ "$(readlink "$dest")" = "$src" ]; then
      skipped=$((skipped + 1)); continue
    fi
    rm "$dest"  # wrong target — replace it
  elif [ -e "$dest" ]; then
    die "$label is a real directory, not a symlink — an install ran here. Remove it manually if intended, then re-run."
  fi

  ln -s "$src" "$dest"
  ok "$label"
  linked=$((linked + 1))
done

info "${GREEN}done${RESET} — linked $linked, skipped $skipped (already correct)"
