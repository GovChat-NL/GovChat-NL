"""Bounded, read-only metadata queries; no facet indexes or user Qdrant DSL."""
import datetime as dt
import json
import math
import os
import re
import time
import copy
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache

UTC = dt.timezone.utc
PATH = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*(?:\[(?:[0-9]+)?\])*(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[(?:[0-9]+)?\])*)*\Z")
PART = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*)|\[([0-9]*)\]")
BLOCKED = {"fulltext", "contentpreview", "markdowntext", "vector", "vectors",
           "embedding", "embeddings", "binary", "base64", "password", "secret",
           "token", "apikey", "authorization", "credentials", "accesstoken",
           "text", "content", "chunks", "textchunks", "ocrtext", "extractedtext", "markdown", "derivedcontent"}
DATE_PATHS = ("date", "entity_detail.sortDate", "source_payload.date",
              "source_payload.last_discussed_at", "source_payload.date_modified",
              "last_discussed_at", "date_modified")
TYPE_PATHS = ("document_type", "documentType", "entity_detail.documentType", "entity_detail.document_type",
              "source_payload.documentType", "source_payload.document_type",
              "classification", "source_payload.classification")


class QueryError(Exception):
    def __init__(self, code, status=400, truncated=False):
        self.code, self.status, self.truncated = code, status, truncated
        super().__init__(code)


def clock():
    return dt.datetime.now(UTC).isoformat().replace("+00:00", "Z")


@lru_cache(maxsize=4096)
def blocked(key):
    return re.sub(r"[^a-z0-9]", "", key.lower()) in BLOCKED


def path_parts(path):
    if not isinstance(path, str) or len(path) > 200:
        raise QueryError("invalid_field_path")
    return validated_path_parts(path)


@lru_cache(maxsize=20000)
def validated_path_parts(path):
    # Cache schema/path syntax, never payloads, values or query results. This avoids
    # repeated regex work when discovering the same fields across a large corpus.
    if not PATH.fullmatch(path):
        raise QueryError("invalid_field_path")
    parts = [(m.group(1) if m.group(1) else
              (int(m.group(2)) if m.group(2) else None)) for m in PART.finditer(path)]
    if len(parts) > 20 or any(blocked(p) for p in parts if isinstance(p, str)):
        raise QueryError("not_metadata_field")
    return tuple(parts)


def raw_values(payload, path):
    nodes = [payload]
    for part in path_parts(path):
        following = []
        for node in nodes:
            if isinstance(part, str) and isinstance(node, dict) and part in node:
                following.append(node[part])
            elif part is None and isinstance(node, list):
                following.extend(node)
            elif isinstance(part, int) and isinstance(node, list) and part < len(node):
                following.append(node[part])
        nodes = following
    return nodes


def scalar_values(nodes):
    result = []
    for node in nodes:
        if isinstance(node, list):
            result.extend(scalar_values(node))
        else:
            result.append(node)
    return result


def values(payload, path):
    aliases = DATE_PATHS if path in ("date", "year") else TYPE_PATHS if path == "document_type" else None
    if aliases:
        fallback = []
        for candidate in aliases:
            result = scalar_values(raw_values(payload, candidate))
            if not fallback and result:
                fallback = result
            if any(v is not None and v != "" for v in result):
                return result
        return fallback
    return scalar_values(raw_values(payload, path))


def present(payload, path):
    paths = DATE_PATHS if path in ("date", "year") else TYPE_PATHS if path == "document_type" else (path,)
    return any(bool(raw_values(payload, candidate)) for candidate in paths)


def date_value(value):
    """ISO calendar date or timezone-aware ISO datetime only; no epoch guesses."""
    if not isinstance(value, str):
        raise ValueError("not_date")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return dt.datetime.combine(dt.date.fromisoformat(value), dt.time(), UTC)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("not_timezone_iso")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def scalar_key(value):
    if value is None:
        return ("null", "null")
    if type(value) is bool:
        return ("boolean", "true" if value else "false")
    if type(value) in (int, float) and math.isfinite(value):
        # JSON numbers compare numerically, but never equal booleans.
        return ("number", str(int(value)) if value == int(value) else repr(value))
    if isinstance(value, str):
        return ("string", value)
    raise ValueError("non_scalar")


