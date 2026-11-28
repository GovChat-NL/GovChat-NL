"""Onafhankelijke inhouds- en inventarisregressies; uitsluitend tijdelijke bronkopieën."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import manual_catalog_content as content
from scripts import run_regressions as runner

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('scripts.manual_error_inventory', ROOT / 'scripts/manual-error-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class ContentSecurityTests(unittest.TestCase):
    def test_content_generator_check_is_read_only_and_both_defaults_match(self):
        paths = [ROOT / folder / name for folder in ['overlay/defaults', 'services/admin-overlay/admin/defaults']
                 for name in ['manual.json', 'manual-limburg.json', 'help-content.json']]
        before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in paths]
        subprocess.run([sys.executable, 'scripts/build-manual-content.py', '--check'], cwd=ROOT, check=True, capture_output=True)
        self.assertEqual(before, [(p.read_bytes(), p.stat().st_mtime_ns) for p in paths])

    def test_original_catalog_ids_are_preserved_and_no_boilerplate_diagnosis(self):
        model = json.loads((ROOT / 'services/admin-overlay/admin/defaults/manual.json').read_text())
        articles = [a for c in model['errorCategories'] for a in c['articles']]
        self.assertGreaterEqual(len(articles), 684)
        self.assertEqual(len(articles), len({a['id'] for a in articles}))
        for a in articles:
            self.assertNotIn('Deze specifieke actie is niet voltooid.', a['content'])
            self.assertIn('<h3>Betekenis</h3>', a['content'])
            self.assertIn('<h3>Wat kun je doen?</h3>', a['content'])
        self.assertEqual(model['visibility']['categories']['appendix-errors'], False)

    def test_distinct_http_statuses_have_correct_not_auth_generic_meanings(self):
        expected = {'HTTP 401': 'authenticatie', 'HTTP 403': 'toegang is geweigerd', 'HTTP 404': 'verwijderd',
                    'HTTP 413': 'grens', 'HTTP 429': 'limiter', 'HTTP 502': 'proxy', 'HTTP 504': 'timeout'}
        for code, phrase in expected.items():
            cat, article = inventory.article(code, '', 'proxy/network/SSO')
            self.assertNotEqual(cat, 'appendix-errors', code)
            self.assertIn(phrase.lower(), article['content'].lower(), code)

    def test_parser_failures_explain_actual_safe_recovery(self):
        expected = {'signature_mismatch': 'extensie', 'unsafe_sheet_target': 'spreadsheetverwijzing',
                    'invalid_shared_string': 'cellen', 'worker_memory_limit': 'geheugen',
                    'timeout_work_termination_unproven': 'beëindigd', 'macros_unsupported': 'macro-vrije',
                    'empty_spreadsheet': 'echte cellen', 'pdf_page_count_mismatch': 'paginatellingen'}
        for code, phrase in expected.items():
            cat, article = inventory.article(code, '', 'services/document-extractor/app.py')
            self.assertEqual(cat, 'document-errors', code)
            self.assertIn(phrase.lower(), article['content'].lower(), code)

    def test_labels_optional_features_and_noise_are_explicit_appendix_not_errors(self):
        for code, message in [('com_error_token_balance_prompt', 'Promptgrootte: {{0}} tokens.'),
                              ('com_ui_failed_subject', 'Mislukt'), ('com_ui_schedule_cron_invalid', 'Ongeldig schema'),
                              ('GET', ''), (')) invalid(', ''), ('com_ui_project_create_error', 'Project maken mislukt')]:
            cat, article = inventory.article(code, message, 'overlay/locales/nl/translation.json')
            self.assertEqual(cat, 'appendix-errors', code)
            self.assertNotIn('Deze specifieke actie', article['content'])
        heading, meaning, *_ = content.explain('com_ui_failed_subject', 'Mislukt', '', inventory.RULES)
        self.assertIn('geen afzonderlijke storing', meaning)

    def test_credentials_and_document_limits_not_misclassified_as_session_tokens(self):
        for code in ['invalid_api_key', 'expired_user_key', 'no_base_url']:
            _, article = inventory.article(code, '', 'provider')
            self.assertIn('providertoken is geen chatsessietoken', article['content'].lower())
        _, article = inventory.article('TEXT_TOO_LARGE', '', 'extractor')
        self.assertIn('bestandsgrootte', article['content'])

    def test_core_chat_tool_and_attachment_failures_are_not_generic_optional_labels(self):
        for code, phrase in [('com_error_concurrent', 'loopt al verwerking'), ('com_error_message_limit', 'aantal berichten'),
                             ('com_error_tool_call_limit', 'toolaanroepen'), ('com_ui_attach_error_type', 'bestandstype'),
                             ('com_ui_tool_approval_reset_error', 'eenmalige goedkeuring')]:
            cat, article = inventory.article(code, '', 'overlay/locales/nl/translation.json')
            self.assertNotEqual(cat, 'appendix-errors', code)
            self.assertIn(phrase, article['content'].lower(), code)
        for code, phrase in [('com_ui_schedule_cron_invalid', 'tijdzone'), ('com_ui_project_create_error', 'actuele versie'),
                             ('com_ui_langfuse_save_error', 'ruwe traces'), ('com_ui_code_environment_pairing_error', 'isolatie')]:
            cat, article = inventory.article(code, '', 'overlay/locales/nl/translation.json')
            self.assertEqual(cat, 'appendix-errors', code)
            self.assertIn(phrase, article['content'].lower(), code)

    def test_snapshot_has_only_explicit_inventory_doc_and_new_dependencies(self):
        self.assertTrue(runner.public_path('docs/manual-error-inventory.json'))
        self.assertFalse(runner.public_path('docs/private-review.json'))
        for path in ['scripts/manual_catalog_content.py', 'tests/test_manual_content_security.py', 'tests/manual/content-security-review.test.js']:
            self.assertIn(path, runner.NEW_FILES)
        with tempfile.TemporaryDirectory(prefix='manual-public-snapshot-') as directory:
            destination = Path(directory)
            # Ook werken in de runner-snapshot zelf: die heeft bewust geen tracked Git-
            # index. Supply alleen de concrete publieke inventory/build dependencies.
            names = inventory.repo_sources() + ['docker-compose.yml', 'docs/manual-error-inventory.json']
            names += [f'{folder}/{name}' for folder in ['overlay/defaults', 'services/admin-overlay/admin/defaults']
                      for name in ['manual.json', 'manual-limburg.json', 'help-content.json']]
            with patch.object(runner.subprocess, 'check_output', return_value=('\0'.join(names) + '\0').encode()):
                runner.snapshot(destination)
            self.assertTrue((destination / 'docs/manual-error-inventory.json').is_file())
            subprocess.run([sys.executable, 'scripts/manual-error-inventory.py'], cwd=destination, check=True, capture_output=True)
            subprocess.run([sys.executable, 'scripts/build-manual-content.py', '--check'], cwd=destination, check=True, capture_output=True)

    def test_sibling_fingerprints_fail_on_drift_then_refresh_without_suppression(self):
        baseline = json.loads(inventory.INVENTORY.read_text())
        targets = ['services/admin-overlay/admin/lib/manual-routes.js', 'services/admin-overlay/admin/lib/manual-context.js',
                   'scripts/n8n-orchestrator-tool-policy.js', 'scripts/patch-manual-native.js']
        with tempfile.TemporaryDirectory(prefix='manual-inventory-review-') as directory:
            root = Path(directory)
            for name in inventory.repo_sources():
                dest = root / name; dest.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT / name, dest)
            inv = root / 'docs/manual-error-inventory.json'; inv.parent.mkdir(); inv.write_text(json.dumps(baseline))
            model = root / 'services/admin-overlay/admin/defaults/manual.json'; model.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / 'services/admin-overlay/admin/defaults/manual.json', model)
            with patch.object(inventory, 'ROOT', root), patch.object(inventory, 'INVENTORY', inv):
                for name in targets:
                    with self.subTest(name=name):
                        original = (root / name).read_text()
                        (root / name).write_text(original + '\n// Onafhankelijke fingerprintregressie.\n')
                        with self.assertRaisesRegex(SystemExit, 'Foutbronnen gewijzigd'):
                            inventory.check(None)
                        current = inventory.collect(None, baseline)
                        old = next(a for a in baseline['artifacts'] if a['path'] == name)
                        new = next(a for a in current['artifacts'] if a['path'] == name)
                        self.assertNotEqual(old['sha256'], new['sha256'])
                        self.assertEqual(old['entries'], new['entries'])
                        inv.write_text(json.dumps(current))
                        with contextlib.redirect_stdout(io.StringIO()): inventory.check(None)
                        (root / name).write_text(original); inv.write_text(json.dumps(baseline))


if __name__ == '__main__':
    unittest.main()
