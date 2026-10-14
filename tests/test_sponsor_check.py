import json
import pytest

CONTRACT_PATH = "contracts/sponsor_check.py"

POST = "https://posts.example.com/launch"
REF1 = "https://web.archive.org/save/launch-ad"
REF2 = "https://help.x.com/rules/ads"
CHECKLIST = [
    "Public ad hashtag is present (#ad or #sponsored)",
    "Post names the product",
]
FEE = 1000
FUTURE_DEADLINE = 2_000_000_000
PAST_DEADLINE = 1


def _set_value(vm, amount):
    if hasattr(vm, "value"):
        try:
            vm.value = amount
        except Exception:
            pass
    if hasattr(vm, "_value"):
        vm._value = amount
    if hasattr(vm, "_refresh_gl_message"):
        vm._refresh_gl_message()


def _clear_value(vm):
    _set_value(vm, 0)


def _active_vm(direct_vm):
    try:
        from gltest.direct.loader import _get_active_vm
        return _get_active_vm() or direct_vm
    except Exception:
        return direct_vm


def sim_installMocks(vm, web=None, llm=None):
    """Install nondet mocks before every AI tx."""
    web = web or {}
    llm_payload = llm if isinstance(llm, str) or llm is None else json.dumps(llm)

    if hasattr(vm, "sim_installMocks"):
        vm.sim_installMocks({"web": web, "llm": llm_payload})
        return
    if hasattr(vm, "sim_install_mocks"):
        vm.sim_install_mocks({"web": web, "llm": llm_payload})
        return

    if hasattr(vm, "clear_mocks"):
        try:
            vm.clear_mocks()
        except Exception:
            pass
    for url, body in web.items():
        payload = body if isinstance(body, dict) else {"status": 200, "body": body}
        vm.mock_web(url, payload)
    if llm_payload is not None:
        vm.mock_llm(".*", llm_payload)


def _parse(raw):
    if isinstance(raw, str):
        return json.loads(raw or "{}")
    return raw or {}


def _parse_list(raw):
    if isinstance(raw, str):
        return json.loads(raw or "[]")
    return raw or []


def _row(contract, sponsorship_id):
    return _parse(contract.get_sponsorship(sponsorship_id))


def _addr(account):
    if hasattr(account, "address"):
        return account.address
    if hasattr(account, "as_hex"):
        return account.as_hex
    return account


def _norm_addr(value):
    if value is None:
        return ""
    if hasattr(value, "as_hex"):
        try:
            return str(value.as_hex).lower()
        except Exception:
            pass
    s = str(value).lower()
    marker = 'address("'
    if marker in s:
        s = s.split(marker, 1)[1].split('"', 1)[0]
    if not s.startswith("0x") and len(s) == 40:
        s = "0x" + s
    return s


def _create(contract, vm, brand, influencer, checklist=None, deadline=FUTURE_DEADLINE, fee=FEE, description="Launch week for Aurora Bottle"):
    vm.sender = brand
    _set_value(vm, fee)
    sponsorship_id = contract.create_sponsorship(
        _addr(influencer),
        description,
        checklist if checklist is not None else CHECKLIST,
        deadline,
    )
    _clear_value(vm)
    return sponsorship_id


def _submit(contract, vm, influencer, sponsorship_id, posts=None, refs=None):
    vm.sender = influencer
    contract.submit_post(
        sponsorship_id,
        posts or [POST],
        refs or [REF1, REF2],
    )


def _default_web():
    return {
        POST: "Aurora Bottle launch. Use code AURORA. #ad #sponsored",
        REF1: "Archived copy of the post: Aurora Bottle #ad #sponsored and signup link",
        REF2: "Platform disclosure policy: promotional posts must include #ad or #sponsored",
    }


def _resolve(contract, vm, sponsorship_id, verdict, confidence=90, reason="Every checklist item is present", web=None):
    sim_installMocks(
        vm,
        web=web or _default_web(),
        llm={"verdict": verdict, "confidence": confidence, "reason": reason},
    )
    contract.resolve_sponsorship(sponsorship_id)