def scalar_input(value):
    if isinstance(value, str) and len(value) > 4096:
        raise QueryError("filter_value_budget_exceeded")
    try:
        scalar_key(value)
    except (ValueError, OverflowError):
        raise QueryError("invalid_filter_value") from None
    return value


def validate_query(query):
    allowed = {"operation", "field", "interval", "filters", "limit", "offset"}
    if not isinstance(query, dict) or set(query) - allowed:
        raise QueryError("invalid_query_arguments")
    operation = query.get("operation")
    if operation not in ("fields", "count", "group", "status", "overview"):
        raise QueryError("invalid_operation")
    result = dict(query)
    field = result.get("field")
    if operation == "group":
        path_parts(field)
    elif field is not None:
        raise QueryError("field_only_for_group")
    interval = result.get("interval")
    if interval not in (None, "year", "month") or interval and operation != "group":
        raise QueryError("invalid_interval")
    result["interval"] = "year" if field == "year" and interval is None else interval
    for name, default, maximum in (("limit", 100, 1000), ("offset", 0, 1000000)):
        value = result.get(name, default)
        if type(value) is not int or value < (1 if name == "limit" else 0) or value > maximum:
            raise QueryError("invalid_pagination")
        result[name] = value
    filters = result.get("filters", [])
    if not isinstance(filters, list) or len(filters) > 32 or operation == "status" and filters:
        raise QueryError("invalid_filters")
    for item in filters:
        if not isinstance(item, dict):
            raise QueryError("invalid_filter")
        path_parts(item.get("field"))
        op = item.get("operator")
        keys = {"field", "operator"}
        if op == "eq":
            keys.add("value")
            if "value" not in item:
                raise QueryError("missing_filter_value")
            scalar_input(item["value"])
        elif op == "in":
            keys.add("values")
            if not isinstance(item.get("values"), list) or not 1 <= len(item["values"]) <= 100:
                raise QueryError("invalid_in_values")
            for value in item["values"]:
                scalar_input(value)
        elif op == "range":
            keys.update(("gt", "gte", "lt", "lte"))
            bounds = [item[k] for k in ("gt", "gte", "lt", "lte") if k in item]
            if not bounds or {"gt", "gte"} <= set(item) or {"lt", "lte"} <= set(item):
                raise QueryError("invalid_range")
            try:
                if all(type(v) in (int, float) for v in bounds):
                    for value in bounds:
                        scalar_input(value)
                else:
                    for value in bounds:
                        date_value(value)
            except ValueError:
                raise QueryError("range_requires_numbers_or_iso_dates") from None
        elif op not in ("exists", "missing"):
            raise QueryError("invalid_operator")
        if set(item) - keys:
            raise QueryError("invalid_filter_arguments")
    result["filters"] = filters
    return result


def matches(payload, item):
    field, op = item["field"], item["operator"]
    nodes = values(payload, field)
    is_present = present(payload, field)
    if op in ("exists", "missing"):
        return is_present if op == "exists" else not is_present
    if op in ("eq", "in"):
        wanted = {scalar_key(v) for v in ([item["value"]] if op == "eq" else item["values"])}
        for value in nodes:
            try:
                if scalar_key(value) in wanted:
                    return True
            except ValueError:
                pass
        return False
    bounds = {k: item[k] for k in ("gt", "gte", "lt", "lte") if k in item}
    dates = isinstance(next(iter(bounds.values())), str)
    if dates:
        bounds = {k: date_value(v) for k, v in bounds.items()}
    for value in nodes:
        try:
            if dates:
                value = date_value(value)
            elif type(value) not in (int, float) or not math.isfinite(value):
                continue
            if all({"gt": value > bound, "gte": value >= bound,
                    "lt": value < bound, "lte": value <= bound}[key] for key, bound in bounds.items()):
                return True
        except ValueError:
            continue
    return False


