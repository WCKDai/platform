"""Installed-kit regressions; dangerous inputs exist only in disposable directories."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

# Hooks export repository-local variables that override `git -C`. Remove them in
# this test process before creating fixtures; never let fixture writes reach the caller.
for variable in subprocess.check_output(["git", "rev-parse", "--local-env-vars"], text=True).splitlines():
    os.environ.pop(variable, None)

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("eng", ROOT / ".agents/lib/eng.py")
eng = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eng)


class ControlsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="eng-controls-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Controls fixture")
        (self.root / ".gitignore").write_text(".agents/evidence/\n")
        (self.root / "CHANGELOG.md").write_text("1.2.3\n")
        (self.root / "notes.md").write_text("1.2.3\n")
        (self.root / "rollback.md").write_text("Restore previous fixture.\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def guard(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return eng.cmd_guard(SimpleNamespace(root=self.root, all=False))

    def stage(self, content):
        path = self.root / "fixture.txt"
        path.write_text(content)
        self.git("add", "fixture.txt")
        return path

    def test_fixture_isolation_under_git_hook_environment(self):
        head = self.git("rev-parse", "HEAD")
        env = os.environ.copy()
        env.update(GIT_DIR=str(self.root / ".git"), GIT_WORK_TREE=str(self.root),
                   GIT_INDEX_FILE=str(self.root / ".git/index"))
        result = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()),
                                 "ControlsTests.test_guard_reads_index_not_clean_disk"],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertEqual(self.git("config", "user.name"), "Controls fixture")
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_guard_reads_index_not_clean_disk(self):
        # Deliberately fake and assembled so no credential-like literal is committed.
        path = self.stage("ghp_" + "0" * 36)
        path.write_text("clean working tree content\n")
        self.assertEqual(self.guard(), 1)

    def test_guard_reads_index_when_disk_missing_or_symlink(self):
        path = self.stage("ghp_" + "0" * 36)
        path.unlink()
        self.assertEqual(self.guard(), 1)
        path.symlink_to("notes.md")
        self.assertEqual(self.guard(), 1)

    def test_guard_clean_index_ignores_dirty_disk(self):
        path = self.stage("clean staged content\n")
        path.write_text("ghp_" + "0" * 36)
        self.assertEqual(self.guard(), 0)

    def test_guard_index_size_limit(self):
        path = self.stage("x" * (eng.MAX_SCAN_BYTES + 1))
        path.write_text("small\n")
        self.assertEqual(self.guard(), 1)

    def test_guard_index_symlink_does_not_follow_disk(self):
        path = self.root / "fixture.txt"
        path.symlink_to("notes.md")
        self.git("add", "fixture.txt")
        path.unlink()
        path.write_text("ghp_" + "0" * 36)
        self.assertEqual(self.guard(), 0)

    def test_guard_index_read_error_fails_closed(self):
        self.stage("clean\n")
        original = eng.git

        def fail_blob(root, *args, **kwargs):
            if args[0] in ("ls-files", "cat-file"):
                return eng.Res(128, "", "fixture read error", 0)
            return original(root, *args, **kwargs)

        with mock.patch.object(eng, "git", side_effect=fail_blob):
            self.assertNotEqual(self.guard(), 0)

    def test_guard_blob_read_error_fails_closed(self):
        self.stage("clean\n")
        with mock.patch.object(eng.subprocess, "run", side_effect=OSError("fixture blob error")):
            self.assertNotEqual(self.guard(), 0)

    def scanner(self, code=0, raises=False):
        out = self.root / ".agents/evidence/scan"
        out.mkdir(parents=True)
        trees = []
        original_sh = eng.sh

        def run(args, **kwargs):
            if args[0] != "gitleaks":
                return original_sh(args, **kwargs)
            tree = Path(args[2])
            trees.append(tree)
            self.assertTrue((tree / "notes.md").exists())
            self.assertFalse(tree.is_relative_to(self.root / ".agents/evidence"))
            if raises:
                raise RuntimeError("fixture scanner error")
            return eng.Res(code, "", "", 0, timed_out=code == -9)

        with mock.patch.object(eng.shutil, "which", return_value="gitleaks"), \
                mock.patch.object(eng, "tool_version", return_value="fixture"), \
                mock.patch.object(eng, "sh", side_effect=run):
            if raises:
                with self.assertRaises(RuntimeError):
                    eng.run_scanner(self.root, {}, "gitleaks", out)
            else:
                result = eng.run_scanner(self.root, {}, "gitleaks", out)
                self.assertEqual(result["status"], {0: "pass", 1: "findings", -9: "error"}[code])
        self.assertTrue(trees)
        self.assertTrue(all(not tree.exists() for tree in trees))
        self.assertFalse((out / "gitleaks-tree").exists())

    def test_scan_tree_cleanup_success(self):
        self.scanner()

    def test_scan_tree_cleanup_findings(self):
        self.scanner(code=1)

    def test_scan_tree_cleanup_timeout(self):
        self.scanner(code=-9)

    def test_scan_tree_cleanup_exception(self):
        self.scanner(raises=True)

    def record(self):
        snapshot = eng.git_snapshot(self.root)
        return {"schema": eng.EVIDENCE_SCHEMA, "id": "fixture", "finished_at": eng.now_iso(),
                "git": snapshot, "git_before": dict(snapshot), "profile": "full",
                "verdict": {"status": "pass", "exit_code": 0, "required_failures": [], "unverified": []}}

    def write_record(self, record):
        eng.write_evidence(self.root, record, None)

    def release(self, evidence=None):
        args = SimpleNamespace(version="1.2.3", evidence=evidence,
                               notes=self.root / "notes.md", rollback=self.root / "rollback.md",
                               artifact=[self.root / "notes.md"], sbom=None, signature=None,
                               provenance=None, require_sbom=False)
        return eng.release_check_data(self.root, args)["verdict"]

    def test_release_accepts_clean_valid_record_both_paths(self):
        self.write_record(self.record())
        self.assertEqual(self.release(), "pass")
        self.assertEqual(self.release("fixture"), "pass")

    def test_release_rejects_dirty_evidence_after_stash(self):
        (self.root / "notes.md").write_text("1.2.3 dirty tested bytes\n")
        self.write_record(self.record())
        self.git("stash", "push", "-qm", "fixture edits")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.release(), "fail")
        self.assertEqual(self.release("fixture"), "fail")

    def test_release_rejects_dirty_before_clean_after(self):
        record = self.record()
        record["git_before"]["dirty"] = True
        self.write_record(record)
        self.assertEqual(self.release(), "fail")
        self.assertEqual(self.release("fixture"), "fail")

    def test_release_rejects_tampered_hash_both_paths(self):
        self.write_record(self.record())
        path = self.root / ".agents/evidence/fixture.json"
        data = json.loads(path.read_text())
        data["finished_at"] = "tampered"
        path.write_text(json.dumps(data))
        self.assertEqual(self.release(), "fail")
        self.assertEqual(self.release("fixture"), "fail")

    def test_release_rejects_wrong_schema_both_paths(self):
        record = self.record()
        record["schema"] = "wrong"
        self.write_record(record)
        self.assertEqual(self.release("fixture"), "fail")
        self.assertEqual(self.release(), "fail")

    def test_release_rejects_bad_explicit_id(self):
        record = self.record()
        record["sha256"] = eng.hash_obj(record)
        (self.root / ".agents").mkdir(exist_ok=True)
        (self.root / ".agents/outside.json").write_text(json.dumps(record))
        (self.root / ".git/info/exclude").write_text(".agents/outside.json\n")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.release("../outside"), "fail")

    def test_release_rejects_index_path_escape(self):
        record = self.record()
        self.write_record(record)
        path = self.root / ".agents/evidence/index.jsonl"
        entry = json.loads(path.read_text())
        entry["file"] = ".agents/evidence/../outside.json"
        (self.root / ".agents/outside.json").write_text(
            (self.root / ".agents/evidence/fixture.json").read_text())
        (self.root / ".git/info/exclude").write_text(".agents/outside.json\n")
        path.write_text(json.dumps(entry) + "\n")
        self.assertEqual(self.release(), "fail")

    def test_release_rejects_wrong_head_profile_or_verdict(self):
        for field, value in (("profile", "fast"), ("git", {"head": "wrong", "dirty": False}),
                             ("verdict", {"status": "fail", "exit_code": 1})):
            with self.subTest(field=field):
                record = self.record()
                record[field] = value
                self.write_record(record)
                self.assertEqual(self.release("fixture"), "fail")
                self.assertEqual(self.release(), "fail")

    def test_release_rejects_malformed_record(self):
        self.write_record({"id": "fixture", "finished_at": eng.now_iso(), "git": None})
        self.assertEqual(self.release("fixture"), "fail")
        self.assertEqual(self.release(), "fail")

    def test_release_rejects_index_hash_mismatch(self):
        self.write_record(self.record())
        path = self.root / ".agents/evidence/index.jsonl"
        entry = json.loads(path.read_text())
        entry["sha256"] = "0" * 64
        path.write_text(json.dumps(entry) + "\n")
        self.assertEqual(self.release(), "fail")

    def test_yaml_load_rule_positive_and_negative_fixtures(self):
        # Never execute these source fixtures; scan only a disposable directory.
        cases = [
            ("yaml.load(data)", True),
            ("yaml.load(data, Loader=yaml.Loader)", True),
            ("yaml.load(data, Loader=yaml.UnsafeLoader)", True),
            ("yaml.load(data, yaml.Loader)", True),
            ("yaml.load(data, Loader=yaml.FullLoader)", True),
            ("yaml.load(data, Loader=yaml.SafeLoader)", False),
            ("yaml.load(data, yaml.SafeLoader)", False),
            ("yaml.load(data, Loader=yaml.CSafeLoader)", False),
            ("yaml.load(data, yaml.CSafeLoader)", False),
            ("yaml.safe_load(data)", False),
        ]
        expected = set()
        for i, (source, unsafe) in enumerate(cases):
            name = f"case_{i}.py"
            (self.root / name).write_text("import yaml\n" + source + "\n")
            if unsafe:
                expected.add(name)
        res = subprocess.run(["semgrep", "scan", "--config", str(ROOT / ".agents/config/semgrep.yml"),
                              "--json", "--quiet", "--metrics=off", "--disable-version-check",
                              str(self.root)], capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)
        self.assertEqual(data["errors"], [])
        actual = {Path(item["path"]).name for item in data["results"]
                  if item["check_id"].endswith("eng-python-yaml-unsafe-load")}
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
