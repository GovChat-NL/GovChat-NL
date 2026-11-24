import importlib.util
import json
import pathlib

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_upload_overlay_does_not_replace_shared_parser():
    base = yaml.safe_load((ROOT / 'docker-compose.yml').read_text())
    overlay = yaml.safe_load((ROOT / 'docker-compose.tika-upload.yml').read_text())
    assert base['services']['tika']['container_name'] == 'librechat-tika'
    assert 'tika' not in overlay['services']
    parser = overlay['services']['upload-tika']
    assert parser['container_name'] == 'govchat-upload-tika'
    assert parser['environment']['JAVA_TOOL_OPTIONS'].split()[1] == '-Xmx512m'
    assert parser['mem_limit'] == parser['memswap_limit'] == '1536m'
    assert parser['read_only'] is True and parser['cap_drop'] == ['ALL']
    assert 'ports' not in parser
    extractor = overlay['services']['document-extractor']
    assert extractor['environment']['JWT_SECRET'].startswith('${JWT_SECRET:')
    assert extractor['depends_on'] == ['upload-tika']
    assert set(extractor['networks']) == {'parser', 'librechat-net'}
    assert overlay['networks']['parser']['internal'] is True
    assert 'NODE_OPTIONS' not in overlay['services']['librechat']['environment']


def test_render_is_idempotent_and_preserves_policies_media_and_lower_limits():
    spec = importlib.util.spec_from_file_location('renderer', ROOT / 'scripts/render-document-processing-config.py')
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    source = {'endpoints': {'custom': [{'name': 'govchat-orchestrator'}]},
              'filters': {'messages': {'pii': {'action': 'audit'}}},
              'fileConfig': {'fileTokenLimit': 1000, 'endpoints': {
                  'default': {'fileSizeLimit': 6}, 'unrelated': {'disabled': True}}}}
    routes = json.loads((ROOT / 'services/document-extractor/routes.json').read_text())
    result = renderer.document_config(source, routes)
    assert result['filters'] == source['filters']
    assert result['fileConfig']['fileTokenLimit'] == 1000
    assert result['fileConfig']['endpoints']['govchat-orchestrator']['fileSizeLimit'] == 6
    assert result['fileConfig']['endpoints']['unrelated'] == {'disabled': True}
    assert 'govchat-orchestrator' not in source['fileConfig']['endpoints']
    assert renderer.document_config(result, routes) == result


def test_installed_contracts_use_owned_configuration_and_installed_dependencies():
    compose = yaml.safe_load((ROOT / 'tests/document-processing/compose.yml').read_text())
    services = compose['services']
    configuration = services['configuration']
    checks = services['installed-contracts']
    assert configuration['network_mode'] == checks['network_mode'] == 'none'
    assert configuration['volumes'] == ['../..:/source:ro', 'configuration:/configuration']
    assert checks['environment']['NODE_PATH'] == '/app/node_modules'
    assert checks['environment']['CANDIDATE_CONFIG_PATH'] == '/configuration/librechat.generated.yaml'
    assert checks['depends_on']['configuration']['condition'] == 'service_completed_successfully'
    assert 'configuration:/configuration:ro' in checks['volumes']
    assert '../../librechat.yaml:/before.yaml:ro' in checks['volumes']
    command = checks['command'][0]
    for script in ['live-config.test.cjs', 'fallback-quality.test.cjs',
                   'tika-upload-guard.test.cjs', 'document-context.test.js']:
        assert script in command
    assert command.count('&&') == 3
    assert 'env_file' not in configuration and 'env_file' not in checks
    assert 'ports' not in configuration and 'ports' not in checks


