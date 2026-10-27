from __future__ import annotations

import io
import logging
import os
import re
from pathlib import Path
from typing import Annotated

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.auth.dependencies import CurrentUser, require_admin, require_credential_admin
from app.auth.passwords import hash_password
from app.config import get_settings
from app.constants import CSV_COLUMN_MAP
from app.db import execute, execute_returning, fetch_all, fetch_one
from app.models.schemas import FarmCreate, PasswordUpdate, UserCreate, UsernameUpdate
from app.routers.farms import (
    ALLOWED_LOGO_EXTENSIONS,
    MAX_LOGO_BYTES,
    LOGO_CONTENT_TYPES,
    _get_logos,
    delete_db_logos,
    list_db_logos,
    logo_api_url,
    save_logo,
)

router = APIRouter()
logger = logging.getLogger(__name__)



def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    col_map = {}
    for col in df.columns:
        key = col.strip().lower().replace(" ", "")
        for csv_key, db_col in {
            "eid": "eid",
            "date": "date",
            "breed": "breed",
            "treatment": "treatment",
            "mob": "mob",
            "sex": "sex",
            "weight": "weight",
            "pweight": "pweight",
            "growthpbs": "growthpbs",
            "finalpweight": "finalpweight",
            "finalgrowthpbs": "finalgrowthpbs",
            "finaldailygrowth": "finaldailygrowth",
            "feedintakekgd": "feedintakekgd",
            "feedintakepct": "feedintakepct",
            "methane": "methane",
            "animalvalue": "animalvalue",
            "animalprod": "animalprod",
            "feedintakekgdsum": "feedintakekgdsum",
            "finalgrowthpbssum": "finalgrowthpbssum",
            "animalprodsum": "animalprodsum",
            "methanesum": "methanesum",
            "methanesupplsum": "methanesupplsum",
            "carcassweight": "carcassweight",
            "dressedcarcass": "dressedcarcass",
        }.items():
            if key == csv_key or col.strip().lower() == csv_key:
                col_map[col] = db_col
    return df.rename(columns=col_map)


@router.post("/farms")
def create_farm(body: FarmCreate, user: Annotated[CurrentUser, Depends(require_admin)]):
    execute(
        "INSERT INTO farms (farm_id, farm_name, slug) VALUES (%s, %s, %s)",
        (body.farm_id, body.farm_name, body.slug),
    )
    return {"detail": "Farm created", "farm_id": body.farm_id}


