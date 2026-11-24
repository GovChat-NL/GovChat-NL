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
