#!/usr/bin/env python3
"""Generate opt-in Tika document upload settings without changing the source."""
import argparse
import copy
import json
import pathlib
import re

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Published LibreChat file-config default patterns, retained as configuration
# data to preserve media/tool/built-in-format support when making the endpoint explicit.
DEFAULT_SUPPORTED = [
    r'^(text/(x-c|x-csharp|tab-separated-values|x-c\+\+|x-h|x-java|html|markdown|x-php|x-python|x-script\.python|x-ruby|x-tex|plain|css|vtt|javascript|csv|xml|calendar))$',
    r'^application/(vnd\.ms-excel|msexcel|x-msexcel|x-ms-excel|x-excel|x-dos_ms_excel|xls|x-xls|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$',
    r'^application/(epub\+zip|csv|json|msword|pdf|x-tar|x-sh|x-zip-compressed|typescript|sql|yaml|x-parquet|vnd\.apache\.parquet|vnd\.coffeescript|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.(presentation|template)|spreadsheetml\.sheet)|vnd\.oasis\.opendocument\.(text|spreadsheet|presentation|graphics)|xml|zip)$',
    r'^image/(jpeg|gif|png|webp|heic|heif)$',
    r'^video/(mp4|avi|mov|wmv|flv|webm|mkv|m4v|3gp|ogv)$',
    r'^audio/(mp3|mpeg|mpeg3|wav|wave|x-wav|ogg|vorbis|mp4|m4a|x-m4a|flac|x-flac|webm|aac|wma|opus)$',
    r'^image/(svg|svg\+xml)$', r'^message/rfc822$',
]


def document_config(source, routes, stt_configured=False):
    config = copy.deepcopy(source)
    target = 'govchat-orchestrator'
    endpoint = next(e for e in config['endpoints']['custom'] if e['name'] == target)
    endpoint['resendFiles'] = True
    mimes = sorted({m for route in routes.values() for m in route['mimes']})
    # Browser MIME uses macroEnabled; transport MIME is normalized to lowercase.
    # Character class works in both Python validation and LibreChat's JS RegExp.
    exact = ['^' + re.escape(m).replace('macroenabled', 'macro[eE]nabled') + '$' for m in mimes]
    file_config = config.setdefault('fileConfig', {})
    endpoints = file_config.setdefault('endpoints', {})
    inherited = endpoints.get(target, endpoints.get('agents', endpoints.get('default', {})))
    target_config = endpoints.setdefault(target, copy.deepcopy(inherited))
    target_config['legacyFileUploadUX'] = False
    # LibreChat config uses MiB here; reject oversized files in the UI/handler too.
    limit = target_config.get('fileSizeLimit', endpoints.get('default', {}).get('fileSizeLimit', 12))
    target_config['fileSizeLimit'] = min(limit, 12)
    # Making supportedMimeTypes explicit would otherwise opt a custom endpoint
    # into native media bytes. Preserve implicit audio/video delivery using the
    # deployment's explicitly declared speech-provider state, not guessed secrets.
    if 'supportedMimeTypes' not in inherited and 'supportedMimeTypes' not in endpoints.get('default', {}):
        layers = [target_config.get('defaultLLMDeliveryPath', {}),
                  endpoints.get('default', {}).get('defaultLLMDeliveryPath', {}),
                  file_config.get('defaultLLMDeliveryPath', {})]
        for media, path in [('audio/*', 'text' if stt_configured else 'none'), ('video/*', 'none')]:
            if not any(layer.get('fallback') or media in layer.get('overrides', {}) for layer in layers):
                target_config.setdefault('defaultLLMDeliveryPath', {}).setdefault('overrides', {})[media] = path
    target_config.setdefault('defaultLLMDeliveryPath', {}).setdefault('overrides', {}).update(
        {m: 'text' for m in mimes})
    if 'application/vnd.ms-excel.sheet.macroenabled.12' in mimes:
        target_config['defaultLLMDeliveryPath']['overrides']['application/vnd.ms-excel.sheet.macroEnabled.12'] = 'text'
    # Explicit endpoint allowlist needed for .msg and browser aliases absent from defaults.
    existing_supported = target_config.get('supportedMimeTypes',
        file_config['endpoints'].get('default', {}).get('supportedMimeTypes', DEFAULT_SUPPORTED))
    target_config['supportedMimeTypes'] = list(dict.fromkeys(existing_supported + exact))
    text = file_config.setdefault('text', {})
    # Preserve standard native textual handling and add only explicit documents.
    native = json.loads((ROOT / 'services/document-extractor/native-text.json').read_text())
    native_patterns = ['^' + re.escape(m) + '$' for types in native.values() for m in types]
    existing = text.get('supportedMimeTypes', native_patterns)
    if any(re.search(pattern, 'x-librechat/x-probe') for pattern in existing):
        raise ValueError('existing permissive text configuration must be narrowed explicitly')
    text['supportedMimeTypes'] = list(dict.fromkeys(existing + exact))
    # OCR routing runs before configured text. Narrow documents must not overlap.
    # Keep existing OCR unchanged. If OCR_API_URL is configured, upstream default
    # OCR types overlap; deployment must explicitly narrow its OCR allowlist first.
    ocr = file_config.get('ocr', {}).get('supportedMimeTypes', [])
    if source.get('ocr') is not None and not ocr:
        raise ValueError('configured OCR default overlaps documents; narrow OCR MIME configuration explicitly')
    for pattern in ocr:
        if any(re.search(pattern, m) for m in mimes):
            raise ValueError('document MIME conflicts with earlier OCR routing')
    # Preserve LibreChat's inherited/configured model context limits. Full stored
    # text does not mean every token is included in any particular model prompt.
    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=pathlib.Path, default=ROOT / 'librechat.yaml')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--stt-configured', choices=['true', 'false'], required=True,
                        help='declare whether this isolated deployment has an upload transcription provider')
    args = parser.parse_args()
    if args.output.resolve() == args.source.resolve():
        raise ValueError('refusing to overwrite canonical source')
    routes = json.loads((ROOT / 'services/document-extractor/routes.json').read_text())
    source = yaml.safe_load(args.source.read_text())
    config = document_config(source, routes, args.stt_configured == 'true')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w') as file:
        yaml.safe_dump(config, file, sort_keys=False, allow_unicode=True)
    args.output.chmod(0o644)


if __name__ == '__main__':
    main()
