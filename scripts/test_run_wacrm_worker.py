from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("run-wacrm-worker.py")
SPEC = importlib.util.spec_from_file_location("run_wacrm_worker", SCRIPT)
assert SPEC and SPEC.loader
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def test_external_operations_endpoint_is_registered_without_removing_existing_endpoints() -> None:
    assert worker.ENDPOINTS == (
        "/api/internal/evolution/cron",
        "/api/internal/evolution/reconcile",
        "/api/automations/cron",
        "/api/flows/cron",
        "/api/broadcasts/cron",
        "/api/internal/external-operations/cron",
    )
    assert worker.ENDPOINT_METHODS["/api/internal/external-operations/cron"] == "POST"
    assert worker.ENDPOINT_TIMEOUTS["/api/internal/external-operations/cron"] >= 120


def test_hit_uses_post_only_for_external_operations() -> None:
    response = mock.MagicMock()
    response.__enter__.return_value.status = 200
    response.__enter__.return_value.read.return_value = b"{}"

    with mock.patch.object(worker.urllib.request, "urlopen", return_value=response) as urlopen:
        worker.hit("/api/internal/external-operations/cron", "cron-secret")
        request = urlopen.call_args.args[0]
        assert request.get_method() == "POST"
        assert request.get_header("X-cron-secret") == "cron-secret"

        worker.hit("/api/internal/evolution/cron", "cron-secret")
        request = urlopen.call_args.args[0]
        assert request.get_method() == "GET"
