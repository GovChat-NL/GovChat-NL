import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


extractor = module('document_extractor', ROOT / 'services/document-extractor/app.py')
preflight = module('document_preflight', ROOT / 'services/document-extractor/preflight.py')
generator = module('document_config_generator', ROOT / 'scripts/render-document-processing-config.py')
