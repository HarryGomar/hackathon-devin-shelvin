"""Every source in sources/ passes the offline gate (kit/gate.py): its saved fixture replays into the rows its
expected.json states, and they are plausible. The same gate, with the source run in a child process, runs in the
builder, the backend and CI.
"""
import pytest

from kit import gate
from kit.source import load

SOURCES = load()


@pytest.mark.parametrize("name", sorted(SOURCES))
def test_source_passes_the_offline_gate(name):
    report = gate.check(name)
    assert report["verdict"] == "pass", gate.summary(report)