@router.post("/farms/{farm_id}/upload")
async def upload_csv(
    farm_id: str,
    user: Annotated[CurrentUser, Depends(require_admin)],
    file: UploadFile = File(...),
    duplicate_mode: str = Form("skip"),
    forecast: bool = Form(True),
):
    """Add a farm's CSV records, then refresh its Prediction-page forecasts (unless forecast=false)."""
    if not re.match(rf"^{re.escape(farm_id)}_.+\.csv$", file.filename or "", re.I):
        raise HTTPException(status_code=400, detail=f"Filename must match {farm_id}_YYYY-MM-DD.csv")

    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 50MB)")

    df = pd.read_csv(io.BytesIO(content))
    df = _normalize_columns(df)
    if "eid" not in df.columns or "date" not in df.columns:
        raise HTTPException(status_code=400, detail="CSV must contain EID and Date columns")

    df["date"] = pd.to_datetime(df["date"], dayfirst=True, errors="coerce")
    df = df.dropna(subset=["eid", "date"])
    if "sex" not in df.columns:
        df["sex"] = "Unknown"
    if "treatment" not in df.columns:
        df["treatment"] = None
    else:
        df["treatment"] = df["treatment"].replace("", None)

    count_row = fetch_one("SELECT COUNT(*) AS cnt FROM animal_data WHERE farm_id = %s", (farm_id,))
    snapshot = execute_returning(
        """
        INSERT INTO animal_data_snapshots (farm_id, snapshot_name, record_count, created_by)
        VALUES (%s, %s, %s, %s) RETURNING id
        """,
        (farm_id, f"pre_upload_{file.filename}", count_row["cnt"] if count_row else 0, user.username),
    )

    inserted = skipped = overwritten = 0
    numeric_cols = [c for c in CSV_COLUMN_MAP.values() if c not in ("eid", "date", "breed", "treatment", "mob", "sex")]

    for _, row in df.iterrows():
        # (farm_id, eid, date) is unique in both databases; the dev DuckDB table has no id column
        key = (farm_id, str(row["eid"]), row["date"].date())
        existing = fetch_one(
            "SELECT eid FROM animal_data WHERE farm_id = %s AND eid = %s AND date = %s",
            key,
        )
        if existing:
            if duplicate_mode == "overwrite":
                sets = ", ".join(f"{c} = %s" for c in numeric_cols if c in row.index)
                vals = [row[c] if c in row.index and pd.notna(row[c]) else None for c in numeric_cols if c in row.index]
                execute(
                    f"UPDATE animal_data SET breed=%s, treatment=%s, mob=%s, sex=%s, {sets} "
                    "WHERE farm_id = %s AND eid = %s AND date = %s",
                    (
                        row.get("breed"),
                        row.get("treatment"),
                        row.get("mob"),
                        row.get("sex", "Unknown"),
                        *vals,
                        *key,
                    ),
                )
                overwritten += 1
            else:
                skipped += 1
            continue

        cols = ["farm_id", "eid", "date", "breed", "treatment", "mob", "sex"] + [
            c for c in numeric_cols if c in row.index
        ]
        placeholders = ", ".join(["%s"] * len(cols))
        vals = [farm_id, str(row["eid"]), row["date"].date()]
        for c in ["breed", "treatment", "mob", "sex"]:
            vals.append(row.get(c) if c != "sex" else row.get(c, "Unknown"))
        for c in numeric_cols:
            if c in row.index:
                vals.append(row[c] if pd.notna(row[c]) else None)
        execute(f"INSERT INTO animal_data ({', '.join(cols)}) VALUES ({placeholders})", tuple(vals))
        inserted += 1

    execute(
        """
        INSERT INTO data_uploads (farm_id, filename, rows_inserted, rows_skipped, rows_overwritten, duplicate_mode, uploaded_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (farm_id, file.filename, inserted, skipped, overwritten, duplicate_mode, user.username),
    )

    return {
        "rows_inserted": inserted,
        "rows_skipped": skipped,
        "rows_overwritten": overwritten,
        "snapshot_id": snapshot["id"] if snapshot else None,
        # in a worker thread: forecasting a farm takes a few seconds
        "forecasts": await run_in_threadpool(refresh_forecasts, farm_id) if forecast else {"status": "skipped"},
    }


def refresh_forecasts(farm_id: str) -> dict:
    """Recompute a farm's Prediction-page forecasts and report how it went.

    Never raises: after an upload the new records are already saved, so a forecast failure is
    reported in the response instead of failing the whole request.
    """
    try:
        from app.services import forecast_service  # imported here so the other admin routes never depend on it

        return {"status": "updated", **forecast_service.refresh_farm(farm_id)}
    except Exception as exc:
        logger.exception("Refreshing forecasts for farm %s failed", farm_id)
        reason = str(exc).splitlines()[0].rstrip(".") if str(exc) else type(exc).__name__
        return {
            "status": "failed",
            "detail": f"Forecasts were not refreshed: {reason}. Retry with POST "
            f"/api/admin/farms/{farm_id}/forecasts/refresh (python admin-cli/admin.py forecast --farm {farm_id}).",
        }


@router.post("/farms/{farm_id}/forecasts/refresh")
def refresh_farm_forecasts(farm_id: str, user: Annotated[CurrentUser, Depends(require_admin)]):
    """Recompute a farm's forecasts without uploading: to retry, or after deploying a new model."""
    result = refresh_forecasts(farm_id)
    if result["status"] == "failed":
        raise HTTPException(status_code=500, detail=result["detail"])
    return result


@router.get("/farms/{farm_id}/status")
def farm_status(farm_id: str, user: Annotated[CurrentUser, Depends(require_admin)]):
    count = fetch_one("SELECT COUNT(*) AS cnt FROM animal_data WHERE farm_id = %s", (farm_id,))
    last_upload = fetch_one(
        "SELECT created_at FROM data_uploads WHERE farm_id = %s ORDER BY created_at DESC LIMIT 1",
        (farm_id,),
    )
    snapshots = fetch_one(
        "SELECT COUNT(*) AS cnt FROM animal_data_snapshots WHERE farm_id = %s", (farm_id,)
    )
    return {
        "record_count": count["cnt"] if count else 0,
        "last_upload": last_upload["created_at"].isoformat() if last_upload and last_upload.get("created_at") else None,
        "snapshots_count": snapshots["cnt"] if snapshots else 0,
        "pending_uploads": [],
    }


@router.get("/users")
def list_users(user: Annotated[CurrentUser, Depends(require_admin)]):
    return fetch_all("SELECT id, username, is_admin, is_active, created_at FROM users ORDER BY id")


def _clean_username(username: str) -> str:
    cleaned = username.strip()
    if not cleaned or len(cleaned) > 50 or any(ch.isspace() for ch in cleaned):
        raise HTTPException(status_code=400, detail="Username must be 1–50 characters with no spaces")
    return cleaned


@router.get("/credentials/users")
def list_credential_users(user: Annotated[CurrentUser, Depends(require_credential_admin)]):
    rows = fetch_all("SELECT id, username, is_admin FROM users ORDER BY id")
    return [
        {
            "id": row["id"],
            "username": row["username"],
            "role": "admin" if row["is_admin"] else "user",
        }
        for row in rows
    ]


@router.put("/credentials/username")
def change_credential_username(
    body: UsernameUpdate,
    user: Annotated[CurrentUser, Depends(require_credential_admin)],
):
    new_name = _clean_username(body.new_username)
    if new_name.lower() == "owner":
        raise HTTPException(status_code=400, detail="Cannot rename user to owner")
    target = fetch_one("SELECT id, username FROM users WHERE id = %s", (body.user_id,))
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target["username"].lower() == "owner":
        raise HTTPException(status_code=400, detail="Cannot rename system owner account")
    clash = fetch_one(
        "SELECT id FROM users WHERE lower(username) = lower(%s) AND id <> %s",
        (new_name, body.user_id),
    )
    if clash:
        raise HTTPException(status_code=409, detail="Username is already taken")
    execute(
        "UPDATE users SET username = %s, updated_at = NOW() WHERE id = %s",
        (new_name, body.user_id),
    )
    return {"detail": "Username updated", "id": body.user_id, "username": new_name}


@router.put("/credentials/password")
def change_credential_password(
    body: PasswordUpdate,
    user: Annotated[CurrentUser, Depends(require_credential_admin)],
):
    if not body.new_password or not body.new_password.strip():
        raise HTTPException(status_code=400, detail="Password cannot be empty")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    target = fetch_one("SELECT id FROM users WHERE id = %s", (body.user_id,))
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    execute(
        "UPDATE users SET password_hash = %s, updated_at = NOW() WHERE id = %s",
        (hash_password(body.new_password), body.user_id),
    )
    return {"detail": "Password updated", "id": body.user_id}


@router.post("/users")
def create_user(body: UserCreate, user: Annotated[CurrentUser, Depends(require_admin)]):
    row = execute_returning(
        "INSERT INTO users (username, password_hash, is_admin) VALUES (%s, %s, %s) RETURNING id, username, is_admin",
        (body.username, hash_password(body.password), body.is_admin),
    )
    for fid in body.farm_ids:
        execute("INSERT INTO user_farm_access (user_id, farm_id) VALUES (%s, %s)", (row["id"], fid))
    return row


@router.get("/farms/{farm_id}/logos")
def get_farm_logos_admin(farm_id: str, user: Annotated[CurrentUser, Depends(require_admin)]):
    settings = get_settings()
    custom_logos = []
    seen: set[str] = set()
    for row in list_db_logos(farm_id):
        fname = row["filename"]
        seen.add(fname)
        custom_logos.append({
            "filename": fname,
            "url": logo_api_url(farm_id, fname),
            "is_default": False,
        })
    farm_logo_dir = Path(settings.logos_path) / farm_id
    if farm_logo_dir.is_dir():
        for fname in sorted(os.listdir(farm_logo_dir)):
            if Path(fname).suffix.lower() in ALLOWED_LOGO_EXTENSIONS and fname not in seen:
                seen.add(fname)
                custom_logos.append({
                    "filename": fname,
                    "url": f"/assets/logos/{farm_id}/{fname}",
                    "is_default": False,
                })
    custom_logos.sort(key=lambda l: l["filename"])
    has_custom = len(custom_logos) > 0
    logos = custom_logos if has_custom else _get_logos(farm_id)
    return {
        "farm_id": farm_id,
        "has_custom_logos": has_custom,
        "logos": logos,
    }


@router.post("/farms/{farm_id}/logos")
async def upload_farm_logo(
    farm_id: str,
    user: Annotated[CurrentUser, Depends(require_admin)],
    file: UploadFile = File(...),
):
    filename = Path(file.filename or "").name
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid image type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_LOGO_EXTENSIONS))}",
        )
    clean_stem = re.sub(r"[^a-zA-Z0-9_\-]", "_", Path(filename).stem)
    safe_filename = f"{clean_stem}{ext}" if clean_stem else f"logo{ext}"

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(content) > MAX_LOGO_BYTES:
        raise HTTPException(status_code=413, detail=f"Logo exceeds {MAX_LOGO_BYTES // (1024 * 1024)}MB limit")

    # Store in the database: serverless filesystems are read-only/ephemeral.
    save_logo(farm_id, safe_filename, LOGO_CONTENT_TYPES[ext], content)
    return {
        "detail": "Logo uploaded successfully",
        "farm_id": farm_id,
        "filename": safe_filename,
        "url": logo_api_url(farm_id, safe_filename),
    }


