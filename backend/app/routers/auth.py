from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.auth.dependencies import CurrentUser, create_access_token, get_current_user
from app.auth.passwords import hash_password, verify_password
from app.db import execute, fetch_one, get_user_farms
from app.models.schemas import FarmInfo, LoginRequest, LoginResponse, PasswordUpdate, UserInfo, UsernameUpdate

router = APIRouter()


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest):
    user = fetch_one(
        "SELECT id, username, password_hash, is_admin, is_active FROM users WHERE username = %s",
        (body.username,),
    )
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    farms = get_user_farms(user["id"])
    farm_ids = [f["farm_id"] for f in farms]
    token, expires_in = create_access_token(user["id"], user["username"], user["is_admin"], farm_ids)
    return LoginResponse(
        access_token=token,
        expires_in=expires_in,
        user=UserInfo(
            id=user["id"],
            username=user["username"],
            is_admin=user["is_admin"],
            farms=[FarmInfo(**f) for f in farms],
        ),
    )


@router.get("/me", response_model=UserInfo)
def me(user: Annotated[CurrentUser, Depends(get_current_user)]):
    farms = get_user_farms(user.id)
    return UserInfo(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        farms=[FarmInfo(**f) for f in farms],
    )


@router.post("/logout")
def logout():
    return {"detail": "logged out"}


@router.put("/password")
def update_password(body: PasswordUpdate, user: Annotated[CurrentUser, Depends(get_current_user)]):
    if not user.is_admin and body.user_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot change other user's password")
    execute(
        "UPDATE users SET password_hash = %s, updated_at = NOW() WHERE id = %s",
        (hash_password(body.new_password), body.user_id),
    )
    return {"detail": "Password updated"}


@router.put("/username")
def update_username(body: UsernameUpdate, user: Annotated[CurrentUser, Depends(get_current_user)]):
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    execute("UPDATE users SET username = %s, updated_at = NOW() WHERE id = %s", (body.new_username, body.user_id))
    return {"detail": "Username updated"}
