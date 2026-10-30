"""A JSON file per record under DATA_DIR. Enough for a small team; one lock for every write."""
import json
import os
import threading
from pathlib import Path


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.RLock()

    def _path(self, kind, key):
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)
        return self.root / kind / f"{safe}.json"

    def get(self, kind, key, default=None):
        path = self._path(kind, key)
        with self.lock:
            if not path.is_file():
                return default
            return json.loads(path.read_text(encoding="utf-8"))

    def put(self, kind, key, value):
        path = self._path(kind, key)
        with self.lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
            os.replace(tmp, path)
        return value

    def delete(self, kind, key):
        with self.lock:
            self._path(kind, key).unlink(missing_ok=True)

    def all(self, kind):
        folder = self.root / kind
        with self.lock:
            if not folder.is_dir():
                return []
            return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(folder.glob("*.json"))]

    def update(self, kind, key, change, default=None):
        """Read, change and write one record under the lock; `change` edits the value in place or returns a new one."""
        with self.lock:
            value = self.get(kind, key, default)
            changed = change(value)
            return self.put(kind, key, value if changed is None else changed)
