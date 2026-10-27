from __future__ import annotations

import re
from datetime import date, datetime, timedelta

import pytest
from starlette.testclient import TestClient

from app.utils.anonymize import anonymize_eid

EIDS = ["982 123536700233", "982 123536700478"]
DATA_THROUGH = date(2026, 9, 21)


def fake_fetch_all(query: str, params: tuple = ()):
    if "GROUP BY eid" in query:
        if params[0] != "KF":
            return []
        return [
            {
                "eid": eid,
                "tier": "full",
                "history_days": 30,
                "data_through": DATA_THROUGH,
                "generated_at": datetime(2026, 10, 20, 3, 0),
                "model_version": "xgb-recursive-v1",
            }
            for eid in EIDS
        ]
    if "FROM forecasts" in query:
        return [
            {
                "date": DATA_THROUGH + timedelta(days=h),
                "pred": 500.0 + h,
                "horizon": h,
                "tier": "full",
                "history_days": 30,
                "data_through": DATA_THROUGH,
                "model_version": "xgb-recursive-v1",
                "validated_days": 35,  # not 20: the page must show the stored range, not a constant
                "generated_at": datetime(2026, 10, 20, 3, 0),
            }
            for h in (1, 2, 3)
        ]
    if "FROM animal_data" in query:
        assert params[1] in EIDS, "history must be looked up by the real EID"
        return [{"date": DATA_THROUGH, "finalpweight": 500.0}]
    raise AssertionError(f"unexpected query: {query}")


@pytest.fixture(autouse=True)
def forecast_rows(monkeypatch):
    monkeypatch.setattr("app.routers.forecasts.fetch_all", fake_fetch_all)


def assert_no_real_eid(res) -> None:
    for eid in EIDS:
        assert eid not in res.text


@pytest.mark.integration
def test_admin_lists_real_eids(client: TestClient, admin_headers):
    res = client.get("/api/forecasts/animals", params={"farm_id": "KF"}, headers=admin_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["masked"] is False
    assert [a["id"] for a in body["animals"]] == sorted(EIDS)


@pytest.mark.integration
def test_user_lists_only_masked_ids(client: TestClient, user_headers):
    res = client.get("/api/forecasts/animals", params={"farm_id": "KF"}, headers=user_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["masked"] is True
    assert all(re.match(r"^ID-[0-9A-F]{8}$", a["id"]) for a in body["animals"])
    assert_no_real_eid(res)


@pytest.mark.integration
def test_user_gets_series_by_masked_id(client: TestClient, user_headers):
    mask = anonymize_eid(EIDS[1])
    res = client.get("/api/forecasts/series", params={"farm_id": "KF", "animal": mask}, headers=user_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["animal"] == mask
    assert [f["horizon"] for f in body["forecast"]] == [1, 2, 3]
    assert body["history"] == [{"date": "2026-09-21", "weight": 500.0}]
    assert body["validated_days"] == 35
    assert_no_real_eid(res)


@pytest.mark.integration
def test_admin_gets_series_by_real_eid(client: TestClient, admin_headers):
    res = client.get("/api/forecasts/series", params={"farm_id": "KF", "animal": EIDS[0]}, headers=admin_headers)
    assert res.status_code == 200
    assert res.json()["animal"] == EIDS[0]


@pytest.mark.integration
@pytest.mark.parametrize(
    "role,animal",
    [
        ("user", EIDS[0]),  # a real EID is not accepted from a non-admin
        ("user", "ID-00000000"),  # unknown mask
        ("admin", "mask"),  # admins use real EIDs; replaced with a real mask below
    ],
)
def test_unknown_animal_is_404(client: TestClient, admin_headers, user_headers, role, animal):
    if animal == "mask":
        animal = anonymize_eid(EIDS[0])
    headers = admin_headers if role == "admin" else user_headers
    res = client.get("/api/forecasts/series", params={"farm_id": "KF", "animal": animal}, headers=headers)
    assert res.status_code == 404


@pytest.mark.integration
def test_other_farm_is_403(client: TestClient, user_headers):
    res = client.get("/api/forecasts/animals", params={"farm_id": "DEMO"}, headers=user_headers)
    assert res.status_code == 403


@pytest.mark.integration
def test_missing_forecasts_table_explains_what_to_do(client: TestClient, admin_headers, monkeypatch):
    def missing_table(query, params=()):
        raise RuntimeError('relation "forecasts" does not exist')

    monkeypatch.setattr("app.routers.forecasts.fetch_all", missing_table)
    res = client.get("/api/forecasts/animals", params={"farm_id": "KF"}, headers=admin_headers)
    assert res.status_code == 503
    assert "admin.py forecast" in res.json()["detail"]


@pytest.mark.integration
def test_no_forecasts_yet_tells_admin_how_to_make_them(client: TestClient, admin_headers, monkeypatch):
    monkeypatch.setattr("app.routers.forecasts.fetch_all", lambda q, p=(): [])
    res = client.get("/api/forecasts/animals", params={"farm_id": "KF"}, headers=admin_headers)
    assert res.status_code == 200
    assert res.json()["animals"] == []
    assert "admin.py forecast --farm KF" in res.json()["message"]


@pytest.mark.integration
def test_table_from_before_validated_days_asks_for_a_refresh(client: TestClient, admin_headers, monkeypatch):
    """Postgres before the next refresh: the forecasts table exists but has no validated_days column."""

    def old_table(query, params=()):
        if "validated_days" in query:
            raise RuntimeError('column "validated_days" does not exist\nLINE 2: ... model_version, validated_...')
        return fake_fetch_all(query, params)

    monkeypatch.setattr("app.routers.forecasts.fetch_all", old_table)
    res = client.get("/api/forecasts/series", params={"farm_id": "KF", "animal": EIDS[0]}, headers=admin_headers)
    assert res.status_code == 503
    assert "admin.py forecast" in res.json()["detail"]


@pytest.mark.integration
def test_rows_from_before_validated_days_ask_for_a_refresh(client: TestClient, admin_headers, monkeypatch):
    """After the column is added, a farm that has not been refreshed yet still has NULL there."""

    def old_rows(query, params=()):
        rows = fake_fetch_all(query, params)
        if "validated_days" in query:
            rows = [{**r, "validated_days": None} for r in rows]
        return rows

    monkeypatch.setattr("app.routers.forecasts.fetch_all", old_rows)
    res = client.get("/api/forecasts/series", params={"farm_id": "KF", "animal": EIDS[0]}, headers=admin_headers)
    assert res.status_code == 503
    assert "older version" in res.json()["detail"]
