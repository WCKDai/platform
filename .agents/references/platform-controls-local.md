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

Run `python3 -B -m unittest discover -s tests -p test_controls.py -v`. Both verification profiles
include these tests; Semgrep must be installed for their isolated positive/negative rule fixtures.
Fixtures use disposable repositories and deliberately fake, assembled credential shapes only.
Rollback is a reviewed revert of the hardening commit; do not restore known bypasses silently.