def _patch_clock(contract, monkeypatch, ts):
    def fake_now():
        return int(ts)

    import sys
    for _name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if callable(getattr(mod, "_current_unix_timestamp", None)) and hasattr(mod, "Sponsorship"):
            monkeypatch.setattr(mod, "_current_unix_timestamp", fake_now)
            return True

    inner = getattr(contract, "_contract", None) or getattr(contract, "__wrapped__", None)
    target = inner or contract
    meth = getattr(target, "claim_expired_refund", None)
    func = getattr(meth, "__func__", meth) if meth is not None else None
    g = getattr(func, "__globals__", None) if func is not None else None
    if g is not None and "_current_unix_timestamp" in g:
        monkeypatch.setitem(g, "_current_unix_timestamp", fake_now)
        return True
    return False


def _loaded_mod(contract=None):
    import sys
    for _name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if callable(getattr(mod, "_consensus_accepts", None)) and hasattr(mod, "Sponsorship"):
            return mod
    return None


def _install_transfer_hook(monkeypatch, fail=False):
    import gltest.direct.loader

    original = gltest.direct.loader._EOAProxy.emit_transfer
    calls = []
    state = {"fail": fail}

    def wrapped(self, value=None, **kwargs):
        if state["fail"]:
            raise Exception("Simulated native transfer execution failure")
        calls.append((_norm_addr(self.address), int(value)))
        return original(self, value, **kwargs)

    monkeypatch.setattr(gltest.direct.loader._EOAProxy, "emit_transfer", wrapped)
    return calls, state


def test_consensus_is_absolute(direct_vm, direct_deploy, direct_accounts):
    contract = direct_deploy(CONTRACT_PATH)
    mod = _loaded_mod(contract)
    assert mod is not None
    accept = mod._consensus_accepts

    assert accept("COMPLIANT", 95, "COMPLIANT", 80) is True
    assert accept("NON_COMPLIANT", 90, "NON_COMPLIANT", 61) is True
    assert accept("COMPLIANT", 95, "NON_COMPLIANT", 95) is False
    assert accept("COMPLIANT", 95, "COMPLIANT", 40) is False
    assert accept("NON_COMPLIANT", 59, "NON_COMPLIANT", 10) is True
    assert accept("", 0, "", 0) is True
    assert accept("", 0, "COMPLIANT", 0) is False
    assert accept("", 80, "", 80) is False
    assert accept("COMPLIANT", 100, "COMPLIANT", 101) is False


def test_happy_path_compliant_pays_influencer(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)
    calls, _state = _install_transfer_hook(monkeypatch)

    sponsorship_id = _create(contract, vm, brand, influencer)
    assert sponsorship_id == "0"
    row = _row(contract, sponsorship_id)
    assert row["status"] == "PENDING_POST"
    assert row["fee_amount"] == str(FEE)
    assert row["settled"] is False

    _submit(contract, vm, influencer, sponsorship_id)
    assert _row(contract, sponsorship_id)["status"] == "SUBMITTED"

    _resolve(contract, vm, sponsorship_id, "COMPLIANT", 95, "Hashtag #ad and product name Aurora Bottle are both present")
    assert vm.run_validator() is True
    assert vm.run_validator(leader_result={"verdict": "NON_COMPLIANT", "confidence": 95, "reason": "missing"}) is False
    assert vm.run_validator(leader_result={"verdict": "COMPLIANT", "confidence": 20, "reason": "unsure"}) is False

    row = _row(contract, sponsorship_id)
    assert row["status"] == "RESOLVED_COMPLIANT"
    assert row["verdict"] == "COMPLIANT"
    assert row["confidence"] == 95
    assert row["settled"] is True
    assert row["fee_amount"] == str(FEE)
    assert "Aurora Bottle" in row["verdict_reason"]
    assert len(calls) == 1
    assert calls[0][0] == row["influencer"]
    assert calls[0][1] == FEE


