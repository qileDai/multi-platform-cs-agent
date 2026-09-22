"""幂等去重：平台 webhook 重推是常态，按 event_key 去重。"""
import logging

from sqlalchemy.exc import IntegrityError

from ..database import SessionLocal
from ..models import ProcessedEvent

logger = logging.getLogger(__name__)


def is_duplicate(event_key: str) -> bool:
    """首次见到返回 False 并记录；重复返回 True。利用唯一索引保证并发安全。"""
    if not event_key:
        return False
    db = SessionLocal()
    try:
        db.add(ProcessedEvent(event_key=event_key))
        db.commit()
        return False
    except IntegrityError:
        db.rollback()
        logger.info("重复事件已丢弃: %s", event_key)
        return True
    finally:
        db.close()
