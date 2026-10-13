"""留资原句：完整手机号、开户先问户型、留号后安排专员。"""
from app.agent.lead_flow import (
    ARRANGE, ASK_FULL, BANK_TYPE, business_phrase, contact_ask, must_handoff,
    phone_in_message, script_for_miss, wechat_in_message,
)


def test_phone_must_be_complete_in_one_message():
    assert phone_in_message("13515027988") == "13515027988"
    assert phone_in_message("我的号码是13515027988，谢谢") == "13515027988"
    assert phone_in_message("135") == ""
    assert phone_in_message("1351502") == ""


def test_split_digits_are_not_joined():
    assert phone_in_message("135") == ""
    assert phone_in_message("15027988") == ""


def test_open_account_asks_type_before_contact():
    assert script_for_miss("我要开银行账户") == BANK_TYPE
    recent = [{"sender_type": "user", "content": "我要开银行账户"}]
    assert script_for_miss("个人户", recent) == contact_ask("开户")


def test_register_asks_contact_with_business():
    assert script_for_miss("我要注册香港公司") == contact_ask("注册香港公司")
    assert "注册香港公司" in script_for_miss("我要注册香港公司")


def test_unknown_uses_full_original_line():
    assert script_for_miss("这个怎么办呀") == ASK_FULL


def test_phone_and_wechat_arrange_specialist():
    assert script_for_miss("13515027988") == ARRANGE
    assert wechat_in_message("yingtai2024") == "yingtai2024"
    assert script_for_miss("yingtai2024") == ARRANGE


def test_complaint_still_handoff():
    assert must_handoff("我要投诉")
    assert script_for_miss("我要投诉") is None


def test_save_lead_does_not_duplicate(db, conversation):
    from app.agent.lead_flow import save_lead
    from app.models import LeadCapture

    kwargs = dict(
        customer_id=conversation.customer_id,
        conversation_id=conversation.id,
        platform="douyin",
        nickname="测试",
        contact="13515027988",
        contact_type="phone",
        business="注册香港公司",
    )
    save_lead(**kwargs)
    save_lead(**kwargs)
    db.expire_all()
    rows = db.query(LeadCapture).filter(LeadCapture.conversation_id == conversation.id).all()
    assert len(rows) == 1
    assert rows[0].platform == "douyin"
    assert rows[0].business == "注册香港公司"
    db.query(LeadCapture).filter(LeadCapture.conversation_id == conversation.id).delete()
    db.commit()
    recent = [{"sender_type": "user", "content": "我要注册香港公司"}]
    assert business_phrase("13515027988", recent) == "注册香港公司"
    assert business_phrase("你好") == ""