@router.delete("/farms/{farm_id}/logos/{filename}")
def delete_farm_logo(
    farm_id: str,
    filename: str,
    user: Annotated[CurrentUser, Depends(require_admin)],
):
    settings = get_settings()
    safe_name = Path(filename).name
    if safe_name != filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    target = Path(settings.logos_path) / farm_id / safe_name
    on_disk = target.is_file()
    in_db = delete_db_logos(farm_id, safe_name) > 0
    if not on_disk and not in_db:
        raise HTTPException(status_code=404, detail=f"Logo '{safe_name}' not found for farm '{farm_id}'")
    if on_disk:
        target.unlink()
    return {"detail": "Logo deleted successfully", "farm_id": farm_id, "filename": safe_name}


@router.post("/farms/{farm_id}/logos/reset")
def reset_farm_logos(
    farm_id: str,
    user: Annotated[CurrentUser, Depends(require_admin)],
):
    settings = get_settings()
    farm_logo_dir = Path(settings.logos_path) / farm_id
    deleted_count = delete_db_logos(farm_id)
    if farm_logo_dir.is_dir():
        for fname in os.listdir(farm_logo_dir):
            p = farm_logo_dir / fname
            if p.is_file() and p.suffix.lower() in ALLOWED_LOGO_EXTENSIONS:
                p.unlink()
                deleted_count += 1
    return {
        "detail": "Farm logos reset to partner defaults",
        "farm_id": farm_id,
        "deleted_count": deleted_count,
    }

