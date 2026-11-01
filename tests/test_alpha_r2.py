"""Policy and remote-cache evidence contracts for the shared trusted workflow."""
import ast
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/alpha-r2.yml').read_text()
PROBE = textwrap.dedent(WORKFLOW.split('# BEGIN CACHE PROBE\n')[1].split('# END CACHE PROBE')[0])
tree = ast.parse(PROBE)
helpers = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ('count', 'verify_stats')], type_ignores=[])
scope = {}
exec(compile(helpers, '<cache-probe-helpers>', 'exec'), scope)


class AlphaPolicyTests(unittest.TestCase):
    def test_registration_guidance_matches_the_named_runner(self):
        self.assertIn('[ "$ACTUAL_RUNNER" = alpha ]', WORKFLOW)
        for relative in ('scripts/install-runner.sh', 'docs/runners.md'):
            with self.subTest(path=relative):
                self.assertIn('RUNNER_NAME=alpha', (ROOT / relative).read_text())

    def test_manual_dispatch_is_probe_only(self):
        dispatch = WORKFLOW.split('  workflow_dispatch:\n', 1)[1].split('  workflow_call:\n', 1)[0]
        called = WORKFLOW.split('  workflow_call:\n', 1)[1].split('\npermissions:', 1)[0]
        self.assertNotRegex(dispatch, r'\bcommand:', 'Manual writers must not bypass reviewed build commands')
        self.assertRegex(called, r'\bcommand:', 'Reviewed reusable callers retain build support')

    def test_resource_guards_precede_the_trusted_command(self):
        build_step = WORKFLOW.split('- name: Run the trusted caller build', 1)[1].split('- name: Stop only', 1)[0]
        script = build_step.split('run: |', 1)[1]
        command = 'nice -n 10 bash --noprofile --norc -eo pipefail -c "$BUILD_COMMAND"'
        self.assertIn(command, script)
        guards = (
            '''[ "$(df -Pk . | awk 'NR==2 {print $4}')" -ge 10485760 ]''',
            "awk '{ if ($1 > 24) exit 1 }' /proc/loadavg",
        )
        for guard in guards:
            self.assertIn(guard, script)
            self.assertLess(script.index(guard), script.index(command))

    def test_only_trusted_main_events_reach_alpha(self):
        self.assertIn("github.repository_owner == 'WCKDai' && github.ref == 'refs/heads/main'", WORKFLOW)
        self.assertIn('fromJSON(\'["push","schedule","workflow_dispatch"]\')', WORKFLOW)
        self.assertNotIn('pull_request_target', WORKFLOW)
        self.assertNotRegex(WORKFLOW, re.compile(r'^\s*pull_request:', re.MULTILINE), 'PRs must not request alpha')
        self.assertIn('group: trusted', WORKFLOW)
        self.assertIn('labels: [self-hosted, linux, x64, rust-16, trusted]', WORKFLOW)

    def test_no_checkout_of_arbitrary_refs_or_persistent_credentials(self):
        self.assertIn('ref: ${{ github.sha }}', WORKFLOW)
        self.assertIn('persist-credentials: false', WORKFLOW)
        for action in re.findall(r'uses:\s*(\S+)', WORKFLOW):
            self.assertRegex(action, r'@[0-9a-f]{40}$')
        self.assertNotRegex(WORKFLOW, r'contents:\s*write')
        self.assertNotIn('secrets: inherit', WORKFLOW)
        build_step = WORKFLOW.split('- name: Run the trusted caller build', 1)[1].split('- name: Stop only', 1)[0]
        env_block = build_step.split('env:\n', 1)[1].split('\n        shell:', 1)[0]
        environment = dict(re.findall(r'^          ([A-Z_][A-Z0-9_]*): (.+)$', env_block, re.MULTILINE))
        self.assertEqual(environment.get('BUILD_COMMAND'), '${{ inputs.command }}')
        self.assertNotIn('${{', build_step.split('run: |', 1)[1])

    def test_cache_is_fail_closed_and_job_is_isolated(self):
        self.assertIn('[ "$R2_CONFIGURED" = true ]', WORKFLOW)
        self.assertIn('[ "$SCCACHE_S3_USE_SSL" = true ]', WORKFLOW)
        self.assertIn('AWS_EC2_METADATA_DISABLED', WORKFLOW)
        self.assertIn("env['SCCACHE_SERVER_PORT']", PROBE)
        self.assertIn("str(root / phase)", PROBE)
        self.assertIn("for phase in ('write', 'read')", PROBE)
        self.assertIn("env.SCCACHE_SERVER_PORT != ''", WORKFLOW)
        self.assertIn('sha256sum --check --status', WORKFLOW)


