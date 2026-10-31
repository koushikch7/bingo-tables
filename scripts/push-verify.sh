#!/usr/bin/env bash
# Push the current branch to GitHub and prove the remote tree matches this one byte-for-byte.
#
# Why this exists: writing files through the GitHub Contents API replaces whole files, so
# handing it an excerpt silently truncates the repo. A push that "succeeded" is not proof;
# comparing blob hashes is. Run this instead of trusting any push result.
#
# Usage: scripts/push-verify.sh [branch]

set -euo pipefail

repo_url="ssh://git@github.com/koushikch7/bingo-tables.git"
branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: working tree has uncommitted changes" >&2
  git status --short >&2
  exit 1
fi

local_head=$(git rev-parse HEAD)

echo "== pushing $branch ($local_head) =="
git push "$repo_url" "HEAD:refs/heads/$branch"

echo "== fetching back =="
git fetch --no-tags "$repo_url" "refs/heads/$branch:refs/remotes/origin/$branch"

echo "== comparing trees =="
if ! git diff --quiet "origin/$branch" HEAD; then
  echo "FAIL: remote $branch differs from local HEAD" >&2
  git diff --stat "origin/$branch" HEAD >&2
  exit 1
fi

fail=0
while IFS= read -r file; do
  want=$(git hash-object "$file")
  got=$(git rev-parse -q --verify "origin/$branch:$file" || true)
  if [ "$want" != "$got" ]; then
    printf 'MISMATCH %s (local %s, remote %s)\n' "$file" "$want" "${got:-missing}" >&2
    fail=1
  fi
done < <(git ls-files)

if [ "$fail" -ne 0 ]; then
  echo "FAIL: remote $branch does not match this working tree" >&2
  exit 1
fi

echo "OK: remote $branch matches all $(git ls-files | wc -l) tracked files byte-for-byte"