def discover(node, path="", depth=0):
    if depth > 20:
        raise QueryError("metadata_depth_budget_exceeded", 422, True)
    if path:
        yield path, ("null" if node is None else "object" if isinstance(node, dict) else
                     "array" if isinstance(node, list) else scalar_key(node)[0])
    if isinstance(node, dict):
        for key, value in node.items():
            if blocked(key):
                continue
            child = f"{path}.{key}" if path else key
            try:
                path_parts(child)
            except QueryError:
                # Unaddressable keys cannot be exposed as a falsely queryable path.
                raise QueryError("unaddressable_metadata_key", 422, True) from None
            yield from discover(value, child, depth + 1)
    elif isinstance(node, list):
        for value in node:
            yield from discover(value, path + "[]", depth + 1)


@dataclass(frozen=True)
class Config:
    url: str = "http://qdrant:6333"
    collection: str = "limburg_full_20261111"
    run_id: str = "limburg-full-20261111"
    source: str = "provincie_limburg"
    api_key: str = ""
    page_size: int = 256
    max_page_size: int = 1000
    target_page_bytes: int = 4 * 1024 * 1024
    max_pages: int = 2000
    max_documents: int = 250000
    max_seconds: float = 180
    http_timeout: float = 20
    max_groups: int = 100000
    max_fields: int = 20000
    max_group_bytes: int = 32 * 1024 * 1024
    canonical_date_field: str = ""
    canonical_type_field: str = ""

    @classmethod
    def environment(cls):
        defaults = cls()
        strings = {"url": "OBV_QDRANT_URL", "collection": "OBV_STATS_COLLECTION",
                   "run_id": "OBV_STATS_RUN_ID", "source": "OBV_STATS_SOURCE_KEY",
                   "api_key": "OBV_QDRANT_API_KEY", "canonical_date_field": "OBV_CANONICAL_DATE_FIELD",
                   "canonical_type_field": "OBV_CANONICAL_TYPE_FIELD"}
        options = {k: os.environ.get(v, getattr(defaults, k)) for k, v in strings.items()}
        for key in ("page_size", "max_page_size", "target_page_bytes", "max_pages", "max_documents", "max_seconds", "http_timeout", "max_groups", "max_fields", "max_group_bytes"):
            options[key] = type(getattr(defaults, key))(os.environ.get("OBV_STATS_" + key.upper(), getattr(defaults, key)))
        config = cls(**options)
        parsed = urllib.parse.urlsplit(config.url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
            raise ValueError("invalid_server_qdrant_url")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", config.collection) or not config.run_id or not config.source:
            raise ValueError("invalid_server_scope")
        if any(getattr(config, k) <= 0 for k in ("page_size", "max_page_size", "target_page_bytes", "max_pages", "max_documents", "max_seconds", "http_timeout", "max_groups", "max_fields", "max_group_bytes")) or not config.page_size <= config.max_page_size <= 1000 or config.target_page_bytes > 8 * 1024 * 1024:
            raise ValueError("invalid_server_budget")
        if config.canonical_date_field not in ("", "date"):
            raise ValueError("invalid_optimization_config")
        if config.canonical_type_field not in ("", "document_type", "classification"):
            raise ValueError("invalid_canonical_type_field")
        return config


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Qdrant:
    def __init__(self, config):
        self.config = config
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, operation, body, timeout):
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["api-key"] = self.config.api_key
        route = "/facet" if operation == "facet" else "/points/" + operation
        url = self.config.url.rstrip("/") + "/collections/" + self.config.collection + route
        request = urllib.request.Request(url, json.dumps(body).encode(), headers, method="POST")
        try:
            with self.opener.open(request, timeout=timeout) as response:
                data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise QueryError("qdrant_response_budget_exceeded", 502, True)
            result = json.loads(data)
            if not isinstance(result, dict) or result.get("status") != "ok":
                raise ValueError("qdrant_status")
            return result["result"]
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, TypeError, RecursionError):
            raise QueryError("qdrant_unavailable_or_invalid_response", 502) from None