def test_retained_local_app_is_separate_and_persists_its_own_data():
    compose = yaml.safe_load((ROOT / 'docker-compose.tika-local-app.yml').read_text())
    assert compose['name'] == 'govchat-tika-local-app'
    services = compose['services']
    assert set(services) == {'app', 'mongo', 'extractor', 'upload-tika'}
    assert services['app']['ports'] == ['127.0.0.1:${TIKA_LOCAL_PORT:-3099}:3080']
    assert services['mongo']['volumes'] == ['mongo-data:/data/db', 'mongo-config:/data/configdb']
    assert 'uploads:/app/uploads' in services['app']['volumes']
    assert set(compose['volumes']) == {'mongo-data', 'mongo-config', 'uploads', 'images'}
    assert services['app']['environment']['GOVCHAT_TIKA_UPLOAD_ENABLED'] == 'true'
    assert services['app']['environment']['RAG_API_URL'] == 'http://govchat-upload-extractor:8000'
    assert services['app']['environment']['JWT_SECRET'] == services['extractor']['environment']['JWT_SECRET']
    assert compose['networks']['existing-bridge']['external'] is True
    assert compose['networks']['parser']['internal'] is True
    assert compose['networks']['app-data']['internal'] is True
    assert 'existing-bridge' in services['app']['networks']
    for service in ['mongo', 'upload-tika', 'extractor']:
        assert 'existing-bridge' not in services[service]['networks']
        assert 'ports' not in services[service]
    assert services['upload-tika']['mem_limit'] == services['upload-tika']['memswap_limit'] == '1536m'
    assert services['extractor']['mem_limit'] == services['extractor']['memswap_limit'] == '384m'


def test_local_initializer_refuses_unapproved_credentials_and_retained_output(tmp_path, monkeypatch):
    import pytest

    spec = importlib.util.spec_from_file_location('local_initializer', ROOT / 'scripts/prepare-tika-local-app.py')
    initializer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(initializer)
    output = tmp_path / 'owned-app'
    monkeypatch.setattr(initializer, 'OUTPUT', output)
    with pytest.raises(ValueError):
        initializer.initialize('bridge', 3099, False)
    assert not output.exists()
    output.mkdir()
    sentinel = output / 'runtime.env'
    sentinel.write_text('existing-owned-key')
    with pytest.raises(RuntimeError):
        initializer.initialize('bridge', 3099, True)
    assert sentinel.read_text() == 'existing-owned-key'


def test_contract_image_excludes_local_credentials_and_browser_runtime():
    rules = (ROOT / 'tests/document-processing/Dockerfile.dockerignore').read_text().splitlines()
    for pattern in ['.git', '.tika-upload-local', '.docling-local', '**/.env', '**/.env.*']:
        assert pattern in rules


def test_local_vision_recovery_refuses_unverified_alias_before_reading_runtime():
    import pytest

    spec = importlib.util.spec_from_file_location('vision_recovery', ROOT / 'scripts/fix-tika-local-vision-model.py')
    recovery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recovery)
    with pytest.raises(ValueError):
        recovery.run('unused', 'unused', 'unverified-model', True)


def test_local_vision_recovery_checks_mount_and_resource_identity():
    import copy
    import pytest

    spec = importlib.util.spec_from_file_location('vision_contract', ROOT / 'scripts/fix-tika-local-vision-model.py')
    recovery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recovery)
    service = {'image': 'synthetic-pinned-image', 'volumes': [{'type': 'volume',
        'source': 'owned', 'target': '/data'}], 'networks': {'private': {}},
        'mem_limit': 1024, 'memswap_limit': 1024, 'cpus': 1, 'pids_limit': 64,
        'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true']}
    configuration = {'volumes': {'owned': {'name': 'owned-existing-data'}},
                     'networks': {'private': {'name': 'owned-existing-network'}}}
    live = {'Config': {'Image': 'synthetic-pinned-image'},
        'Mounts': [{'Type': 'volume', 'Destination': '/data', 'Name': 'owned-existing-data', 'RW': True}],
        'NetworkSettings': {'Networks': {'owned-existing-network': {}}},
        'HostConfig': {'Memory': 1024, 'MemorySwap': 1024, 'NanoCpus': 1000000000,
            'PidsLimit': 64, 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
            'SecurityOpt': ['no-new-privileges:true'], 'PortBindings': {}}}
    recovery.verify_runtime(service, configuration, live)
    for field, changed in [('Memory', 2048), ('MemorySwap', 2048), ('PidsLimit', 128), ('ReadonlyRootfs', False)]:
        altered = copy.deepcopy(live)
        altered['HostConfig'][field] = changed
        with pytest.raises(RuntimeError):
            recovery.verify_runtime(service, configuration, altered)
    altered = copy.deepcopy(live)
    altered['Mounts'][0]['Name'] = 'other-data'
    with pytest.raises(RuntimeError):
        recovery.verify_runtime(service, configuration, altered)
