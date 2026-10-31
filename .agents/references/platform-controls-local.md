# Platform installed-kit hardening

The kit installed by PR #6 came from `wckdboy/agent-engineering` at
`4f33ade`. These are narrow platform-local corrections, not a whole-kit sync; that source revision
also contains the corrected defects. No sibling worktree or uncommitted source was copied.

- Staged guards inspect index blobs/modes/sizes, not potentially different working-tree files;
  unreadable staged content fails closed. Symlinks/submodules are not dereferenced.
- Unsafe `yaml.load` forms are covered, with positional/keyword safe-loader exclusions tested.
- Raw gitleaks scan trees are disposable and excluded from uploadable evidence.
- Release evidence requires schema/hash validation, clean matching before/after HEAD snapshots,
  passing full-profile checks, and no unverified entries. Existing dirty evidence is retained but
  is intentionally ineligible for release; rerun verification on the clean commit.
- The sample checkout does not persist its token. Analysis stays read-only, and RED demonstrations
  must retain the new test in the pre-fix checkout.
- The sample installer provisions the same pinned zizmor as quality CI. No Gitleaks path exemption
  is justified for nonexistent fixtures, so those exemptions are removed rather than expanded.
- Secret scans use a strict index inventory, separate from heuristic source discovery, and include
  every tracked path, including force-added evidence/worktree-named paths. Git itself excludes
  untracked/generated files and nested worktrees. Gitlinks and tracked symlink targets are never traversed. Missing files,
  unexpected file types, symlink parents, index errors and failed copies fail closed rather than
  silently reducing scan coverage. Gitleaks still checks current tracked worktree bytes; the staged
  guard separately checks index blobs. Untracked/generated files are not added to scan coverage.

Run `python3 -B -m unittest discover -s tests -p test_controls.py -v`. Both verification profiles
include these tests; Semgrep and Gitleaks must be installed for isolated positive/negative fixtures.
Fixtures use disposable repositories and deliberately fake, assembled credential shapes only.
Rollback is a reviewed revert of the hardening commit; do not restore known bypasses silently.