def test_non_compliant_then_revision_then_compliant(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer)
    _submit(contract, vm, influencer, sponsorship_id)
    _resolve(contract, vm, sponsorship_id, "NON_COMPLIANT", 88, "Missing #ad hashtag")

    row = _row(contract, sponsorship_id)
    assert row["status"] == "REVISION_REQUESTED"
    assert row["verdict"] == "NON_COMPLIANT"
    assert row["revisions_used"] == 1
    assert row["settled"] is False
    assert row["fee_amount"] == str(FEE)

    vm.sender = brand
    with pytest.raises(Exception):
        contract.resolve_sponsorship(sponsorship_id)

    _submit(contract, vm, influencer, sponsorship_id)
    assert _row(contract, sponsorship_id)["status"] == "SUBMITTED"
    assert _row(contract, sponsorship_id)["revisions_used"] == 1

    calls, _state = _install_transfer_hook(monkeypatch)
    _resolve(contract, vm, sponsorship_id, "COMPLIANT", 93, "Revised post now includes #ad and the product name")
    row = _row(contract, sponsorship_id)
    assert row["status"] == "RESOLVED_COMPLIANT"
    assert row["settled"] is True
    assert row["verdict"] == "COMPLIANT"
    assert calls[0][0] == row["influencer"]
    assert calls[0][1] == FEE


def test_non_compliant_after_revision_refunds_brand(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer)
    _submit(contract, vm, influencer, sponsorship_id)
    _resolve(contract, vm, sponsorship_id, "NON_COMPLIANT", 91, "Missing product name")
    assert _row(contract, sponsorship_id)["status"] == "REVISION_REQUESTED"
    assert _row(contract, sponsorship_id)["settled"] is False

    _submit(contract, vm, influencer, sponsorship_id)
    calls, _state = _install_transfer_hook(monkeypatch)
    _resolve(contract, vm, sponsorship_id, "NON_COMPLIANT", 96, "Product name still missing after the revision")

    row = _row(contract, sponsorship_id)
    assert row["status"] == "RESOLVED_NON_COMPLIANT"
    assert row["verdict"] == "NON_COMPLIANT"
    assert row["settled"] is True
    assert row["revisions_used"] == 1
    assert calls[0][0] == row["brand"]
    assert calls[0][1] == FEE


def test_non_compliant_past_deadline_skips_revision(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer, deadline=FUTURE_DEADLINE)
    _submit(contract, vm, influencer, sponsorship_id)

    patched = _patch_clock(contract, monkeypatch, FUTURE_DEADLINE + 10)
    assert patched is True

    calls, _state = _install_transfer_hook(monkeypatch)
    _resolve(contract, vm, sponsorship_id, "NON_COMPLIANT", 90, "Deadline passed and #ad is missing")

    row = _row(contract, sponsorship_id)
    assert row["status"] == "RESOLVED_NON_COMPLIANT"
    assert row["revisions_used"] == 0
    assert row["settled"] is True
    assert calls[-1][0] == row["brand"]
    assert calls[-1][1] == FEE


def test_expired_with_no_post_refunds_brand(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    other = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer, deadline=PAST_DEADLINE)
    assert _row(contract, sponsorship_id)["status"] == "PENDING_POST"

    vm.sender = influencer
    with pytest.raises(Exception):
        contract.submit_post(sponsorship_id, [POST], [REF1, REF2])

    vm.sender = other
    with pytest.raises(Exception):
        contract.claim_expired_refund(sponsorship_id)

    vm.sender = brand
    with pytest.raises(Exception):
        contract.create_sponsorship(_addr(influencer), "too early", CHECKLIST, FUTURE_DEADLINE)

    calls, _state = _install_transfer_hook(monkeypatch)
    vm.sender = brand
    contract.claim_expired_refund(sponsorship_id)
    row = _row(contract, sponsorship_id)
    assert row["status"] == "EXPIRED_REFUNDED"
    assert row["settled"] is True
    assert row["verdict"] == ""
    assert calls[0][0] == row["brand"]
    assert calls[0][1] == FEE

    with pytest.raises(Exception):
        contract.claim_expired_refund(sponsorship_id)


def test_late_submit_blocked_and_refund_before_deadline_blocked(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer, deadline=FUTURE_DEADLINE)
    vm.sender = brand
    with pytest.raises(Exception):
        contract.claim_expired_refund(sponsorship_id)
    assert _row(contract, sponsorship_id)["status"] == "PENDING_POST"

    patched = _patch_clock(contract, monkeypatch, FUTURE_DEADLINE + 5)
    assert patched is True
    vm.sender = influencer
    with pytest.raises(Exception):
        contract.submit_post(sponsorship_id, [POST], [REF1, REF2])
    assert _row(contract, sponsorship_id)["status"] == "PENDING_POST"


