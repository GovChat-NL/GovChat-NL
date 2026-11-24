"""Operator-approved alias-only correction with exact live-config preservation."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.tika-upload-local' / 'vision-recovery'


def command(args, cwd=None, input=None):
    result = subprocess.run(args, cwd=cwd, input=input, text=True,
                            encoding='utf-8', capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError('local operation failed; private output withheld')
    return result.stdout


def inspect(name):
    return json.loads(command(['docker', 'inspect', name]))[0]


def database_state(postgres):
    query = """SELECT json_build_object(
      'active', (SELECT count(*) FROM execution_entity WHERE status IN ('running','new')),
      'workflow_count', (SELECT count(*) FROM workflow_entity),
      'workflow_digest', (SELECT md5(string_agg(id || ':' || md5(nodes::text) || ':' ||
        md5(connections::text), ',' ORDER BY id)) FROM workflow_entity),
      'credential_count', (SELECT count(*) FROM credentials_entity)
    );"""
    value = command(['docker', 'exec', '-i', postgres, 'sh', '-c',
                     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'], input=query)
    return json.loads(value.strip())


def bind_path(value):
    value = str(value).replace('\\', '/').lower()
    prefix = '/run/desktop/mnt/host/'
    if value.startswith(prefix) and len(value) > len(prefix) + 1:
        value = value[len(prefix):]
        value = value[0] + ':' + value[1:]
    return value.rstrip('/')


def verify_runtime(service, configuration, live):
    failures = []
    host = live['HostConfig']
    if service.get('image') != live['Config']['Image']:
        failures.append('image')
    if service.get('command') is not None and service['command'] != live['Config']['Cmd']:
        failures.append('command')
    expected_targets = {m['target']: m for m in service.get('volumes', [])}
    actual_targets = {m['Destination']: m for m in live['Mounts']}
    if set(expected_targets) != set(actual_targets):
        failures.append('mount-targets')
    else:
        for target, expected in expected_targets.items():
            actual = actual_targets[target]
            if expected['type'] != actual['Type'] or expected.get('read_only', False) == actual['RW']:
                failures.append('mount-mode')
            elif expected['type'] == 'volume':
                name = configuration['volumes'][expected['source']]['name']
                if actual.get('Name') != name:
                    failures.append('volume-identity')
            elif bind_path(expected['source']) != bind_path(actual['Source']):
                failures.append('bind-identity')
    networks = {configuration['networks'][name]['name'] for name in service.get('networks', {})}
    if networks != set(live['NetworkSettings']['Networks']):
        failures.append('networks')
    ports = {}
    for port in service.get('ports', []):
        ports.setdefault(str(port['target']) + '/' + port.get('protocol', 'tcp'), []).append({
            'HostIp': port.get('host_ip', ''), 'HostPort': str(port['published'])})
    if ports != (host.get('PortBindings') or {}):
        failures.append('ports')
    if service.get('mem_limit', 0) != host.get('Memory', 0):
        failures.append('memory')
    if service.get('memswap_limit', 0) != host.get('MemorySwap', 0):
        failures.append('swap')
    if round(float(service.get('cpus', 0)) * 1_000_000_000) != host.get('NanoCpus', 0):
        failures.append('cpu')
    if service.get('pids_limit', 0) != (host.get('PidsLimit') or 0):
        failures.append('process-limit')
    if bool(service.get('read_only')) != bool(host.get('ReadonlyRootfs')):
        failures.append('read-only')
    if sorted(service.get('cap_drop', [])) != sorted(host.get('CapDrop') or []):
        failures.append('capabilities')
    if sorted(service.get('security_opt', [])) != sorted(host.get('SecurityOpt') or []):
        failures.append('security-options')
    if failures:
        raise RuntimeError('runtime drift: ' + ','.join(sorted(set(failures))))


def run(container, postgres, model, apply):
    if model != 'gpt-5.4':
        raise ValueError('only the separately verified local alias is permitted')
    live = inspect(container)
    labels = live['Config']['Labels']
    cwd = Path(labels['com.docker.compose.project.working_dir'])
    if ROOT.parent not in cwd.parents or labels['com.docker.compose.service'] != 'n8n':
        raise ValueError('only the approved local workspace n8n is permitted')
    selected = labels['com.docker.compose.project.config_files'].split(',')
    compose = ['docker', 'compose', '-p', labels['com.docker.compose.project']]
    for path in selected:
        compose += ['-f', path]
    original = json.loads(command(compose + ['config', '--format', 'json'], cwd=cwd))
    verify_runtime(original['services']['n8n'], original, live)
    before = database_state(postgres)
    if before['active']:
        raise RuntimeError('active local executions; no restart permitted')
    # Escape dollar signs so Compose cannot interpolate existing credential values.
    environment = dict(value.split('=', 1) for value in live['Config']['Env'])
    if environment.get('N8N_ORCHESTRATOR_VISION_MODEL') == model:
        print(json.dumps({'already_configured': True, 'restart_performed': False}))
        return
    intended = {**environment, 'N8N_ORCHESTRATOR_VISION_MODEL': model}
    content = yaml.safe_dump({'services': {'n8n': {'environment': {
        key: value.replace('$', '$$') for key, value in intended.items()}}}}, sort_keys=False)
    content = content.replace('environment:\n', 'environment: !override\n', 1)
    OUTPUT.mkdir(exist_ok=True)
    override = OUTPUT / 'local-n8n-vision.override.yml'
    spec = importlib.util.spec_from_file_location('owned_setup', ROOT / 'scripts/prepare-tika-local-app.py')
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)
    if override.exists():
        if override.read_text(encoding='utf-8') != content:
            raise RuntimeError('existing recovery no longer matches live settings; stopping')
    else:
        setup.private_write(override, content)
        setup.private_write(OUTPUT / 'live-before.json', json.dumps(live))
        setup.private_write(OUTPUT / 'database-before.json', json.dumps(before))
    repaired_compose = compose + ['-f', str(override)]
    repaired = json.loads(command(repaired_compose + ['config', '--format', 'json'], cwd=cwd))
    verify_runtime(repaired['services']['n8n'], repaired, live)
    if repaired['services']['n8n']['environment'] != intended:
        raise RuntimeError('environment drift after private override')
    summary = {'prepared': True, 'only_environment_change': 'N8N_ORCHESTRATOR_VISION_MODEL',
               'runtime_contract_preserved': True, 'active_executions': before['active']}
    if not apply:
        print(json.dumps(summary))
        return
    if database_state(postgres)['active']:
        raise RuntimeError('execution started before recovery; stopping')
    other_before = {d['Id']: d['State']['StartedAt'] for d in json.loads(command([
        'docker', 'inspect', *command(['docker', 'ps', '-aq']).splitlines()])) if d['Id'] != live['Id']}
    command(repaired_compose + ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', 'n8n'], cwd=cwd)
    after = inspect(container)
    verify_runtime(repaired['services']['n8n'], repaired, after)
    actual_env = dict(value.split('=', 1) for value in after['Config']['Env'])
    if actual_env != intended or after['Image'] != live['Image']:
        raise RuntimeError('post-recovery image/environment drift')
    after_db = database_state(postgres)
    for key in ['workflow_count', 'workflow_digest', 'credential_count']:
        if after_db[key] != before[key]:
            raise RuntimeError('workflow/credential state changed')
    others = {d['Id']: d['State']['StartedAt'] for d in json.loads(command([
        'docker', 'inspect', *command(['docker', 'ps', '-aq']).splitlines()])) if d['Id'] != after['Id']}
    if others != other_before:
        raise RuntimeError('unrelated container state changed')
    setup.private_write(OUTPUT / 'live-after.json', json.dumps(after))
    summary.update({'applied': True, 'workflow_logic_preserved': True,
                    'credential_count_preserved': True, 'other_containers_preserved': True})
    setup.private_write(OUTPUT / 'summary.json', json.dumps(summary))
    print(json.dumps(summary))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--postgres-container', required=True)
    parser.add_argument('--model', default='gpt-5.4')
    parser.add_argument('--apply-approved-alias-only', action='store_true')
    args = parser.parse_args()
    try:
        run(args.container, args.postgres_container, args.model, args.apply_approved_alias_only)
    except Exception as error:
        print(json.dumps({'repaired': False, 'error_class': type(error).__name__,
                          'fixed_runtime_drift': str(error) if str(error).startswith('runtime drift: ') else None}), file=sys.stderr)
        sys.exit(1)
