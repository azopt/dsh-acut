#!/usr/bin/env bash
# One-shot release for dsh-acut: create the GitHub repo, set topics, push main,
# and publish the npm package.
#
#   GITHUB_TOKEN=ghp_xxx NPM_TOKEN=npm_xxx ./scripts/publish.sh
#
# Tokens are read from the environment and never written to disk.
# The local git config rewrites github.com URLs to a read-only mirror, so every
# network git call here explicitly disables that rewrite.
set -euo pipefail

: "${GITHUB_TOKEN:?set GITHUB_TOKEN (classic PAT with repo scope)}"
: "${NPM_TOKEN:?set NPM_TOKEN (npm Automation token)}"

OWNER="Azopt"
REPO="dsh-acut"
API="https://api.github.com"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

gh_api() { # gh_api METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" \
      "$API$path" -d "$body"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" "$API$path"
  fi
}

echo "==> 1/4 GitHub repo $OWNER/$REPO"
if [ "$(gh_api GET "/repos/$OWNER/$REPO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.full_name?"ok":"missing")}catch{console.log("missing")}})')" = "ok" ]; then
  echo "    already exists"
else
  gh_api POST /user/repos "{\"name\":\"$REPO\",\"description\":\"Screenshot plugin for DeepSeek Harness: region capture, annotation, scrolling capture, pinned preview, agent tool.\",\"homepage\":\"https://github.com/$OWNER/$REPO\",\"private\":false,\"has_issues\":true,\"has_wiki\":false}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.full_name)console.log("    created "+j.html_url);else{console.error("    failed: "+(j.message||s));process.exit(1)}})'
fi

echo "==> 2/4 topics"
gh_api PUT "/repos/$OWNER/$REPO/topics" '{"names":["dsh-plugin","screenshot","screen-capture","deepseek-harness"]}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("    topics: "+(j.names||[j.message]).join(", "))})'

echo "==> 3/4 git push main"
git -c url."https://github.com/".insteadOf= push \
  "https://x-access-token:$GITHUB_TOKEN@github.com/$OWNER/$REPO.git" main

echo "==> 4/4 npm publish"
npm publish --access public --//registry.npmjs.org/:_authToken="$NPM_TOKEN"

echo
echo "done:"
echo "  https://github.com/$OWNER/$REPO"
echo "  https://www.npmjs.com/package/dsh-acut"
