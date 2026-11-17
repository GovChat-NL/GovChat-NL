"""Opt-in Qdrant compatibility test: creates/deletes ONLY a random tiny fixture.

Never uses the default Limburg collection or ingest state. Disabled normally.
"""
import importlib
import json
import os
from pathlib import Path
import sys
import unittest
import urllib.request
import uuid

SERVICE = Path(__file__).resolve().parents[2] / "services" / "openbesluitvorming-statistics"
sys.path.insert(0, str(SERVICE))
metadata = importlib.import_module("metadata")


@unittest.skipUnless(os.environ.get("OBV_STATS_LIVE_TEST") == "1", "opt-in isolated Qdrant fixture only")
class LiveFixtureTests(unittest.TestCase):
    def test_exact_native_and_scroll_against_unindexed_nested_metadata(self):
        unique = uuid.uuid4().hex
        collection = "obv_stats_fixture_" + unique
        config = metadata.Config(url=os.environ.get("OBV_STATS_LIVE_URL", "http://127.0.0.1:6333"),
                                 collection=collection, run_id="fixture-" + unique, source="fixture",
                                 api_key=os.environ.get("OBV_QDRANT_API_KEY", ""),
                                 page_size=2, max_documents=16, max_pages=10, max_seconds=30)
        opener = urllib.request.build_opener(metadata.NoRedirect())
        created = False

        def fixture_request(method, suffix="", body=None):
            headers = {"Content-Type": "application/json"}
            if config.api_key:
                headers["api-key"] = config.api_key
            req = urllib.request.Request(config.url.rstrip("/") + "/collections/" + collection + suffix,
                    json.dumps(body).encode() if body is not None else None, headers, method=method)
            # Errors intentionally do not disclose response bodies or URLs.
            try:
                with opener.open(req, timeout=10) as response:
                    result = json.loads(response.read(1024 * 1024))
                self.assertEqual(result["status"], "ok")
            except Exception:
                self.fail("isolated live fixture request failed (details suppressed)")

        try:
            fixture_request("PUT", body={"vectors": {"size": 1, "distance": "Cosine"}})
            created = True
            fixture_points = []
            for n, date in ((1, "2020-01-01"), (2, "2021-01-01"), (3, None)):
                fixture_points.append({"id": n, "vector": [1.0], "payload": {
                    "source_id": str(n), "source_key": config.source, "ingest_run_id": config.run_id,
                    "entity_type": "Document", "entity_detail": {"sortDate": date},
                    "classification": ["A", "B", "A"] if n == 1 else ["B"],
                    "source_payload": {"custom": [{"name": "N", "score": n, "flag": n == 1, "null": None},
                                                   {"name": "Second", "score": n + 10}],
                                       "document_type": "C" if n == 2 else None,
                                       "markdownText": "DO NOT RETURN"},
                    "full_text": "DO NOT RETURN"}})
            fixture_points.append({"id": 4, "vector": [1.0], "payload": {
                "source_key": config.source, "ingest_run_id": config.run_id, "entity_type": "Checkpoint"}})
            fixture_request("PUT", "/points?wait=true", {"points": fixture_points})
            statistics = metadata.Statistics(config)
            counted = statistics.query({"operation": "count", "filters": [
                {"field": "classification", "operator": "eq", "value": "A"}]})
            self.assertEqual((counted["total_documents"], counted["matched_documents"]), (3, 1))
            years = statistics.query({"operation": "group", "field": "date", "interval": "year"})
            self.assertEqual({r["value"]: r["count"] for r in years["groups"]}, {"2020": 1, "2021": 1})
            self.assertEqual(years["null_documents"], 1)
            types = statistics.query({"operation": "group", "field": "classification"})
            self.assertEqual(types["group_memberships"], 4)
            class FullMetadataClient(metadata.Qdrant):
                def request(self, operation, body, timeout):
                    if operation == "scroll":
                        body = {**body, "with_payload": {"exclude": metadata.payload_exclusions()}}
                    return super().request(operation, body, timeout)

            baseline = metadata.Statistics(config, FullMetadataClient(config))
            queries = [
                {"operation": "group", "field": "document_type"},
                {"operation": "group", "field": "source_payload.custom[].name"},
                {"operation": "group", "field": "source_payload.custom[0].name"},
                {"operation": "group", "field": "source_payload.custom[1].score"},
                {"operation": "group", "field": "source_payload.custom[].null"},
                {"operation": "group", "field": "source_payload.custom[0].flag"},
                {"operation": "group", "field": "date", "interval": "year", "filters": [
                    {"field": "source_payload.custom[0].score", "operator": "range", "gte": 2}]},
                {"operation": "count", "filters": [
                    {"field": "source_payload.custom[].name", "operator": "eq", "value": "Second"}]},
                {"operation": "count", "filters": [
                    {"field": "source_payload.absent", "operator": "missing"}]},
            ]
            for query in queries:
                with self.subTest(query=query):
                    projected = statistics.query(query)
                    original = baseline.query(query)
                    for result in (projected, original):
                        result.pop("query_as_of")
                        result.pop("evidence")
                    self.assertEqual(projected, original)
                    self.assertNotIn("DO NOT RETURN", json.dumps(projected))
            fields = statistics.query({"operation": "fields", "limit": 1000})
            self.assertIn("source_payload.custom[].name", {r["field"] for r in fields["fields"]})
            self.assertNotIn("DO NOT RETURN", json.dumps(fields))
        finally:
            if created:
                fixture_request("DELETE")


if __name__ == "__main__":
    unittest.main()
