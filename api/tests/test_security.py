from __future__ import annotations

import asyncio

import depgraph.app as app_module


def test_security_headers_are_present(built_client):
    response = built_client.get("/tree/not-yet-crawled", params={"version": "1.0.0"})
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["strict-transport-security"].startswith("max-age=")


def test_invalid_package_name_is_rejected_before_registry_work(built_client):
    response = built_client.post("/crawl//etc/passwd", params={"version": "1.0.0"})
    assert response.status_code in {404, 422}


def test_busy_crawler_fails_fast_instead_of_queueing_unbounded_work(built_client, monkeypatch):
    monkeypatch.setattr(app_module, "_crawl_slots", asyncio.Semaphore(0))
    monkeypatch.setattr(app_module, "_CRAWL_ACQUIRE_TIMEOUT_SECONDS", 0.01)

    response = built_client.post("/crawl/example", params={"version": "1.0.0"})

    assert response.status_code == 429
    assert response.headers["retry-after"] == "2"
    assert response.json()["detail"] == "Crawler is busy. Try again shortly."
