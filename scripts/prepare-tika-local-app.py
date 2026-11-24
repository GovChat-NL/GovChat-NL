"""Initialize an owned local UI; never print credentials or overwrite retained state."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.tika-upload-local' / 'app'


def private_write(path, text):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(text)
    if os.name == 'nt':
        icacls = str(Path(os.environ['SYSTEMROOT']) / 'System32' / 'icacls.exe')
        result = subprocess.run([icacls, str(path), '/inheritance:r', '/grant:r',
                                 os.environ['USERNAME'] + ':(F)'], capture_output=True)
        if result.returncode:
            raise RuntimeError('private file permission setup failed')
    else:
        path.chmod(0o600)


def initialize(bridge_container, port, approved):
    if not approved:
        raise ValueError('explicit approval for existing bridge credentials required')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', bridge_container):
        raise ValueError('invalid container name')
    if not 1024 <= port <= 65535:
        raise ValueError('invalid loopback port')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if any(OUTPUT.iterdir()):
        raise RuntimeError('local app output already exists; keys/config must not be regenerated')
    result = subprocess.run(['docker', 'inspect', bridge_container], capture_output=True, check=True)
    bridge = json.loads(result.stdout)[0]
    if not bridge['State']['Running']:
        raise RuntimeError('existing bridge must be running')
    networks = list(bridge['NetworkSettings']['Networks'])
    if len(networks) != 1:
        raise RuntimeError('ambiguous bridge network requires explicit review')
    environment = dict(item.split('=', 1) for item in bridge['Config']['Env'])
    bearer = environment.get('BEARER_TOKEN', '')
    bridge_port = environment.get('PORT', '3333')
    if not bearer or any(c in bearer for c in "\r\n\x00'\\"):
        raise RuntimeError('bridge credential missing or unsupported dotenv encoding')
    if not bridge_port.isdigit() or not 1 <= int(bridge_port) <= 65535:
        raise RuntimeError('invalid bridge port')
    values = {
        'TIKA_LOCAL_PORT': str(port),
        'TIKA_BRIDGE_NETWORK': networks[0],
        'JWT_SECRET': secrets.token_hex(32),
        'JWT_REFRESH_SECRET': secrets.token_hex(32),
        'CREDS_KEY': secrets.token_hex(32),
        'CREDS_IV': secrets.token_hex(16),
        'SESSION_SECRET': secrets.token_hex(32),
        'N8N_OPENAI_BRIDGE_BEARER_TOKEN': bearer,
    }
    source = yaml.safe_load((ROOT / 'librechat.yaml').read_text(encoding='utf-8'))
    endpoint = next(e for e in source['endpoints']['custom'] if e['name'] == 'govchat-orchestrator')
    endpoint['baseURL'] = f'http://{bridge_container}:{bridge_port}/v1'
    endpoint['titleConvo'] = False
    source['endpoints']['custom'] = [endpoint]
    spec = importlib.util.spec_from_file_location('tika_renderer', ROOT / 'scripts/render-document-processing-config.py')
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    routes = json.loads((ROOT / 'services/document-extractor/routes.json').read_text())
    rendered = renderer.document_config(source, routes)
    private_write(OUTPUT / 'runtime.env', ''.join(f"{name}='{value}'\n" for name, value in values.items()))
    private_write(OUTPUT / 'librechat.generated.yaml', yaml.safe_dump(rendered, allow_unicode=True, sort_keys=False))
    print(json.dumps({'initialized': True, 'loopback_port': port, 'existing_bridge': True,
                      'independent_app_keys': True, 'retained_storage': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bridge-container', required=True)
    parser.add_argument('--port', type=int, default=3099)
    parser.add_argument('--approve-existing-bridge-credentials', action='store_true')
    args = parser.parse_args()
    try:
        initialize(args.bridge_container, args.port, args.approve_existing_bridge_credentials)
    except Exception as error:
        # Docker/configuration errors may carry private data: report only class.
        print(json.dumps({'initialized': False, 'error_class': type(error).__name__}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
