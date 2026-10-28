#!/bin/sh
# Configure the alpha agent's GitHub credential, idempotently.
#
# Preferred: a fine-grained personal access token with Contents and Pull requests write. Pass it
# as GH_TOKEN; the script writes the AGENT_GH_TOKEN environment secret. The deploy workflow puts
# it in the Coolify application, and Autobot uses it to push and open the pull request.
#
# Without GH_TOKEN: an account SSH key is generated and added only when no key with TITLE exists;
# the private key (base64) goes into AGENT_GIT_SSH_KEY_B64. This makes git push work, but the
# panel can only return the compare link because the GitHub API needs a token. The account key is
# broader than a deploy key (it can push to any repository the account can write); revoke it with
# the printed command when it is no longer needed.
#
# Running this again changes nothing while either secret exists. To rotate, delete the secret
# (and the account key) first.
#
#   GH_TOKEN=github_pat_... ./scripts/setup-alpha-git.sh
#   ./scripts/setup-alpha-git.sh
set -eu

REPO="${REPO:-WCKDai/platform}"
ENV="${ENV:-infra}"
TITLE="${TITLE:-autobot-alpha}"
ROTATE=0
[ "${1:-}" = "--rotate" ] && ROTATE=1

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing $1" >&2; exit 1; }
}
need gh

secrets="$(gh secret list -R "$REPO" --env "$ENV" 2>/dev/null || true)"

if [ -n "${GH_TOKEN:-}" ]; then
  printf 'AGENT_GH_TOKEN=%s\n' "$GH_TOKEN" | gh secret set -R "$REPO" --env "$ENV" -f -
  # A token supersedes the SSH fallback: retire it (and its account key) so there is one
  # credential, not two.
  if printf '%s\n' "$secrets" | grep -q '^AGENT_GIT_SSH_KEY_B64'; then
    gh secret delete AGENT_GIT_SSH_KEY_B64 -R "$REPO" --env "$ENV" >/dev/null 2>&1 || true
    old_id="$(gh api user/keys --jq ".[] | select(.title == \"$TITLE\") | .id")"
    if [ -n "$old_id" ]; then
      gh api -X DELETE "user/keys/$old_id" >/dev/null
      echo "removed the fallback account SSH key $old_id"
    fi
  fi
  echo "set AGENT_GH_TOKEN; run the deploy workflow to apply it"
  exit 0
fi
if [ "$ROTATE" = 0 ] && printf '%s\n' "$secrets" | grep -q '^AGENT_GH_TOKEN'; then
  echo "AGENT_GH_TOKEN is already configured; delete it or use --rotate to change it"
  exit 0
fi
if [ "$ROTATE" = 0 ] && printf '%s\n' "$secrets" | grep -q '^AGENT_GIT_SSH_KEY_B64'; then
  echo "AGENT_GIT_SSH_KEY_B64 is already configured; delete it or use --rotate to change it"
  exit 0
fi
if [ "$ROTATE" = 1 ]; then
  gh secret delete AGENT_GIT_SSH_KEY_B64 -R "$REPO" --env "$ENV" >/dev/null 2>&1 || true
  old_id="$(gh api user/keys --jq ".[] | select(.title == \"$TITLE\") | .id")"
  if [ -n "$old_id" ]; then
    gh api -X DELETE "user/keys/$old_id" >/dev/null
    echo "removed old account SSH key $old_id"
  fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
ssh-keygen -q -t ed25519 -N '' -C "$TITLE" -f "$tmp/key"
pub="$(cat "$tmp/key.pub")"
existing="$(gh api user/keys --jq ".[] | select(.title == \"$TITLE\") | .key")"
if [ -n "$existing" ] && [ "$existing" != "$pub" ]; then
  echo "a key titled $TITLE already exists with a different key; remove it first" >&2
  exit 1
fi
if [ -z "$existing" ]; then
  gh api user/keys -f title="$TITLE" -f key="$pub" --jq '{id,title}' >/dev/null
  echo "added account SSH key $TITLE"
fi
key_id="$(gh api user/keys --jq ".[] | select(.title == \"$TITLE\") | .id")"
key_b64="$(base64 < "$tmp/key" | tr -d '\n')"
printf 'AGENT_GIT_SSH_KEY_B64=%s\n' "$key_b64" | gh secret set -R "$REPO" --env "$ENV" -f -
echo "set AGENT_GIT_SSH_KEY_B64; run the deploy workflow to apply it"
echo
echo "This key makes git push work; the panel returns the compare link for the PR."
echo "For a true one-click PR, create a fine-grained token and run this script with GH_TOKEN:"
echo "  https://github.com/settings/personal-access-tokens/new?name=Autobot+alpha&target_name=WCKDai&contents=write&pull_requests=write"
echo
echo "The account key can push to any repository this account can write to. Revoke it with:"
echo "  gh api -X DELETE user/keys/$key_id"
echo "  gh secret delete AGENT_GIT_SSH_KEY_B64 -R $REPO --env $ENV"
