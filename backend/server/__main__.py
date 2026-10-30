"""`uv run python -m server`: serve the API on PORT (default 8791). `uv run python -m server check`: is everything
ready for a real Devin build (nothing is started or spent)."""
import sys

from . import preflight
from .app import serve
from .config import Config


def main():
    config = Config()
    if sys.argv[1:] == ["check"]:
        sys.exit(preflight.main(config))
    server, service = serve(config)
    print(f"Shelvin backend on :{config.port}  agent={service.builds.runner.provider}  "
          f"search={config.search}  parallel builds={config.max_parallel_builds}  "
          f"sources={sorted(service.kit.sources())}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
