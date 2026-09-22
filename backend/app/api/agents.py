"""客服管理：账号 CRUD、在线状态切换。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.security import hash_password
from ..database import get_db
from ..models import Agent
from ..schemas import AgentCreate, AgentOut, AgentStatusUpdate, AgentUpdate
from .deps import get_current_agent, require_admin

router = APIRouter(prefix="/api/agents", tags=["agents"])


@router.get("", response_model=list[AgentOut])
def list_agents(agent: Agent = Depends(get_current_agent), db: Session = Depends(get_db)):
    return [AgentOut.model_validate(a) for a in db.query(Agent).order_by(Agent.id).all()]


@router.post("", response_model=AgentOut)
def create_agent(req: AgentCreate, admin: Agent = Depends(require_admin),
                 db: Session = Depends(get_db)):
    if db.query(Agent).filter(Agent.username == req.username).first():
        raise HTTPException(400, "账号已存在")
    agent = Agent(
        username=req.username,
        password_hash=hash_password(req.password),
        display_name=req.display_name,
        role=req.role,
        max_concurrent=req.max_concurrent if req.max_concurrent is not None else 20,
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


@router.post("/me/status", response_model=AgentOut)
def update_my_status(req: AgentStatusUpdate, agent: Agent = Depends(get_current_agent),
                     db: Session = Depends(get_db)):
    agent.status = req.status
    db.commit()
    return agent


@router.patch("/{agent_id}", response_model=AgentOut)
def update_agent(agent_id: int, req: AgentUpdate, admin: Agent = Depends(require_admin),
                 db: Session = Depends(get_db)):
    target = db.get(Agent, agent_id)
    if target is None:
        raise HTTPException(404, "客服不存在")
    if req.max_concurrent is not None:
        if req.max_concurrent < 0:
            raise HTTPException(400, "接待上限不能为负数")
        target.max_concurrent = req.max_concurrent
    if req.display_name:
        target.display_name = req.display_name
    db.commit()
    db.refresh(target)
    return target


@router.delete("/{agent_id}")
def delete_agent(agent_id: int, admin: Agent = Depends(require_admin),
                 db: Session = Depends(get_db)):
    target = db.get(Agent, agent_id)
    if target is None:
        raise HTTPException(404, "客服不存在")
    if target.id == admin.id:
        raise HTTPException(400, "不能删除自己")
    db.delete(target)
    db.commit()
    return {"ok": True}
