from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.db import fetch_one, get_user_farms

security = HTTPBearer(auto_error=False)


class CurrentUser:
    def __init__(self, id: int, username: str, is_admin: bool, farm_ids: list[str]):
        self.id = id
        self.username = username
        self.is_admin = is_admin
        self.farm_ids = farm_ids


def create_access_token(user_id: int, username: str, is_admin: bool, farm_ids: list[str]) -> tuple[str, int]:
    settings = get_settings()
    expires_in = settings.jwt_expiry_hours * 3600
    payload = {
        "sub": str(user_id),
        "username": username,
        "is_admin": is_admin,
        "farm_ids": farm_ids,
        "exp": datetime.now(timezone.utc) + timedelta(seconds=expires_in),
        "iat": datetime.now(timezone.utc),
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
    return token, expires_in


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> CurrentUser:
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    settings = get_settings()
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user_id = int(payload["sub"])
    user = fetch_one("SELECT id, username, is_admin, is_active FROM users WHERE id = %s", (user_id,))
    if not user or not user["is_active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User inactive")
    farms = get_user_farms(user_id)
    farm_ids = [f["farm_id"] for f in farms]
    return CurrentUser(id=user["id"], username=user["username"], is_admin=user["is_admin"], farm_ids=farm_ids)


def require_admin(user: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


def require_credential_admin(user: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
    """Account management is limited to the admin login, not the owner or viewer."""
    if not user.is_admin or user.username.lower() == "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


def assert_farm_access(user: CurrentUser, farm_id: str) -> None:
    if farm_id not in user.farm_ids:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this farm")
