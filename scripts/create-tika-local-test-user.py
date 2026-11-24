"""Provision one retained local test user via the installed upstream helper."""
import argparse
import importlib.util
import json
from pathlib import Path
import secrets
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.tika-upload-local' / 'app' / 'manual-account.json'


def create(approved):
    if not approved:
        raise ValueError('explicit local test-account creation required')
    if OUTPUT.exists():
        print(json.dumps({'account_already_prepared': True, 'credentials_printed': False}))
        return
    labels = subprocess.run(['docker', 'inspect', '--format', '{{json .Config.Labels}}',
                             'govchat-tika-local-app-app-1'], capture_output=True, check=True)
    assert json.loads(labels.stdout)['com.docker.compose.project'] == 'govchat-tika-local-app'
    identifier = uuid.uuid4().hex
    email = 'tika-local-' + identifier + '@example.invalid'
    password = secrets.token_urlsafe(24) + '!Aa1'
    result = subprocess.run(['docker', 'exec', '-i', 'govchat-tika-local-app-app-1',
                             'node', '/app/config/create-user.js', email, 'Local Tika Tester',
                             'tika-local-' + identifier, '--email-verified=false'],
                            input=password + '\n', capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('upstream local account provisioning failed')
    spec = importlib.util.spec_from_file_location('owned_setup', ROOT / 'scripts/prepare-tika-local-app.py')
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)
    setup.private_write(OUTPUT, json.dumps({'email': email, 'password': password}, indent=2))
    print(json.dumps({'manual_account_prepared': True, 'credentials_printed': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--create', action='store_true')
    args = parser.parse_args()
    try:
        create(args.create)
    except Exception as error:
        print(json.dumps({'prepared': False, 'error_class': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