def payload_exclusions():
    # Known content locations are excluded remotely; discovery never exposes
    # blocked keys at any depth. Qdrant does not support a recursive key wildcard.
    roots = ("", "source_payload.", "source_record.payload.", "entity_detail.", "reference_detail.")
    names = ("full_text", "content_preview", "markdownText", "derived_content.markdownText",
             "vector", "vectors", "embedding", "embeddings", "binary", "base64",
             "password", "secret", "token", "api_key", "authorization", "credentials",
             "text", "content", "chunks", "text_chunks", "ocr_text", "extracted_text", "markdown", "markdown_text", "derived_content")
    return [root + name for root in roots for name in names]


def query_payload_selector(operation, needed):
    """Project dependencies, retaining array containers for exact traversal.

    Fixed aliases expand to all candidates so precedence/null semantics survive.
    Selecting the container before the first array index preserves positions,
    empty arrays and object membership across Qdrant selector versions.
    Discovery needs all safe metadata and retains the content-exclusion selector.
    """
    if operation in ("fields", "overview"):
        return {"exclude": payload_exclusions()}
    selected = {"source_id", "source_key", "ingest_run_id", "entity_type"}
    for path in needed:
        paths = DATE_PATHS if path in ("date", "year") else TYPE_PATHS if path == "document_type" else (path,)
        selected.update(candidate.split("[", 1)[0] for candidate in paths)
    return {"include": sorted(selected)}


def native_filters(filters, canonical_date_field="", canonical_type_field=""):
    """Only Qdrant keyword/bool match conditions with equivalent semantics.

    Null, exists/missing, aliases, dates and indexed-array paths deliberately use
    the evaluator. No user-provided Qdrant condition ever crosses this boundary.
    """
    conditions = []
    for item in filters:
        path = item["field"]
        if canonical_type_field and path == "document_type" and item["operator"] in ("eq", "in"):
            vals = [item["value"]] if item["operator"] == "eq" else item["values"]
            if not all(isinstance(value, str) for value in vals):
                return None
            conditions.append({"key": canonical_type_field, "match": {"value": vals[0]} if item["operator"] == "eq" else {"any": vals}})
            continue
        if canonical_date_field == "date" and path == "date" and item["operator"] == "range":
            conditions.append({"key": "date", "range": {key: date_value(value).isoformat() for key, value in item.items() if key in ("gt", "gte", "lt", "lte")}})
            continue
        if path in ("date", "year", "document_type") or "[" in path:
            return None
        if item["operator"] not in ("eq", "in"):
            return None
        values_ = [item["value"]] if item["operator"] == "eq" else item["values"]
        # Qdrant integer match need not match legacy JSON floating-point 0.0;
        # our numeric semantics deliberately treat 0 and 0.0 as equal.
        if not all(type(v) in (str, bool) for v in values_):
            return None
        # Mixed-type/boolean match-any support differs across Qdrant versions.
        if item["operator"] == "in" and (len({type(v) for v in values_}) != 1 or type(values_[0]) is bool):
            return None
        conditions.append({"key": path, "match": {"value": values_[0]} if item["operator"] == "eq" else {"any": values_}})
    return conditions