def test_low_confidence_disputed_then_resubmit(direct_vm, direct_deploy, direct_accounts):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer)
    _submit(contract, vm, influencer, sponsorship_id)
    _resolve(contract, vm, sponsorship_id, "COMPLIANT", 59, "Not sure the archive matches the live post")

    row = _row(contract, sponsorship_id)
    assert row["status"] == "DISPUTED"
    assert row["settled"] is False
    assert row["confidence"] == 59
    assert row["fee_amount"] == str(FEE)
    assert vm.run_validator() is True

    with pytest.raises(Exception):
        contract.resolve_sponsorship(sponsorship_id)

    _submit(contract, vm, influencer, sponsorship_id)
    assert _row(contract, sponsorship_id)["status"] == "SUBMITTED"
    _resolve(contract, vm, sponsorship_id, "COMPLIANT", 84, "Archive and post both show #ad and Aurora Bottle")
    row = _row(contract, sponsorship_id)
    assert row["status"] == "RESOLVED_COMPLIANT"
    assert row["settled"] is True
    assert row["confidence"] == 84


def test_web_fail_and_invalid_json(direct_vm, direct_deploy, direct_accounts):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer)
    _submit(contract, vm, influencer, sponsorship_id)

    sim_installMocks(vm, web={}, llm={"verdict": "COMPLIANT", "confidence": 99, "reason": "should not be used"})
    contract.resolve_sponsorship(sponsorship_id)
    row = _row(contract, sponsorship_id)
    assert row["status"] == "DISPUTED"
    assert row["settled"] is False
    assert row["confidence"] == 0
    assert row["verdict"] == ""
    assert "Failed to fetch post URL" in row["verdict_reason"]
    assert vm.run_validator() is True

    _submit(contract, vm, influencer, sponsorship_id)
    sim_installMocks(vm, web=_default_web(), llm="this is not json at all")
    contract.resolve_sponsorship(sponsorship_id)
    row = _row(contract, sponsorship_id)
    assert row["status"] == "DISPUTED"
    assert row["settled"] is False
    assert row["confidence"] == 0
    assert "Failed to parse" in row["verdict_reason"]


