import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
FIXTURES = Path(__file__).resolve().parent / "fixtures"

from aetos_leads import store  # noqa: E402  (needs the path above)


class FakeD1:
    """The D1 HTTP client's query() over an in-memory SQLite with the real schema."""

    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(store.SCHEMA)

    def query(self, sql, params=None):
        cur = self.db.execute(sql, params or [])
        self.db.commit()
        return {"success": True, "result": [{"results": [dict(r) for r in cur.fetchall()]}]}

    def ensure_schema(self):
        pass