class Statistics:
    def __init__(self, config, client=None, status_reader=None, revision_reader=None):
        self.config = config
        self.client = client or Qdrant(config)
        self.status_reader = status_reader
        self.revision_reader = revision_reader or status_reader
        self._cache = {}
        self._cache_lock = threading.Lock()
        self._precompute_revision = None

    def precompute(self, stop):
        """Prepare common metadata views once per settled ingest revision."""
        queries = [{"operation": "group", "field": "date", "interval": "year", "limit": 1000},
                   {"operation": "group", "field": "date", "interval": "month", "limit": 1000},
                   {"operation": "group", "field": "document_type", "limit": 1000}]
        while not stop.is_set():
            state = self.revision_reader() if self.revision_reader else {}
            revision = state.get("dataset_revision") if state.get("ingest_in_progress") is False else None
            if revision and revision != self._precompute_revision:
                for query in queries:
                    if stop.is_set():
                        return
                    current = self.revision_reader()
                    if current.get("dataset_revision") != revision or current.get("ingest_in_progress") is not False:
                        break
                    try:
                        self.query(query)
                    except QueryError:
                        pass
                # Do not repeatedly rescan a problematic field for the same
                # revision. An explicit request can retry it; a new import
                # schedules a new preparation automatically.
                self._precompute_revision = revision
            # Poll only the cheap ingest checkpoint, never the corpus. This is
            # change detection, not an expiry time for the computed values.
            stop.wait(15)

    def query(self, arguments):
        query = validate_query(arguments)
        state = self.revision_reader() if self.revision_reader and query["operation"] != "status" else {}
        revision = state.get("dataset_revision") if state.get("available") and state.get("ingest_in_progress") is False else None
        catalog_file = os.environ.get("OBV_STATS_CATALOG_FILE")
        if catalog_file and query["operation"] != "status" and not query["filters"]:
            from catalog import prepared_query
            prepared = prepared_query(catalog_file, self.config, query, revision)
            if prepared is not None:
                if query["operation"] == "overview":
                    prepared["status"] = self.status_reader() if self.status_reader else {"available": False}
                return prepared
            if os.environ.get("OBV_STATS_REQUIRE_CATALOG", "false").lower() == "true":
                raise QueryError("metadata_catalog_not_ready", 409, True)
        key = (revision, json.dumps({k:v for k,v in query.items() if k not in ("limit", "offset")}, sort_keys=True, separators=(",", ":")))
        if revision and query["operation"] in ("fields", "group", "overview"):
            with self._cache_lock:
                entry = self._cache.get(key)
            if entry is not None:
                result = copy.deepcopy(entry)
                result.update(cached=True, dataset_revision=revision, ingest_in_progress=False)
                list_key = "groups" if query["operation"] == "group" else "fields"
                values_ = result.get(list_key, [])
                offset, limit = query["offset"], query["limit"]
                result[list_key] = values_[offset:offset + limit]
                result.update(limit=limit, offset=offset)
                result[list_key + "_paginated"] = len(values_) > offset + limit or offset > 0
                result["cached_scanned_documents"] = result.get("scanned_documents", 0)
                result["scanned_documents"] = 0
                return result
        result = self._query(query)
        result["dataset_revision"] = revision
        result["ingest_in_progress"] = state.get("ingest_in_progress")
        if state.get("ingest_in_progress") is True:
            result.setdefault("coverage", {})["dataset_changing"] = True
            if result.get("evidence", {}).get("method") != "native_exact_count":
                result["exact"] = False
                result["consistency_notice"] = "Import actief: dit overzicht is geen gegarandeerd stabiele datasetversie."
        if revision and query["operation"] in ("fields", "group", "overview") and result.get("exact") and not result.get("truncated"):
            after = self.revision_reader()
            if after.get("dataset_revision") != revision or after.get("ingest_in_progress") is not False:
                result["exact"] = False
                result["consistency_notice"] = "Dataset gewijzigd tijdens de berekening; dit resultaat is niet aan een stabiele importversie gekoppeld."
            complete = query["offset"] == 0 and not result.get("groups_paginated", False) and not result.get("fields_paginated", False)
            if complete and after.get("dataset_revision") == revision and after.get("ingest_in_progress") is False and len(json.dumps(result)) <= 1024 * 1024:
                with self._cache_lock:
                    self._cache = {k: v for k, v in self._cache.items() if k[0] == revision}
                    if len(self._cache) >= 16:
                        self._cache.pop(next(iter(self._cache)))
                    self._cache[key] = copy.deepcopy(result)
        return result

    def _query(self, arguments):
        query = validate_query(arguments)
        start, as_of = time.monotonic(), clock()
        config = self.config
        base = {"operation": query["operation"], "source_kind": "qdrant_exact_metadata",
                "scope": {"collection": config.collection, "run_id": config.run_id, "source_key": config.source},
                "query_as_of": as_of, "cached": False, "exact": True, "truncated": False}
        if query["operation"] == "status":
            base["source_kind"] = "sqlite_readonly_checkpoint"
            base["status"] = self.status_reader() if self.status_reader else {"available": False, "reason": "state_not_configured"}
            base["exact"] = base["status"]["available"]
            base["evidence"] = {"observed_at": clock(), "timestamp_basis": "runs.updated_at; never indexed_at"}
            return base

        def request(operation, body):
            remaining = config.max_seconds - (time.monotonic() - start)
            if remaining <= 0:
                raise QueryError("scan_time_budget_exceeded", 422, True)
            return self.client.request(operation, body, min(config.http_timeout, remaining))

        scope = {"must": [{"key": k, "match": {"value": v}} for k, v in
                           (("source_key", config.source), ("ingest_run_id", config.run_id), ("entity_type", "Document"))]}
        def count():
            result = request("count", {"filter": scope, "exact": True})
            value = result.get("count") if isinstance(result, dict) else None
            if type(value) is not int or value < 0:
                raise QueryError("invalid_qdrant_count", 502)
            return value

        before = count()
        compiled = native_filters(query["filters"], config.canonical_date_field, config.canonical_type_field)
        if query["operation"] == "group" and query["field"] == "document_type" and query["interval"] is None and config.canonical_type_field and compiled is not None:
            native_scope = {"must": scope["must"] + compiled}
            matched = request("count", {"filter": native_scope, "exact": True}).get("count")
            facet = request("facet", {"key": config.canonical_type_field, "filter": native_scope, "limit": 1000, "exact": True})
            hits = facet.get("hits")
            if not isinstance(hits, list) or len(hits) >= 1000:
                raise QueryError("document_type_facet_budget_exceeded", 422, True)
            if any(not isinstance(hit, dict) or not isinstance(hit.get("value"), str) or type(hit.get("count")) is not int or hit["count"] < 0 for hit in hits):
                raise QueryError("invalid_document_type_facet", 502)
            with_value = request("count", {"filter": {**native_scope, "must_not": [{"is_empty": {"key": config.canonical_type_field}}]}, "exact": True}).get("count")
            if type(matched) is not int or type(with_value) is not int or not 0 <= with_value <= matched <= before or before != count():
                raise QueryError("scope_changed_during_facet", 409, True)
            groups = [{"value": hit["value"], "value_type": "string", "count": hit["count"]} for hit in hits]
            groups.sort(key=lambda item: (-item["count"], item["value"]))
            memberships = sum(item["count"] for item in groups)
            base.update(total_documents=before, matched_documents=matched, scanned_documents=0, skipped_documents=0,
                        field="document_type", source_field=config.canonical_type_field, interval=None,
                        groups=groups[query["offset"]:query["offset"] + query["limit"]], total_groups=len(groups),
                        groups_paginated=query["offset"] > 0 or len(groups) > query["offset"] + query["limit"],
                        limit=query["limit"], offset=query["offset"], missing_documents=matched-with_value,
                        invalid_documents=0, null_documents=0, documents_with_value=with_value,
                        overlap_documents=None, group_memberships=memberships,
                        semantics="Unieke bestaande classificatie/typewaarden; meerdere labels per document kunnen overlappen.",
                        coverage={"basis": "indexed Qdrant documents in configured scope only", "source_complete": None},
                        evidence={"method": "native_exact_facet", "native_point_count_before": before, "native_point_count_after": before,
                                  "consistency": "count-checked facet; same-count concurrent edits cannot be detected"})
            return base
        if query["operation"] == "count" and compiled is not None:
            matched = before
            if compiled:
                result = request("count", {"exact": True, "filter": {"must": scope["must"] + compiled}})
                matched = result.get("count") if isinstance(result, dict) else None
                if type(matched) is not int or not 0 <= matched <= before:
                    raise QueryError("invalid_qdrant_count", 502)
            after = count()
            if before != after:
                raise QueryError("scope_changed_during_count", 409, True)
            base.update(total_documents=before, matched_documents=matched, scanned_documents=0,
                        skipped_documents=0,
                        coverage={"basis": "indexed Qdrant documents in configured scope only",
                                  "source_complete": None, "failed_source_documents_included": False},
                        evidence={"method": "native_exact_count", "observed_at": clock(),
                                  "native_point_count_before": before, "native_point_count_after": after,
                                  "document_identity": "worker invariant: one deterministic point per source document",
                                  "consistency": "non-transactional; same-count concurrent edits cannot be detected"})
            return base
        seen, point_ids, offsets = set(), set(), set()
        rows, schema, schema_types = Counter(), Counter(), {}
        scanned = matched = skipped = missing = invalid = overlap = with_value = nulls = 0
        group_bytes = 0
        offset = None
        operation = query["operation"]
        field = query.get("field")
        needed = {f["field"] for f in query["filters"]}
        if field:
            needed.add(field)
        selector = query_payload_selector(operation, needed)
        page_limit = config.page_size
        scroll_requests = 0
        for page in range(config.max_pages):
            body = {"filter": scope, "limit": page_limit, "with_vector": False, "with_payload": selector}
            if offset is not None:
                body["offset"] = offset
            while True:
                try:
                    scroll_requests += 1
                    result = request("scroll", body)
                    break
                except QueryError as error:
                    # An unusually large page must not disable exact queries.
                    # Retry the same offset, before accepting any points, within
                    # the existing scan deadline; never return partial counts.
                    if error.code != "qdrant_response_budget_exceeded" or page_limit == 1:
                        raise
                    page_limit = max(1, page_limit // 2)
                    body["limit"] = page_limit
            if not isinstance(result, dict) or not isinstance(result.get("points"), list):
                raise QueryError("invalid_qdrant_scroll", 502)
            for point in result["points"]:
                scanned += 1
                if scanned > config.max_documents:
                    raise QueryError("scan_document_budget_exceeded", 422, True)
                if not isinstance(point, dict) or not isinstance(point.get("payload"), dict):
                    raise QueryError("invalid_qdrant_point", 502)
                p = point["payload"]
                if any(p.get(k) != v for k, v in (("source_key", config.source), ("ingest_run_id", config.run_id), ("entity_type", "Document"))):
                    skipped += 1
                    continue
                pid = point.get("id")
                if type(pid) not in (str, int) or pid in point_ids:
                    raise QueryError("unstable_scroll_duplicate_point", 409, True)
                point_ids.add(pid)
                source_id = p.get("source_id")
                identity = ("source", source_id) if isinstance(source_id, str) and source_id else ("point", pid)
                if identity in seen:
                    # Different payloads for one document cannot be arbitrarily
                    # resolved while claiming exact filter/group semantics.
                    raise QueryError("duplicate_source_document", 409, True)
                seen.add(identity)
                if not all(matches(p, f) for f in query["filters"]):
                    continue
                matched += 1
                if operation in ("fields", "overview"):
                    found = set()
                    try:
                        for name, kind in discover(p):
                            found.add(name)
                            schema_types.setdefault(name, set()).add(kind)
                            if len(schema_types) > config.max_fields:
                                raise QueryError("schema_field_budget_exceeded", 422, True)
                    except ValueError:
                        raise QueryError("invalid_metadata_scalar", 422, True) from None
                    schema.update(found)
                if operation == "group":
                    nodes = values(p, field)
                    is_present = present(p, field)
                    keys, bad, has_null = set(), False, False
                    for value in nodes:
                        if value is None:
                            has_null = True
                            continue
                        try:
                            if query["interval"]:
                                parsed = date_value(value)
                                value = f"{parsed.year:04d}" if query["interval"] == "year" else f"{parsed.year:04d}-{parsed.month:02d}"
                            keys.add(scalar_key(value))
                        except ValueError:
                            bad = True
                    missing += int(not is_present)
                    invalid += int(bad)
                    nulls += int(has_null)
                    with_value += int(bool(keys))
                    overlap += int(len(keys) > 1)
                    for key in keys:
                        if key not in rows:
                            group_bytes += len(key[1].encode("utf-8")) + 128
                            if group_bytes > config.max_group_bytes:
                                raise QueryError("group_value_memory_budget_exceeded", 422, True)
                    rows.update(keys)
                    if len(rows) > config.max_groups:
                        raise QueryError("group_cardinality_budget_exceeded", 422, True)
            next_offset = result.get("next_page_offset")
            if next_offset is None:
                break
            if not result["points"] or type(next_offset) not in (str, int) or next_offset in offsets:
                raise QueryError("unstable_scroll_offset", 409, True)
            offsets.add(next_offset)
            offset = next_offset
            if "include" in selector:
                # Adapt from observed serialized bytes, not guessed field size.
                # Larger batches reduce repeated unindexed-filter work; large
                # arrays/strings shrink batches instead. Keep ample headroom
                # below the hard 16 MiB transport cap; outliers retry above.
                size = len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                page_limit = max(1, min(config.max_page_size,
                    len(result["points"]) * config.target_page_bytes // max(1, size * 2)))
        else:
            raise QueryError("scan_page_budget_exceeded", 422, True)
        after = count()
        if before != after or scanned != before or skipped:
            raise QueryError("scope_changed_during_scan", 409, True)
        base.update(total_documents=len(seen), matched_documents=matched, scanned_documents=scanned,
                    skipped_documents=skipped,
                    coverage={"basis": "indexed Qdrant documents in configured scope only",
                              "source_complete": None, "failed_source_documents_included": False},
                    evidence={"scan_started_at": as_of, "scan_finished_at": clock(),
                              "native_point_count_before": before, "native_point_count_after": after,
                              "scroll_requests": scroll_requests,
                              "payload_selection": "projected_dependencies" if "include" in selector else "safe_metadata_discovery",
                              "consistency": "non-transactional scroll; counts checked before/after; same-count concurrent edits cannot be detected"})
        if operation == "group":
            ordered = sorted(rows.items(), key=lambda row: (-row[1], row[0]))
            groups = [{"value": json.loads(key[1]) if key[0] != "string" else key[1],
                       "value_type": key[0], "count": n} for key, n in ordered]
            base.update(field=field, interval=query["interval"], groups=groups[query["offset"]:query["offset"] + query["limit"]],
                        total_groups=len(groups), groups_paginated=len(groups) > query["offset"] + query["limit"] or query["offset"] > 0,
                        limit=query["limit"], offset=query["offset"], missing_documents=missing,
                        invalid_documents=invalid, null_documents=nulls, documents_with_value=with_value,
                        overlap_documents=overlap, group_memberships=sum(rows.values()),
                        semantics="Each distinct value counts a document once; arrays may overlap. Row sums are memberships, not an exclusive document total. Null/invalid buckets may overlap valid values; missing means absent path; empty arrays exist with no values.")
        if operation in ("fields", "overview"):
            names = sorted(schema)
            base.update(fields=[{"field": name, "types": sorted(schema_types[name]),
                                 "present_documents": schema[name], "missing_documents": matched - schema[name]}
                                for name in names[query["offset"]:query["offset"] + query["limit"]]],
                        total_fields=len(names), fields_paginated=len(names) > query["offset"] + query["limit"] or query["offset"] > 0,
                        limit=query["limit"], offset=query["offset"],
                        excluded_field_categories=["document content (full_text, content_preview, markdownText)", "binary/vectors", "credential keys"],
                        aliases={"date": list(DATE_PATHS), "year": "date grouped by UTC calendar year",
                                 "document_type": list(TYPE_PATHS)},
                        alias_semantics="First nonempty candidate wins; documentType precedes classification. Raw paths remain queryable.")
        if operation == "overview":
            base["status"] = self.status_reader() if self.status_reader else {"available": False, "reason": "state_not_configured"}
        return base