def test_missing_urls_empty_checklist_and_same_party_blocked(direct_vm, direct_deploy, direct_accounts):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    vm.sender = brand
    _set_value(vm, FEE)
    with pytest.raises(Exception):
        contract.create_sponsorship(_addr(brand), "self deal", CHECKLIST, FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = brand
    _set_value(vm, FEE)
    with pytest.raises(Exception):
        contract.create_sponsorship(_addr(influencer), "   ", CHECKLIST, FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = brand
    _set_value(vm, FEE)
    with pytest.raises(Exception):
        contract.create_sponsorship(_addr(influencer), "named", [], FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = brand
    _set_value(vm, FEE)
    with pytest.raises(Exception):
        contract.create_sponsorship(_addr(influencer), "named", ["ok", "  "], FUTURE_DEADLINE)
    _clear_value(vm)

    vm.sender = brand
    _set_value(vm, 0)
    with pytest.raises(Exception):
        contract.create_sponsorship(_addr(influencer), "named", CHECKLIST, FUTURE_DEADLINE)
    _clear_value(vm)

    sponsorship_id = _create(contract, vm, brand, influencer)
    vm.sender = influencer
    with pytest.raises(Exception):
        contract.submit_post(sponsorship_id, [], [REF1, REF2])
    with pytest.raises(Exception):
        contract.submit_post(sponsorship_id, [POST], [REF1])
    with pytest.raises(Exception):
        contract.submit_post(sponsorship_id, [POST], [REF1, REF1])
    with pytest.raises(Exception):
        contract.submit_post(
            sponsorship_id,
            [POST],
            [REF1, "https://posts.example.com/other-page"],
        )
    vm.sender = brand
    with pytest.raises(Exception):
        contract.submit_post(sponsorship_id, [POST], [REF1, REF2])
    assert _row(contract, sponsorship_id)["status"] == "PENDING_POST"
    assert contract.get_sponsorship_count() == 1


def test_double_submit_and_double_resolve_blocked(direct_vm, direct_deploy, direct_accounts):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer)
    _submit(contract, vm, influencer, sponsorship_id)
    with pytest.raises(Exception):
        contract.submit_post(sponsorship_id, [POST], [REF1, REF2])
    assert _row(contract, sponsorship_id)["status"] == "SUBMITTED"

    _resolve(contract, vm, sponsorship_id, "COMPLIANT", 90, "All items met")
    assert _row(contract, sponsorship_id)["settled"] is True
    with pytest.raises(Exception):
        contract.resolve_sponsorship(sponsorship_id)
    vm.sender = influencer
    with pytest.raises(Exception):
        contract.retry_resolution(sponsorship_id)


def test_transfer_fail_compliant_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    other = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer)
    _submit(contract, vm, influencer, sponsorship_id)
    calls, state = _install_transfer_hook(monkeypatch, fail=True)
    _resolve(contract, vm, sponsorship_id, "COMPLIANT", 94, "Checklist complete")

    row = _row(contract, sponsorship_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settled"] is False
    assert row["verdict"] == "COMPLIANT"
    assert "Transfer failed" in row["verdict_reason"]
    assert calls == []

    vm.sender = other
    with pytest.raises(Exception):
        contract.retry_resolution(sponsorship_id)

    state["fail"] = False
    vm.sender = influencer
    contract.retry_resolution(sponsorship_id)
    row = _row(contract, sponsorship_id)
    assert row["status"] == "RESOLVED_COMPLIANT"
    assert row["settled"] is True
    assert row["verdict"] == "COMPLIANT"
    assert calls[-1][0] == row["influencer"]
    assert calls[-1][1] == FEE


def test_transfer_fail_final_non_compliant_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer)
    _submit(contract, vm, influencer, sponsorship_id)
    _resolve(contract, vm, sponsorship_id, "NON_COMPLIANT", 90, "Missing #ad")
    assert _row(contract, sponsorship_id)["status"] == "REVISION_REQUESTED"

    _submit(contract, vm, influencer, sponsorship_id)
    calls, state = _install_transfer_hook(monkeypatch, fail=True)
    _resolve(contract, vm, sponsorship_id, "NON_COMPLIANT", 97, "Still missing #ad")

    row = _row(contract, sponsorship_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settled"] is False
    assert row["verdict"] == "NON_COMPLIANT"
    assert "Transfer failed" in row["verdict_reason"]

    state["fail"] = False
    vm.sender = brand
    contract.retry_resolution(sponsorship_id)
    row = _row(contract, sponsorship_id)
    assert row["status"] == "RESOLVED_NON_COMPLIANT"
    assert row["settled"] is True
    assert calls[-1][0] == row["brand"]
    assert calls[-1][1] == FEE


def test_transfer_fail_expired_refund_then_retry(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    sponsorship_id = _create(contract, vm, brand, influencer, deadline=PAST_DEADLINE)
    calls, state = _install_transfer_hook(monkeypatch, fail=True)
    vm.sender = brand
    contract.claim_expired_refund(sponsorship_id)

    row = _row(contract, sponsorship_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["settled"] is False
    assert row["verdict"] == ""
    assert "Expired refund failed" in row["verdict_reason"]

    state["fail"] = False
    vm.sender = influencer
    contract.retry_resolution(sponsorship_id)
    row = _row(contract, sponsorship_id)
    assert row["status"] == "EXPIRED_REFUNDED"
    assert row["settled"] is True
    assert row["verdict"] == ""
    assert calls[-1][0] == row["brand"]
    assert calls[-1][1] == FEE


def test_list_and_owner(direct_vm, direct_deploy, direct_accounts):
    brand = direct_accounts[1]
    influencer = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    owner = contract.get_owner()
    assert isinstance(owner, str)
    assert owner.startswith("0x")

    first = _create(contract, vm, brand, influencer)
    second = _create(contract, vm, brand, influencer, description="Second drop for Aurora Bottle")
    assert first == "0"
    assert second == "1"
    rows = _parse_list(contract.list_sponsorships())
    assert len(rows) == 2
    assert rows[0]["fee_amount"] == str(FEE)
    assert rows[1]["campaign_description"] == "Second drop for Aurora Bottle"
    assert contract.get_sponsorship_count() == 2
