"""Settings, all from the environment. Credentials are read here and never written anywhere."""
import os
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _int(name, default):
    return int(os.environ.get(name, default))


@dataclass
class Config:
    port: int = field(default_factory=lambda: _int("PORT", 8791))
    # Without API_TOKEN (auth off) the server only listens on this machine.
    host: str = field(default_factory=lambda: os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("API_TOKEN") else "127.0.0.1"))
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("DATA_DIR", REPO / "backend" / "data")))
    kit_dir: Path = field(default_factory=lambda: Path(os.environ.get("KIT_DIR", REPO / "scraper-kit")))
    skill: Path = field(default_factory=lambda: REPO / ".agents" / "skills" / "build-source" / "SKILL.md")
    # `devin` (the product), `claude_code` (a local stand-in with the same contract) or `scripted` (tests).
    agent: str = field(default_factory=lambda: os.environ.get("AGENT", "devin"))
    # Recorded results in backend/fixtures/search come first; when none matches: `claude` (the app's Claude web search
    # through the Messages API, server/web_search.py), `devin` (a Devin session, server/devin_search.py), `agent` (a
    # headless Claude Code session), or `fixtures` / `fixture` (no web search: the search fails).
    search: str = field(default_factory=lambda: os.environ.get("SEARCH", "fixtures"))
    search_model: str = field(default_factory=lambda: os.environ.get("SEARCH_MODEL", "claude-opus-5-5"))
    search_timeout: int = field(default_factory=lambda: _int("SEARCH_TIMEOUT_SECONDS", 180))
    # Postgres for products, pages, scrape runs and listings (server/db.py); unset keeps everything in DATA_DIR.
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", ""))
    # Spec §2/§10: one shared team token (unset = auth off, with a warning at start), body and cost caps.
    max_body_bytes: int = field(default_factory=lambda: _int("MAX_BODY_BYTES", 1_000_000))
    max_parallel_searches: int = field(default_factory=lambda: _int("MAX_PARALLEL_SEARCHES", 2))
    max_parallel_scrapes: int = field(default_factory=lambda: _int("MAX_PARALLEL_SCRAPES", 4))
    max_searches_per_day: int = field(default_factory=lambda: _int("MAX_SEARCHES_PER_DAY", 60))
    max_builds_per_day: int = field(default_factory=lambda: _int("MAX_BUILDS_PER_DAY", 20))
    search_cache_hours: float = field(default_factory=lambda: float(os.environ.get("SEARCH_CACHE_HOURS", 6)))
    max_parallel_builds: int = field(default_factory=lambda: _int("MAX_PARALLEL_BUILDS", 4))
    max_attempts: int = field(default_factory=lambda: _int("MAX_ATTEMPTS", 3))
    attempt_minutes: int = field(default_factory=lambda: _int("ATTEMPT_MINUTES", 30))
    # Devin v3: the key stays in this process's environment.
    devin_api: str = field(default_factory=lambda: os.environ.get("DEVIN_API_URL", "https://api.devin.ai/v3"))
    devin_org: str = field(default_factory=lambda: os.environ.get("DEVIN_ORG_ID", ""))
    devin_repo: str = field(default_factory=lambda: os.environ.get("DEVIN_REPO", "HarryGomar/hackathon-devin-shelvin"))
    # The branch Devin starts from and opens its PR against, and the base the backend diffs Devin's branch from.
    devin_base_branch: str = field(default_factory=lambda: os.environ.get("DEVIN_BASE_BRANCH", "main"))
    devin_max_acu: int = field(default_factory=lambda: _int("DEVIN_MAX_ACU", 8))
    devin_mode: str = field(default_factory=lambda: os.environ.get("DEVIN_MODE", ""))
    devin_poll_seconds: int = field(default_factory=lambda: _int("DEVIN_POLL_SECONDS", 12))
    devin_search_max_acu: int = field(default_factory=lambda: _int("DEVIN_SEARCH_MAX_ACU", 2))
    # The gate re-collects the page live (`kit gate --live`); GATE_LIVE=0 runs the offline checks only.
    gate_live: bool = field(default_factory=lambda: os.environ.get("GATE_LIVE", "1") != "0")
    # A clone of DEVIN_REPO the backend fetches Devin's branches into, to gate them before CI merges.
    repo_clone: Path = field(default_factory=lambda: Path(os.environ.get("REPO_CLONE", REPO)))
    claude_bin: str = field(default_factory=lambda: os.environ.get("CLAUDE_BIN", "claude"))
    claude_model: str = field(default_factory=lambda: os.environ.get("CLAUDE_MODEL", "sonnet"))
    claude_budget_usd: str = field(default_factory=lambda: os.environ.get("CLAUDE_BUDGET_USD", "6"))

    @property
    def api_token(self):
        return os.environ.get("API_TOKEN", "")

    @property
    def anthropic_key(self):
        return os.environ.get("ANTHROPIC_API_KEY", "")

    @property
    def devin_key(self):
        return os.environ.get("DEVIN_API_KEY", "")
