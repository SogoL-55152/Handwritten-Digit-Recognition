"""Single-process W2 server (Waitress), with two bounded inference slots."""
import sys
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parent
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))


def main():
    from waitress import serve
    from app import app
    from services.inference_manifest import REQUEST_MAX_BYTES

    serve(
        app, host=app.config["HOST"], port=app.config["PORT"],
        threads=4, connection_limit=32, backlog=32,
        max_request_body_size=REQUEST_MAX_BYTES,
        max_request_header_size=16 * 1024,
        channel_timeout=30, clear_untrusted_proxy_headers=True,
    )


if __name__ == "__main__":
    main()
