"""Isolated stdlib regressions. No worker import, real state, or embeddings."""
import copy
import contextlib
import datetime as dt
import hashlib
import http.client
import importlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error

SERVICE = Path(__file__).resolve().parents[2] / "services" / "openbesluitvorming-statistics"
sys.path.insert(0, str(SERVICE))
metadata = importlib.import_module("metadata")
state = importlib.import_module("state")
server = importlib.import_module("server")


def point(number, **payload):
    return {"id": number, "payload": {"source_id": str(number), "source_key": "provincie_limburg",
            "ingest_run_id": "limburg-full-20261111", "entity_type": "Document", **payload}}


class FakeQdrant:
    def __init__(self, points):
        self.points, self.calls = points, []

    def request(self, operation, body, timeout):
        self.calls.append((operation, copy.deepcopy(body)))
        selected = self.points
        for condition in body["filter"]["must"]:
            match = condition["match"]
            selected = [p for p in selected if metadata.matches(p["payload"],
                        {"field": condition["key"], "operator": "eq", "value": match["value"]} if "value" in match else
                        {"field": condition["key"], "operator": "in", "values": match["any"]})]
        if operation == "count":
            return {"count": len(selected)}
        offset = body.get("offset", 0)
        end = offset + body["limit"]
        return {"points": copy.deepcopy(selected[offset:end]), "next_page_offset": end if end < len(selected) else None}


