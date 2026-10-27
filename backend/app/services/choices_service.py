"""Filter dropdown choices — SQL only, no pandas."""
from __future__ import annotations

from app.constants import MEASURE_LABELS, MONTH_NAMES


def get_filter_choices(farm_id: str, is_admin: bool) -> dict:
    from app.db import fetch_one

    meta = fetch_one(
        """
        SELECT
          COUNT(*)::int AS cnt,
          ARRAY(
            SELECT DISTINCT EXTRACT(YEAR FROM date)::int
            FROM animal_data
            WHERE farm_id = %s
            ORDER BY 1 DESC
          ) AS years
        FROM animal_data
        WHERE farm_id = %s
        """,
        (farm_id, farm_id),
    ) or {}

    dims = fetch_one(
        """
        SELECT
          ARRAY(SELECT DISTINCT sex FROM animal_data WHERE farm_id = %s AND sex IS NOT NULL ORDER BY 1) AS sexes,
          ARRAY(SELECT DISTINCT treatment FROM animal_data WHERE farm_id = %s AND treatment IS NOT NULL ORDER BY 1) AS treatments,
          ARRAY(SELECT DISTINCT breed FROM animal_data WHERE farm_id = %s AND breed IS NOT NULL ORDER BY 1) AS breeds,
          ARRAY(SELECT DISTINCT mob FROM animal_data WHERE farm_id = %s AND mob IS NOT NULL ORDER BY 1) AS mobs,
          ARRAY(SELECT DISTINCT eid FROM animal_data WHERE farm_id = %s AND eid IS NOT NULL ORDER BY 1) AS eids
        """,
        (farm_id, farm_id, farm_id, farm_id, farm_id),
    ) or {}

    year_list = list(meta.get("years") or [])
    max_year = year_list[0] if year_list else None
    sexes = list(dims.get("sexes") or [])
    treatments_raw = [t for t in (dims.get("treatments") or []) if t]
    breeds = list(dims.get("breeds") or [])
    mobs = list(dims.get("mobs") or [])
    eids = list(dims.get("eids") or [])

    active_data = get_active_herd_counts(farm_id)

    result = {
        "years": year_list,
        "months": MONTH_NAMES,
        "days": ["All"] + list(range(1, 32)),
        "sexes": ["Overall"] + sexes,
        "treatments": ["Overall", "No Treatment"] + treatments_raw,
        "breeds": ["Overall"] + breeds,
        "mobs": ["Overall"] + mobs,
        "max_year": max_year,
        "measures": [{"key": k, "label": MEASURE_LABELS[k]} for k in MEASURE_LABELS],
        "total_records": int(meta.get("cnt") or 0),
        "total_animal_count": active_data["total_animal_count"],
        "active_animal_count": active_data["active_animal_count"],
        "active_counts": active_data["active_counts"],
    }
    if is_admin:
        result["eids"] = ["Overall"] + eids
    return result


def get_active_herd_counts(farm_id: str) -> dict:
    from datetime import date, datetime, timedelta
    from zoneinfo import ZoneInfo
    from app.db import fetch_one

    herd_counts = fetch_one(
        """
        SELECT
          COUNT(DISTINCT eid)::int AS total_animal_count,
          MAX(date) AS max_d
        FROM animal_data
        WHERE farm_id = %s AND eid IS NOT NULL
        """,
        (farm_id,),
    ) or {}
    total_animal_count = int(herd_counts.get("total_animal_count") or 0)
    max_d = herd_counts.get("max_d")

    matrix: dict[str, int] = {}
    for mode in ["auto", "max", "today"]:
        for days in [7, 14, 30]:
            matrix[f"{mode}_{days}"] = 0

    if not max_d:
        return {
            "total_animal_count": total_animal_count,
            "active_animal_count": 0,
            "active_counts": matrix,
        }

    if isinstance(max_d, str):
        max_d_dt = date.fromisoformat(str(max_d)[:10])
    elif isinstance(max_d, datetime) or hasattr(max_d, "date"):
        max_d_dt = max_d.date()
    else:
        max_d_dt = max_d

    today = datetime.now(ZoneInfo("Australia/Sydney")).date()
    auto_anchor = max_d_dt if (today - max_d_dt).days > 30 else today

    query_anchors = {"max": max_d_dt, "today": today}
    select_clauses: list[str] = []
    params: list = []
    keys: list[str] = []

    for mode, anchor in query_anchors.items():
        for days in [7, 14, 30]:
            w_start = anchor - timedelta(days=days - 1)
            if anchor > max_d_dt and w_start > max_d_dt:
                continue
            key = f"{mode}_{days}"
            keys.append(key)
            select_clauses.append(
                f"COUNT(DISTINCT CASE WHEN date >= %s::date AND date <= %s::date THEN eid END)::int AS {key}"
            )
            params.extend([w_start.isoformat(), anchor.isoformat()])

    if select_clauses:
        sql = f"""
        SELECT
          {', '.join(select_clauses)}
        FROM animal_data
        WHERE farm_id = %s AND eid IS NOT NULL
        """
        row = fetch_one(sql, tuple(params + [farm_id])) or {}
        for k in keys:
            matrix[k] = int(row.get(k) or 0)

    source_mode = "max" if auto_anchor == max_d_dt else "today"
    for days in [7, 14, 30]:
        matrix[f"auto_{days}"] = matrix.get(f"{source_mode}_{days}", 0)

    active_animal_count = matrix.get("auto_30", 0)

    return {
        "total_animal_count": total_animal_count,
        "active_animal_count": active_animal_count,
        "active_counts": matrix,
    }


def get_active_herd_count(
    farm_id: str,
    active_days: int = 30,
    active_reference_mode: str = "auto",
) -> dict:
    counts_data = get_active_herd_counts(farm_id)
    key = f"{active_reference_mode}_{active_days}"
    if key in counts_data["active_counts"]:
        active = counts_data["active_counts"][key]
    else:
        from app.models.schemas import FilterState
        from app.services.filter_service import FilterService

        f = FilterState(
            farm_id=farm_id,
            active_only=True,
            active_days=active_days,
            active_reference_mode=active_reference_mode,
        )
        window = FilterService.resolve_active_window(farm_id, f)
        active = 0
        if window:
            w_start, w_end = window
            from app.db import fetch_one

            row = fetch_one(
                """
                SELECT COUNT(DISTINCT eid)::int AS active_count
                FROM animal_data
                WHERE farm_id = %s AND eid IS NOT NULL AND date >= %s::date AND date <= %s::date
                """,
                (farm_id, w_start.isoformat(), w_end.isoformat()),
            ) or {}
            active = int(row.get("active_count") or 0)
    return {
        "active_animal_count": active,
        "total_animal_count": counts_data["total_animal_count"],
    }

