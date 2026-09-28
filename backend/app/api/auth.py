"""认证接口：登录、改密码。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.security import create_access_token, hash_password, verify_password
from ..database import get_db
from ..models import Agent
from ..schemas import AgentOut, LoginRequest, PasswordChange, TokenResponse
from .deps import get_current_agent

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    agent = db.query(Agent).filter(Agent.username == req.username).first()
    password_ok = bool(agent is not None and verify_password(req.password, agent.password_hash))
    # #region agent log
    try:
        import json, time
        _hash = agent.password_hash if agent is not None else ""
        with open(r"D:\projects\multi-platform-cs-agent\debug-aaecc8.log", "a", encoding="utf-8") as _f:
            _f.write(json.dumps({"sessionId": "aaecc8", "hypothesisId": "B", "location": "auth.py:login", "message": "login attempt", "data": {"username_len": len(req.username or ""), "username_is_admin": (req.username or "") == "admin", "password_len": len(req.password or ""), "agent_found": agent is not None, "hash_len": len(_hash or ""), "hash_prefix": (_hash or "")[:4], "password_ok": password_ok}, "timestamp": int(time.time() * 1000)}, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # #endregion
    if agent is None or not password_ok:
        raise HTTPException(401, "账号或密码错误")
    token = create_access_token(agent.id, agent.username)
    return TokenResponse(access_token=token, agent=AgentOut.model_validate(agent))


@router.get("/me", response_model=AgentOut)
def me(agent: Agent = Depends(get_current_agent)):
    return agent


@router.post("/password")
def change_password(req: PasswordChange, agent: Agent = Depends(get_current_agent),
                    db: Session = Depends(get_db)):
    if not verify_password(req.old_password, agent.password_hash):
        raise HTTPException(400, "原密码错误")
    agent.password_hash = hash_password(req.new_password)
    db.commit()
    return {"ok": True}
