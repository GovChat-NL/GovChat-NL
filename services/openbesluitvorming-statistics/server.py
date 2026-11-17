"""Internal authenticated HTTP API. Standard library only, bounded workers."""
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import socket
from socketserver import ThreadingMixIn
import threading

from metadata import Config, QueryError, Statistics, clock
from state import read_status


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def parse_json(data):
    def nonfinite(value):
        raise ValueError("nonfinite_json")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=nonfinite)
    except (ValueError, UnicodeError, RecursionError):
        raise QueryError("invalid_json") from None


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    block_on_close = True
    allow_reuse_address = True

    def __init__(self, address, statistics, token, workers=4, max_request_bytes=32768):
        if not token or workers < 1 or max_request_bytes < 1:
            raise ValueError("authentication_and_positive_limits_required")
        self.statistics, self.token = statistics, token.encode("utf-8")
        self.max_request_bytes = max_request_bytes
        self.slots = threading.BoundedSemaphore(workers)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            body = b'{"error":{"code":"service_busy"},"exact":false,"truncated":false}'
            try:
                request.settimeout(2)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
                # Graceful bounded drain avoids a TCP reset while a client is
                # still transmitting a small POST body (notably on Windows).
                request.shutdown(socket.SHUT_WR)
                request.settimeout(0.1)
                remaining = self.max_request_bytes + 8192
                while remaining > 0:
                    received = request.recv(min(4096, remaining))
                    if not received:
                        break
                    remaining -= len(received)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # No traceback containing payloads, provider URLs or credentials.
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "OBVStatistics/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args):
        # Avoid raw query/path/payload/credential logs entirely.
        pass

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def error(self, error):
        self.reply(error.status, {"error": {"code": error.code}, "exact": False,
                                  "truncated": error.truncated, "query_as_of": clock()})

    def authorized(self):
        values = self.headers.get_all("Authorization", [])
        supplied = values[0][7:].encode("utf-8") if len(values) == 1 and values[0].startswith("Bearer ") else b""
        return hmac.compare_digest(supplied, self.server.token)

    def do_GET(self):
        if self.path == "/healthz":
            self.reply(200, {"status": "ok"})
        elif not self.authorized():
            self.error(QueryError("unauthorized", 401))
        else:
            self.error(QueryError("route_not_found", 404))

    def do_POST(self):
        try:
            if not self.authorized():
                raise QueryError("unauthorized", 401)
            if self.path != "/query":
                raise QueryError("route_not_found", 404)
            if self.headers.get("Transfer-Encoding") is not None or self.headers.get("Content-Encoding") is not None:
                raise QueryError("unsupported_transfer_encoding", 400)
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not lengths[0].isdigit():
                raise QueryError("content_length_required", 411)
            length = int(lengths[0])
            if not 0 < length <= self.server.max_request_bytes:
                raise QueryError("request_size_exceeded", 413)
            if self.headers.get_content_type() != "application/json":
                raise QueryError("application_json_required", 415)
            data = self.rfile.read(length)
            if len(data) != length:
                raise QueryError("incomplete_request")
            self.reply(200, self.server.statistics.query(parse_json(data)))
        except QueryError as error:
            self.error(error)
        except (TimeoutError, OSError):
            self.close_connection = True
        except Exception:
            self.error(QueryError("internal_error", 500))

    def do_PUT(self):
        self.error(QueryError("method_not_allowed" if self.authorized() else "unauthorized", 405 if self.authorized() else 401))

    do_DELETE = do_PUT
    do_PATCH = do_PUT
    do_OPTIONS = do_PUT
    do_HEAD = do_PUT


def main():
    config = Config.environment()
    token = os.environ.get("OBV_STATS_TOKEN") or os.environ.get("N8N_WEBHOOK_TOKEN", "")
    state = os.environ.get("OBV_STATS_STATE_DIR", "/state")
    statistics = Statistics(config, status_reader=lambda: read_status(state, config))
    server = Server((os.environ.get("OBV_STATS_HOST", "0.0.0.0"), int(os.environ.get("OBV_STATS_PORT", "8092"))),
                    statistics, token, int(os.environ.get("OBV_STATS_WORKERS", "4")),
                    int(os.environ.get("OBV_STATS_MAX_REQUEST_BYTES", "32768")))
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
