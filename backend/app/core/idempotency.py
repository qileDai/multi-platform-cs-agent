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


def release(event_key: str) -> None:
    """处理失败时删掉本次幂等记录，队列重试才能再次进入。成功路径不要调用。"""
    if not event_key:
        return
    db = SessionLocal()
    try:
        db.query(ProcessedEvent).filter(ProcessedEvent.event_key == event_key).delete(
            synchronize_session=False,
        )
        db.commit()
    finally:
        db.close()