class MetadataTests(unittest.TestCase):
    def query(self, points, arguments, **budgets):
        client = FakeQdrant(points)
        result = metadata.Statistics(metadata.Config(page_size=2, **budgets), client).query(arguments)
        return result, client

    def test_native_count_excludes_other_runs_sources_and_checkpoints(self):
        points = [point(1), point(2), point(3, entity_type="Checkpoint"),
                  point(4, ingest_run_id="other"), point(5, source_key="other")]
        result, client = self.query(points, {"operation": "count"})
        self.assertEqual(result["total_documents"], 2)
        self.assertEqual(result["scanned_documents"], 0)
        self.assertTrue(result["exact"])
        self.assertTrue(all(op == "count" and body["exact"] for op, body in client.calls))

    def test_native_filtered_count_and_total(self):
        points = [point(1, classification=["A", "A"]), point(2, classification=["B"]), point(3)]
        for operator, arg in (("eq", {"value": "A"}), ("in", {"values": ["A", "B"]})):
            result, client = self.query(points, {"operation": "count", "filters": [
                {"field": "classification", "operator": operator, **arg}]})
            self.assertEqual(result["total_documents"], 3)
            self.assertEqual(result["matched_documents"], 1 if operator == "eq" else 2)
            self.assertTrue(all(op == "count" for op, body in client.calls))

    def test_all_nested_metadata_schema_not_content_or_credentials(self):
        points = [point(1, source_payload={"classification": ["A"], "custom": {"flag": False, "zero": 0, "null": None},
                                         "markdownText": "secret body", "api_key": "secret"},
                        entity_detail={"sortDate": "2020-01-01", "names": [{"name": "N"}]},
                        reference_detail={"date": "2020-02-01"}, extraction={"method": "pdf", "pages": 2},
                        full_text="SECRET", content_preview="SECRET", vectors=[1, 2]), point(2)]
        result, client = self.query(points, {"operation": "fields", "limit": 1000})
        fields = {r["field"]: r for r in result["fields"]}
        for name in ("source_payload.custom.flag", "source_payload.custom.zero", "source_payload.custom.null",
                     "entity_detail.names[].name", "reference_detail.date", "extraction.method"):
            self.assertEqual(fields[name]["present_documents"], 1)
            self.assertEqual(fields[name]["missing_documents"], 1)
        self.assertFalse(any("markdownText" in name for name in fields))
        self.assertNotIn("secret body", json.dumps(result))
        self.assertFalse(any(metadata.blocked(name.split(".")[-1]) for name in fields))
        for op, body in client.calls:
            if op == "scroll":
                self.assertFalse(body["with_vector"])
                self.assertIn("exclude", body["with_payload"])
                self.assertNotIn("include", body["with_payload"])

    def test_calendar_queries_project_only_date_aliases_and_identity(self):
        points = [point(1, date="2020-01-01", source_payload={"date": "2021-01-01"}),
                  point(2, entity_detail={"sortDate": "2020-06-01"}),
                  point(3, source_payload={"date": "2021-01-01"}), point(4)]
        result, client = self.query(points, {"operation": "group", "field": "date", "interval": "year"})
        self.assertEqual({g["value"]: g["count"] for g in result["groups"]}, {"2020": 2, "2021": 1})
        self.assertEqual(result["missing_documents"], 1)
        expected = {"source_id", "source_key", "ingest_run_id", "entity_type", *metadata.DATE_PATHS}
        for op, body in client.calls:
            if op == "scroll":
                self.assertEqual(set(body["with_payload"]["include"]), expected)
                self.assertNotIn("exclude", body["with_payload"])

        _, client = self.query(points, {"operation": "count", "filters": [
            {"field": "date", "operator": "range", "gte": "2020-01-01", "lt": "2021-01-01"}]})
        self.assertTrue(all("include" in body["with_payload"] for op, body in client.calls if op == "scroll"))

        _, client = self.query(points, {"operation": "group", "field": "date", "interval": "year", "filters": [
            {"field": "source_payload.custom", "operator": "missing"}]})
        self.assertTrue(all("source_payload.custom" in body["with_payload"]["include"] for op, body in client.calls if op == "scroll"))

    def test_generic_projection_expands_types_filters_and_array_containers(self):
        selector = metadata.query_payload_selector("group", {
            "document_type", "source_payload.custom[0].names[].label", "extraction.pages"})
        expected = {"source_id", "source_key", "ingest_run_id", "entity_type",
                    "source_payload.custom", "extraction.pages", *metadata.TYPE_PATHS}
        self.assertEqual(set(selector["include"]), expected)
        self.assertNotIn("exclude", selector)
        for operation in ("fields", "overview"):
            self.assertEqual(metadata.query_payload_selector(operation, {"date"}),
                             {"exclude": metadata.payload_exclusions()})

    def test_small_metadata_adapts_batches_without_changing_counts(self):
        points = [point(i, source_payload={"kind": "A" if i % 2 else "B"}) for i in range(100)]
        result, client = self.query(points, {"operation": "group", "field": "source_payload.kind"})
        self.assertEqual({g["value"]: g["count"] for g in result["groups"]}, {"A": 50, "B": 50})
        pages = [body for op, body in client.calls if op == "scroll"]
        self.assertEqual(len(pages), 2)
        self.assertEqual(pages[0]["limit"], 2)
        self.assertEqual(pages[1]["limit"], 1000)
        self.assertEqual(result["evidence"]["scroll_requests"], 2)
        self.assertTrue(result["exact"])

    def test_large_metadata_reduces_batches_and_retries_same_offset(self):
        points = [point(i, nested={"value": "x" * 3000}) for i in range(7)]
        result, client = self.query(points, {"operation": "group", "field": "nested.value"}, target_page_bytes=4096)
        self.assertEqual(result["groups"][0]["count"], 7)
        pages = [body for op, body in client.calls if op == "scroll"]
        self.assertEqual(pages[0]["limit"], 2)
        self.assertTrue(all(body["limit"] == 1 for body in pages[1:]))

        client = FakeQdrant([point(i, x="A") for i in range(9)])
        original = client.request
        attempts = []
        def limited(operation, body, timeout):
            if operation == "scroll":
                attempts.append(copy.deepcopy(body))
                if body["limit"] > 3:
                    raise metadata.QueryError("qdrant_response_budget_exceeded", 502, True)
            return original(operation, body, timeout)
        client.request = limited
        result = metadata.Statistics(metadata.Config(page_size=4, max_page_size=4), client).query({"operation": "group", "field": "x"})
        self.assertEqual(result["groups"][0]["count"], 9)
        self.assertEqual(attempts[0]["limit"], 4)
        self.assertEqual(attempts[1]["limit"], 2)
        self.assertEqual(attempts[0].get("offset"), attempts[1].get("offset"))

    def test_adaptive_config_limits_and_irreducible_response_budget(self):
        for name, value in (("MAX_PAGE_SIZE", "1001"), ("MAX_PAGE_SIZE", "1"),
                            ("TARGET_PAGE_BYTES", "0"), ("TARGET_PAGE_BYTES", str(9 * 1024 * 1024))):
            with self.subTest(name=name, value=value), patch.dict(os.environ, {"OBV_STATS_" + name: value}):
                with self.assertRaises(ValueError):
                    metadata.Config.environment()
        client = FakeQdrant([point(1, x="A")])
        original = client.request
        attempts = []
        def oversized(operation, body, timeout):
            if operation == "scroll":
                attempts.append(body["limit"])
                raise metadata.QueryError("qdrant_response_budget_exceeded", 502, True)
            return original(operation, body, timeout)
        client.request = oversized
        with self.assertRaises(metadata.QueryError) as caught:
            metadata.Statistics(metadata.Config(page_size=4), client).query({"operation": "group", "field": "x"})
        self.assertEqual(attempts, [4, 2, 1])
        self.assertEqual(caught.exception.code, "qdrant_response_budget_exceeded")

    def test_arrays_count_once_per_value_and_union_explicit(self):
        points = [point(1, classification=["A", "A", "B"]), point(2, classification=["A"]),
                  point(3), point(4, classification=[None, "B", {"bad": 1}]), point(5, classification=[])]
        result, _ = self.query(points, {"operation": "group", "field": "classification", "limit": 1})
        self.assertEqual(result["groups"], [{"value": "A", "value_type": "string", "count": 2}])
        self.assertEqual(result["matched_documents"], 5)
        self.assertEqual(result["total_groups"], 2)
        self.assertEqual(result["group_memberships"], 4)
        self.assertEqual(result["documents_with_value"], 3)
        self.assertEqual(result["overlap_documents"], 1)
        self.assertEqual(result["missing_documents"], 1)
        self.assertEqual(result["invalid_documents"], 1)
        self.assertEqual(result["null_documents"], 1)
        self.assertTrue(result["exact"])
        self.assertTrue(result["groups_paginated"])

    def test_long_metadata_strings_do_not_break_discovery_or_grouping(self):
        description = "Agenda description " * 1000
        points = [point(1, reference_detail={"description": description}),
                  point(2, reference_detail={"description": description})]
        schema, _ = self.query(points, {"operation": "fields", "limit": 1000})
        fields = {row["field"]: row for row in schema["fields"]}
        self.assertEqual(fields["reference_detail.description"]["present_documents"], 2)
        self.assertNotIn(description, json.dumps(schema))
        result, _ = self.query(points, {"operation": "group", "field": "reference_detail.description"})
        self.assertEqual(result["groups"], [{"value": description, "value_type": "string", "count": 2}])
        self.assertEqual(result["invalid_documents"], 0)
        self.assertTrue(result["exact"])

    def test_group_value_memory_budget_errors_instead_of_returning_partial_counts(self):
        with self.assertRaises(metadata.QueryError) as caught:
            self.query([point(1, description="x" * 5000)],
                       {"operation": "group", "field": "description"}, max_group_bytes=1000)
        self.assertEqual(caught.exception.code, "group_value_memory_budget_exceeded")
        self.assertTrue(caught.exception.truncated)
        schema, _ = self.query([point(1, description="x" * 5000)],
                               {"operation": "fields"}, max_group_bytes=1000)
        self.assertTrue(schema["exact"])

    def test_client_filter_value_budget_remains_bounded(self):
        with self.assertRaises(metadata.QueryError) as caught:
            metadata.validate_query({"operation": "count", "filters": [
                {"field": "title", "operator": "eq", "value": "x" * 4097}]})
        self.assertEqual(caught.exception.code, "filter_value_budget_exceeded")

    def test_snake_case_document_type_is_not_hidden_by_virtual_alias(self):
        result, _ = self.query([point(1, document_type="Besluit", classification=["Bijlage"]),
                               point(2, source_payload={"document_type": "Voorstel"})],
                              {"operation": "group", "field": "document_type"})
        self.assertEqual({row["value"] for row in result["groups"]}, {"Besluit", "Voorstel"})

    def test_typed_scalar_keys_false_zero_null_and_case(self):
        result, _ = self.query([point(1, x=[False, 0, 0.0, "0", "A", "a", None])],
                               {"operation": "group", "field": "x"})
        self.assertEqual(result["total_groups"], 5)
        self.assertEqual(result["null_documents"], 1)
        for value, expected in ((False, True), (0, True), (None, True), (True, False), ("a", True)):
            self.assertEqual(metadata.matches({"x": [False, 0, "a", None]}, {"field": "x", "operator": "eq", "value": value}), expected)

    def test_nested_array_and_numeric_index_filters(self):
        p = {"items": [{"name": "A"}, {"name": "B"}], "nested": {"value": 3}}
        for field, value in (("items[].name", "B"), ("items[0].name", "A"), ("nested.value", 3)):
            self.assertTrue(metadata.matches(p, {"field": field, "operator": "eq", "value": value}))
        self.assertFalse(metadata.matches(p, {"field": "items[0].name", "operator": "eq", "value": "B"}))

    def test_empty_array_and_null_exist_missing_semantics(self):
        for p in ({"x": []}, {"x": None}, {"x": False}, {"x": 0}):
            self.assertTrue(metadata.matches(p, {"field": "x", "operator": "exists"}))
            self.assertFalse(metadata.matches(p, {"field": "x", "operator": "missing"}))
        self.assertTrue(metadata.matches({}, {"field": "x", "operator": "missing"}))
        self.assertTrue(metadata.matches({"classification": []}, {"field": "document_type", "operator": "exists"}))

    def test_date_year_alias_real_source_dates_and_type_precedence(self):
        points = [point(1, entity_detail={"sortDate": "2020-01-01"}, classification=["Decision"]),
                  point(2, source_payload={"date": "2021-02-01"}, classification=["Report"], documentType="Explicit"),
                  point(3, source_payload={"date_modified": "2022-03-01"}),
                  point(4, date="2020-12-31T23:30:00-01:00"), point(5, date="bad"),
                  point(6, date=None), point(7)]
        result, _ = self.query(points, {"operation": "group", "field": "date", "interval": "year"})
        self.assertEqual({r["value"]: r["count"] for r in result["groups"]}, {"2020": 1, "2021": 2, "2022": 1})
        self.assertEqual(result["invalid_documents"], 1)
        self.assertEqual(result["null_documents"], 1)
        self.assertEqual(result["missing_documents"], 1)
        type_result, _ = self.query(points, {"operation": "group", "field": "document_type"})
        self.assertEqual({r["value"] for r in type_result["groups"]}, {"Decision", "Explicit"})

    def test_date_range_filters_stream_and_month(self):
        points = [point(1, entity_detail={"sortDate": "2020-01-01"}), point(2, date="2021-01-01"),
                  point(3, date="2020-06-01"), point(4, date="bad")]
        result, client = self.query(points, {"operation": "group", "field": "date", "interval": "month", "filters": [
            {"field": "date", "operator": "range", "gte": "2020-01-01", "lt": "2021-01-01"}]})
        self.assertEqual(result["matched_documents"], 2)
        self.assertEqual({r["value"] for r in result["groups"]}, {"2020-01", "2020-06"})
        self.assertTrue(any(op == "scroll" for op, body in client.calls))

    def test_literal_reference_date_and_year_alias(self):
        points = [point(1, date="2020-01-01", reference_detail={"date": "2022-02-01"}),
                  point(2, source_payload={"date_modified": "2021-01-01"}, reference_detail={"date": "invalid"})]
        reference, _ = self.query(points, {"operation": "group", "field": "reference_detail.date", "interval": "year"})
        self.assertEqual(reference["groups"][0]["value"], "2022")
        self.assertEqual(reference["invalid_documents"], 1)
        years, _ = self.query(points, {"operation": "group", "field": "year"})
        self.assertEqual({r["value"] for r in years["groups"]}, {"2020", "2021"})

    def test_native_bool_and_numeric_legacy_filter_fallback(self):
        points = [point(1, value=False), point(2, value=0.0), point(3, value=0)]
        result, client = self.query(points, {"operation": "count", "filters": [
            {"field": "value", "operator": "eq", "value": False}]})
        self.assertEqual(result["matched_documents"], 1)
        self.assertEqual(result["scanned_documents"], 0)
        result, client = self.query(points, {"operation": "count", "filters": [
            {"field": "value", "operator": "eq", "value": 0}]})
        self.assertEqual(result["matched_documents"], 2)
        self.assertTrue(any(op == "scroll" for op, _ in client.calls))

    def test_qdrant_transport_read_only_key_and_error_redaction(self):
        client = metadata.Qdrant(metadata.Config(api_key="fixture-provider-secret"))
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"status":"ok","result":{"count":2}}'
        with patch.object(client.opener, "open", return_value=response) as opened:
            self.assertEqual(client.request("count", {"exact": True}, 1), {"count": 2})
        request = opened.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertTrue(request.full_url.endswith("/points/count"))
        self.assertEqual(request.get_header("Api-key"), "fixture-provider-secret")
        for data in (b'[]', b'{"status":"error","secret":"DO NOT RETURN"}', b'{bad'):
            response.__enter__.return_value.read.return_value = data
            with patch.object(client.opener, "open", return_value=response), self.assertRaises(metadata.QueryError) as caught:
                client.request("count", {}, 1)
            self.assertEqual(caught.exception.status, 502)
            self.assertNotIn("DO NOT RETURN", str(caught.exception))
        with patch.object(client.opener, "open", side_effect=urllib.error.URLError("fixture-provider-secret")), self.assertRaises(metadata.QueryError) as caught:
            client.request("count", {}, 1)
        self.assertNotIn("fixture-provider-secret", str(caught.exception))

    def test_config_scope_and_credentials_from_server_environment_only(self):
        with patch.dict(os.environ, {"OBV_QDRANT_URL": "http://qdrant:6333", "OBV_STATS_COLLECTION": "fixture",
                                    "OBV_STATS_RUN_ID": "fixture-run", "OBV_QDRANT_API_KEY": "fixture-secret"}, clear=True):
            config = metadata.Config.environment()
            self.assertEqual(config.collection, "fixture")
            self.assertEqual(config.api_key, "fixture-secret")
        for url in ("file:///state/ingest.sqlite", "http://user:password@qdrant", "http://qdrant?token=secret"):
            with patch.dict(os.environ, {"OBV_QDRANT_URL": url}, clear=True), self.assertRaises(ValueError):
                metadata.Config.environment()

    def test_numeric_range_does_not_match_bool_or_strings(self):
        points = [point(1, n=0), point(2, n=False), point(3, n="0"), point(4, n=1.5)]
        result, _ = self.query(points, {"operation": "count", "filters": [
            {"field": "n", "operator": "range", "gte": 0, "lt": 2}]})
        self.assertEqual(result["matched_documents"], 2)

    def test_reject_input_dsl_injection_paths_and_bounds(self):
        invalid = [{"operation": "count", "url": "http://evil"}, {"operation": "count", "collection": "other"},
                   {"operation": "count", "filter": {"must": []}}, {"operation": "eval"},
                   {"operation": "group", "field": "__import__('os')"}, {"operation": "group", "field": "x;DROP"},
                   {"operation": "group", "field": "a..b"}, {"operation": "group", "field": "a[-1]"},
                   {"operation": "group", "field": "a[99999999999999999999999999999999999999999999999999999999999999]", "limit": False},
                   {"operation": "group", "field": "source_payload.markdownText"},
                   {"operation": "group", "field": "full_text"}, {"operation": "group", "field": "a" * 201},
                   {"operation": "count", "limit": 1001}, {"operation": "count", "offset": -1},
                   {"operation": "count", "filters": [{"field": "x", "operator": "eq"}]},
                   {"operation": "count", "filters": [{"field": "x", "operator": "range", "gte": "2020-01-01T00:00:00"}]},
                   {"operation": "count", "filters": [{"field": "x", "operator": "range", "gte": 0, "lt": "2020-01-01"}]},
                   {"operation": "count", "filters": [{"field": "x", "operator": "in", "values": []}]},
                   {"operation": "count", "filters": [{"field": "x", "operator": "eq", "value": {"must": []}}]},
                   {"operation": "count", "filters": [{"field": "x", "operator": "missing"}] * 33}]
        for query in invalid:
            with self.subTest(query=query), self.assertRaises(metadata.QueryError):
                metadata.validate_query(query)

    def test_page_document_group_and_schema_budgets_never_partial_exact(self):
        cases = [(dict(max_pages=1), [point(i, x=i) for i in range(3)], "group"),
                 (dict(max_documents=1), [point(i, x=i) for i in range(2)], "group"),
                 (dict(max_groups=1), [point(i, x=i) for i in range(2)], "group"),
                 (dict(max_fields=1), [point(1)], "fields")]
        for budgets, points, operation in cases:
            with self.subTest(budgets=budgets), self.assertRaises(metadata.QueryError) as caught:
                self.query(points, {"operation": operation, **({"field": "x"} if operation == "group" else {})}, **budgets)
            self.assertTrue(caught.exception.truncated)

    def test_duplicate_source_and_unstable_offsets_rejected(self):
        with self.assertRaises(metadata.QueryError) as caught:
            self.query([point(1), point(2, source_id="1")], {"operation": "group", "field": "x"})
        self.assertEqual(caught.exception.code, "duplicate_source_document")
        client = FakeQdrant([point(1)])
        original = client.request
        def broken(operation, body, timeout):
            result = original(operation, body, timeout)
            if operation == "scroll":
                result["next_page_offset"] = 0
            return result
        client.request = broken
        with self.assertRaises(metadata.QueryError):
            metadata.Statistics(metadata.Config(), client).query({"operation": "group", "field": "x"})

    def test_count_change_and_time_budget(self):
        client = FakeQdrant([point(1)])
        original = client.request
        calls = [0]
        def changed(operation, body, timeout):
            result = original(operation, body, timeout)
            if operation == "count":
                calls[0] += 1
                result["count"] += int(calls[0] > 1)
            return result
        client.request = changed
        with self.assertRaises(metadata.QueryError) as caught:
            metadata.Statistics(metadata.Config(), client).query({"operation": "count"})
        self.assertEqual(caught.exception.status, 409)
        with patch.object(metadata.time, "monotonic", side_effect=[0, 181]):
            with self.assertRaises(metadata.QueryError) as caught:
                metadata.Statistics(metadata.Config(), FakeQdrant([])).query({"operation": "count"})
        self.assertTrue(caught.exception.truncated)

    def test_schema_pagination_full_counts_and_overview_status(self):
        client = FakeQdrant([point(1, custom=1), point(2)])
        statistics = metadata.Statistics(metadata.Config(), client, lambda: {"available": False, "reason": "fixture"})
        result = statistics.query({"operation": "overview", "limit": 1, "offset": 1})
        self.assertEqual(result["matched_documents"], 2)
        self.assertTrue(result["fields_paginated"])
        self.assertEqual(len(result["fields"]), 1)
        self.assertFalse(result["status"]["available"])


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "worker.lock").write_bytes(b"0")
        self.config = metadata.Config()
        db = sqlite3.connect(self.root / "ingest.sqlite")
        db.executescript("""
            CREATE TABLE runs(id TEXT,collection TEXT,source TEXT,updated_at TEXT,snapshot_complete INTEGER,
                              refresh_phase TEXT,generation INTEGER,last_error TEXT);
            CREATE TABLE documents(run_id TEXT,status TEXT,has_vector INTEGER);
            CREATE TABLE refresh_generations(run_id TEXT,generation INTEGER,baseline TEXT);
        """)
        db.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)", (self.config.run_id, self.config.collection,
                   self.config.source, "2026-01-01T12:00:00Z", 1, "complete", 1, None))
        db.executemany("INSERT INTO documents VALUES(?,?,?)", [(self.config.run_id, "indexed", 1)] * 3 + [(self.config.run_id, "dead_letter", 0)])
        db.commit()
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def update(self, sql, parameters=()):
        with contextlib.closing(sqlite3.connect(self.root / "ingest.sqlite")) as db:
            with db:
                db.execute(sql, parameters)

    def test_exhausted_scan_with_failures_is_not_successful_sync(self):
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.iterdir()}
        result = state.read_status(self.root, self.config)
        self.assertTrue(result["available"])
        self.assertEqual(result["checkpoint_has_vector"], 3)
        self.assertEqual(result["failed_documents"], 1)
        self.assertEqual(result["unfinished_documents"], 0)
        self.assertFalse(result["source_complete"])
        self.assertIsNone(result["last_successful_full_sync_at"])
        self.assertEqual(result["last_completed_scan_at"], "2026-01-01T12:00:00Z")
        self.assertEqual(result["read_mode"], "immutable_locked")
        after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.iterdir()}
        self.assertEqual(before, after)

    def test_zero_failures_complete_checkpoint_success(self):
        self.update("DELETE FROM documents WHERE status='dead_letter'")
        result = state.read_status(self.root, self.config)
        self.assertTrue(result["source_complete"])
        self.assertEqual(result["last_successful_full_sync_at"], "2026-01-01T12:00:00Z")

    def test_active_refresh_historical_baseline_not_checkpoint_sync(self):
        baseline = {"id": self.config.run_id, "snapshot_complete": 1, "refresh_phase": "complete", "updated_at": "2025-12-01T00:00:00Z"}
        self.update("INSERT INTO refresh_generations VALUES(?,?,?)", (self.config.run_id, 1, json.dumps(baseline)))
        self.update("UPDATE runs SET snapshot_complete=0,refresh_phase='inventory'")
        result = state.read_status(self.root, self.config)
        self.assertEqual(result["last_completed_scan_at"], "2025-12-01T00:00:00Z")
        self.assertEqual(result["last_updated_checkpoint_at"], "2026-01-01T12:00:00Z")
        self.assertIsNone(result["last_successful_full_sync_at"])
        self.assertFalse(result["last_attempt"]["completed_scan"])

    def test_scan_history_orders_real_instants_not_iso_lexically(self):
        baseline = {"id": self.config.run_id, "snapshot_complete": 1, "refresh_phase": "complete", "updated_at": "2026-01-01T12:00:00.100000Z"}
        self.update("INSERT INTO refresh_generations VALUES(?,?,?)", (self.config.run_id, 1, json.dumps(baseline)))
        result = state.read_status(self.root, self.config)
        self.assertEqual(result["last_completed_scan_at"], "2026-01-01T12:00:00.100000Z")

    def test_pending_jobs_are_not_complete_and_no_indexed_at_substitute(self):
        self.update("UPDATE documents SET status='pending' WHERE status='dead_letter'")
        result = state.read_status(self.root, self.config)
        self.assertFalse(result["source_complete"])
        self.assertEqual(result["unfinished_documents"], 1)
        self.assertIsNone(result["last_successful_full_sync_at"])

    def test_legacy_dead_status_is_a_failure_not_pending_work(self):
        self.update("UPDATE documents SET status='dead' WHERE status='dead_letter'")
        result = state.read_status(self.root, self.config)
        self.assertEqual(result["failed_documents"], 1)
        self.assertEqual(result["unfinished_documents"], 0)
        self.assertFalse(result["source_complete"])

    def test_future_malformed_naive_and_date_only_checkpoints_rejected(self):
        for value in ("2999-01-01T00:00:00Z", "bad", "2025-01-01T00:00:00", "2025-01-01", "2025-02-30T00:00:00Z"):
            self.update("UPDATE runs SET updated_at=?", (value,))
            result = state.read_status(self.root, self.config)
            self.assertIsNone(result["last_updated_checkpoint_at"])
            self.assertIsNone(result["last_completed_scan_at"])
            self.assertFalse(result["timestamp_valid"])

    def test_missing_lock_state_and_wrong_scope_fail_closed(self):
        self.assertFalse(state.read_status(self.root / "absent", self.config)["available"])
        other = metadata.Config(run_id="other")
        self.assertFalse(state.read_status(self.root, other)["available"])
        (self.root / "worker.lock").unlink()
        self.assertFalse(state.read_status(self.root, self.config)["available"])
        self.assertFalse((self.root / "worker.lock").exists())

    def test_busy_writer_lock_unavailable(self):
        with patch.object(state, "shared_lock", side_effect=OSError("busy")):
            result = state.read_status(self.root, self.config)
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "state_busy_unreadable_or_schema_unavailable")

    def test_populated_wal_never_ignored_or_source_sidecars_created(self):
        (self.root / "ingest.sqlite-wal").write_bytes(b"fixture populated WAL")
        result = state.read_status(self.root, self.config)
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "wal_without_readable_shared_memory")
        self.assertFalse((self.root / "ingest.sqlite-shm").exists())
        (self.root / "ingest.sqlite-shm").write_bytes(b"fixture SHM")
        result = state.read_status(self.root, self.config)
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "wal_requires_readonly_filesystem")


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.service = server.Server(("127.0.0.1", 0), metadata.Statistics(metadata.Config(), FakeQdrant([point(1)])),
                                     "fixture-secret", max_request_bytes=2048)
        self.thread = threading.Thread(target=self.service.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.service.shutdown()
        self.service.server_close()
        self.thread.join()

    def request(self, method, path, body=None, token="fixture-secret", headers=None):
        connection = http.client.HTTPConnection(*self.service.server_address, timeout=2)
        merged = {"Content-Type": "application/json"}
        if token is not None:
            merged["Authorization"] = "Bearer " + token
        merged.update(headers or {})
        try:
            connection.request(method, path, body, merged)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health_nonsecret_and_query_authentication(self):
        code, body = self.request("GET", "/healthz", token=None)
        self.assertEqual((code, body), (200, {"status": "ok"}))
        for token in (None, "wrong"):
            code, body = self.request("POST", "/query", '{"operation":"count"}', token)
            self.assertEqual(code, 401)
            self.assertFalse(body["exact"])
        code, body = self.request("POST", "/query", '{"operation":"count"}')
        self.assertEqual(code, 200)
        self.assertEqual(body["matched_documents"], 1)
        self.assertNotIn("fixture-secret", json.dumps(body))

    def test_unknown_routes_types_size_duplicate_json_and_nonfinite(self):
        cases = [("POST", "/unknown", '{}', {}, 404), ("GET", "/query", None, {}, 404),
                 ("PUT", "/query", '{}', {}, 405),
                 ("POST", "/query", '{"operation":"count"}', {"Content-Type": "text/plain"}, 415),
                 ("POST", "/query", 'x' * 2049, {}, 413),
                 ("POST", "/query", '{"operation":"count","operation":"status"}', {}, 400),
                 ("POST", "/query", '{"operation":"count","limit":NaN}', {}, 400),
                 ("POST", "/query", '{"operation":"count","url":"http://evil"}', {}, 400)]
        for method, path, body, headers, expected in cases:
            with self.subTest(path=path, body=body):
                code, result = self.request(method, path, body, headers=headers)
                self.assertEqual(code, expected)
                self.assertFalse(result["exact"])

    def test_structured_scan_limit_error(self):
        self.service.statistics = metadata.Statistics(metadata.Config(max_groups=1), FakeQdrant([point(1, x=1), point(2, x=2)]))
        code, result = self.request("POST", "/query", '{"operation":"group","field":"x"}')
        self.assertEqual(code, 422)
        self.assertFalse(result["exact"])
        self.assertTrue(result["truncated"])
        self.assertNotIn("groups", result)

    def test_worker_limit_returns_busy(self):
        for _ in range(4):
            self.assertTrue(self.service.slots.acquire(False))
        try:
            code, result = self.request("POST", "/query", '{"operation":"count"}')
            self.assertEqual(code, 503)
            self.assertEqual(result["error"]["code"], "service_busy")
        finally:
            for _ in range(4):
                self.service.slots.release()

    def test_startup_requires_token_and_parse_rejects_duplicate_nested_keys(self):
        with self.assertRaises(ValueError):
            server.Server(("127.0.0.1", 0), None, "")
        with self.assertRaises(metadata.QueryError):
            server.parse_json(b'{"filters":[{"field":"a","field":"b"}]}')


if __name__ == "__main__":
    unittest.main()