class AssertionCoverageTests(unittest.TestCase):
    def test_added_pull_request_trigger_is_rejected(self):
        changed = WORKFLOW.replace('  workflow_dispatch:\n', '  pull_request:\n  workflow_dispatch:\n', 1)
        self.assertNotEqual(changed, WORKFLOW)
        with mock.patch.dict(globals(), WORKFLOW=changed), self.assertRaises(AssertionError):
            AlphaPolicyTests().test_only_trusted_main_events_reach_alpha()

    def test_build_script_interpolation_is_rejected(self):
        changed = WORKFLOW.replace('-c "$BUILD_COMMAND"', '-c "${{ inputs.command }}"', 1)
        self.assertNotEqual(changed, WORKFLOW)
        with mock.patch.dict(globals(), WORKFLOW=changed), self.assertRaises(AssertionError):
            AlphaPolicyTests().test_no_checkout_of_arbitrary_refs_or_persistent_credentials()

    def test_missing_build_command_environment_is_rejected(self):
        for replacement in ('BUILD_COMMAND: fixed', 'OLD_BUILD_COMMAND: ${{ inputs.command }}'):
            changed = WORKFLOW.replace('BUILD_COMMAND: ${{ inputs.command }}', replacement, 1)
            self.assertNotEqual(changed, WORKFLOW)
            with self.subTest(replacement=replacement), mock.patch.dict(globals(), WORKFLOW=changed), self.assertRaises(AssertionError):
                AlphaPolicyTests().test_no_checkout_of_arbitrary_refs_or_persistent_credentials()


class CacheEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.data = {'cache_location': 'S3', 'stats': {
            'cache_write_errors': 0, 'cache_read_errors': {'counts': {'C/C++': 0}},
            'cache_writes': 1, 'cache_hits': {'counts': {'C/C++': 1}},
        }}

    def test_remote_write_and_hit_are_accepted(self):
        for phase in ('write', 'read'):
            scope['verify_stats'](self.data, phase)

    def test_probe_failure_retains_cleanup_registration(self):
        """Execute the actual probe with compiler/stop faults and no real subprocesses."""
        for failure in ('compiler', 'phase-stop', 'final-stop'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                github_env = root / 'github-env'
                github_env.write_text('')
                registrations = []

                def run(args, **kwargs):
                    operation = args[1]
                    if operation == '--start-server':
                        registrations.append(github_env.read_text())
                    if operation == '--show-stats':
                        return SimpleNamespace(returncode=0, stdout=json.dumps(self.data))
                    if operation == 'gcc' and failure == 'compiler':
                        return SimpleNamespace(returncode=1, stdout='')
                    if operation == '--stop-server':
                        if failure == 'phase-stop' and kwargs['timeout'] == 120:
                            return SimpleNamespace(returncode=1, stdout='')
                        if failure == 'final-stop' and kwargs['timeout'] == 30:
                            raise subprocess.TimeoutExpired(args, 30)
                    return SimpleNamespace(returncode=0, stdout='')

                environment = {'RUNNER_TEMP': str(root), 'GITHUB_ENV': str(github_env),
                               'GITHUB_RUN_ID': '100', 'GITHUB_RUN_ATTEMPT': '1'}
                with mock.patch.dict(os.environ, environment, clear=True), \
                        mock.patch('subprocess.run', side_effect=run), \
                        mock.patch('socket.socket') as socket_factory, mock.patch('builtins.print'):
                    socket_factory.return_value.__enter__.return_value.getsockname.return_value = ('127.0.0.1', 43210)
                    expected_error = subprocess.TimeoutExpired if failure == 'final-stop' else RuntimeError
                    with self.assertRaises(expected_error):
                        exec(compile(PROBE, '<cache-probe-fault-fixture>', 'exec'), {})
                self.assertTrue(registrations)
                for registration in registrations:
                    self.assertIn('SCCACHE_SERVER_PORT=43210\n', registration)
                    self.assertIn('SCCACHE_DIR=', registration)
                self.assertIn('SCCACHE_SERVER_PORT=43210\n', github_env.read_text())

    def test_local_fallback_is_not_remote_proof(self):
        self.data['cache_location'] = '/local/cache'
        with self.assertRaises(RuntimeError):
            scope['verify_stats'](self.data, 'read')

    def test_missing_or_failed_cache_proof_never_passes(self):
        for key in ('cache_writes', 'cache_hits', 'cache_read_errors', 'cache_write_errors'):
            data = copy.deepcopy(self.data)
            data['stats'][key] = 0 if key in ('cache_hits', 'cache_writes') else 1
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                scope['verify_stats'](data, 'write' if key == 'cache_writes' else 'read')
        del self.data['stats']['cache_read_errors']
        with self.assertRaises(KeyError):
            scope['verify_stats'](self.data, 'read')


class CredentialsWorkflowTests(unittest.TestCase):
    """alpha-r2-credentials.yml writes the R2 key on alpha: main, by hand, nothing else."""
    TEXT = (ROOT / '.github/workflows/alpha-r2-credentials.yml').read_text()

    def test_only_a_manual_main_run_reaches_alpha(self):
        text = self.TEXT
        self.assertIn("github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'", text)
        self.assertNotRegex(text, re.compile(r'^\s*(pull_request|pull_request_target|push|workflow_call|schedule):', re.MULTILINE))
        self.assertIn('group: trusted', text)
        self.assertIn('[ "$ACTUAL_RUNNER" = alpha ]', text)

    def test_no_checkout_permissions_or_interpolated_script(self):
        text = self.TEXT
        self.assertIn('permissions: {}', text)
        self.assertNotIn('uses:', text)
        self.assertNotIn('secrets: inherit', text)
        script = text.split('run: |', 1)[1]
        self.assertNotIn('${{', script)
        self.assertIn('umask 077', script)
        self.assertLess(script.index('umask 077'), script.index('printf'))


if __name__ == '__main__':
    unittest.main()
