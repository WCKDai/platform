#!/usr/bin/env bash
# Audit the control plane: is every configured value actually used, and is it used safely?
#
#   ./scripts/audit-config.sh            # WCKDai/platform
#   ORG=WCKDai REPO=WCKDai/platform ./scripts/audit-config.sh
#
# Read-only. It prints names, never values. Requires `gh` authenticated as an org owner for the
# organisation-level checks; repository-level checks still run without that.
set -uo pipefail

org="${ORG:-WCKDai}"
repo="${REPO:-WCKDai/platform}"
root="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

say() { printf '\n== %s\n' "$1"; }
ok() { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

# Every uppercase token in the desired-state config is a key we claim to own.
keys="$(ruby -e '
  require "yaml"
  doc = YAML.load_file(ARGV[0])
  found = []
  walk = lambda do |v|
    case v
    when Hash then v.each_value { |x| walk.call(x) }
    when Array then v.each { |x| walk.call(x) }
    when String then found.concat(v.scan(/\b[A-Z][A-Z0-9_]{2,}\b/))
    end
  end
  walk.call(doc)
  puts found.uniq.sort
' "$root/config/platform.yaml")"

# Keys a workflow actually reads.
referenced="$(grep -rhoE '(vars|secrets)\.[A-Z][A-Z0-9_]+' "$root/.github/workflows" 2>/dev/null | cut -d. -f2 | sort -u)"

say "configured keys with no consumer"
while read -r k; do
  [ -n "$k" ] || continue
  if ! grep -qx "$k" <<<"$referenced"; then
    warn "$k is in config/platform.yaml but no workflow reads it"
  fi
done <<<"$keys"

say "workflow keys with no entry in config/platform.yaml"
while read -r k; do
  [ -n "$k" ] || continue
  if ! grep -qx "$k" <<<"$keys"; then
    warn "$k is read by a workflow but not declared in config/platform.yaml"
  fi
done <<<"$referenced"

say "secrets that no workflow reads"
for env in infra network agents; do
  while read -r name; do
    [ -n "$name" ] || continue
    if ! grep -qx "$name" <<<"$referenced"; then
      warn "$env/$name is stored but never referenced"
    fi
  done < <(gh secret list -R "$repo" --env "$env" --json name --jq '.[].name' 2>/dev/null)
done

say "environment protection"
for env in infra network agents; do
  json="$(gh api "repos/$repo/environments/$env" 2>/dev/null)" || { bad "$env is missing"; continue; }
  policy="$(jq -r '.deployment_branch_policy.custom_branch_policies // false' <<<"$json")"
  if [ "$policy" = "true" ]; then
    branches="$(gh api "repos/$repo/environments/$env/deployment-branch-policies" --jq '[.branch_policies[].name] | join(",")' 2>/dev/null)"
    ok "$env is branch-restricted to: ${branches:-none}"
  else
    bad "$env has no deployment branch policy; any branch can read its secrets"
  fi
done

say "organisation security"
perm="$(gh api "orgs/$org/actions/permissions" 2>/dev/null)"
[ "$(jq -r '.sha_pinning_required' <<<"$perm")" = "true" ] \
  && ok "organization requires SHA-pinned actions" \
  || bad "organization does not require SHA-pinned actions"
[ "$(jq -r '.allowed_actions' <<<"$perm")" = "selected" ] \
  && ok "organization restricts allowed actions" \
  || warn "organization allows every third-party action"
[ "$(gh api "orgs/$org" --jq '.two_factor_requirement_enabled' 2>/dev/null)" = "true" ] \
  && ok "organization requires 2FA" \
  || warn "organization does not require 2FA"
selected="$(gh api "orgs/$org/actions/variables/R2_CONFIGURED/repositories" --jq '[.repositories[].name] | join(",")' 2>/dev/null)"
[ -n "$selected" ] && warn "R2 organization variables are visible to: $selected"

say "unpinned actions in this repository"
unpinned="$(grep -rhoE 'uses: [^#[:space:]]+@(v[0-9]+|stable|main|master)' "$root/.github/workflows" 2>/dev/null || true)"
if [ -z "$unpinned" ]; then ok "every uses: is pinned by commit"; else while read -r u; do [ -n "$u" ] && bad "$u"; done <<<"$unpinned"; fi

say "runner groups"
gh api "orgs/$org/actions/runner-groups" --jq '.runner_groups[] | "\(.name)\tpublic=\(.allows_public_repositories)\trestricted=\(.restricted_to_workflows)"' 2>/dev/null \
  | while IFS= read -r line; do
      name="${line%%$'\t'*}"
      if grep -q 'public=true' <<<"$line" && ! grep -q 'restricted=true' <<<"$line"; then
        printf '  FAIL  group %s: public repositories allowed without a workflow restriction\n' "$name"
      else
        printf '  ok    group %s\n' "$name"
      fi
    done

say "result"
if [ "$fail" -eq 0 ]; then
  echo "no hard failures (warnings above are unused or over-broad configuration)"
else
  echo "$fail hard failure(s)"
fi
exit "$fail"
