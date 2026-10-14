# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
from dataclasses import dataclass
from datetime import datetime, timezone
import json

UserError = gl.vm.UserError

MIN_CONFIDENCE = 60
VALID_VERDICTS = ("COMPLIANT", "NON_COMPLIANT")
RENDER_CHAR_CAP = 6000


def _addr_str(a) -> str:
    try:
        return a.as_hex.lower()
    except Exception:
        s = str(a).lower()
        if not s.startswith("0x") and len(s) == 40:
            return "0x" + s
        return s


def _to_address(val) -> Address:
    if isinstance(val, Address):
        return val
    if isinstance(val, str):
        val_str = val.strip()
        if not val_str.startswith("0x"):
            val_str = "0x" + val_str
        return Address(val_str)
    if hasattr(val, "as_hex"):
        return val
    return Address(val)


def _same_addr(a, b) -> bool:
    return _addr_str(a) == _addr_str(b)


def _current_unix_timestamp() -> u256:
    """Verified clock: gl.message.datetime (ISO-8601). Never gl.block.timestamp."""
    raw = None
    try:
        raw = getattr(gl.message, "datetime", None)
    except Exception:
        raw = None
    if raw is None or str(raw).strip() == "":
        try:
            raw = gl.message_raw.get("datetime")
        except Exception:
            raw = None
    if raw is not None and str(raw).strip() != "":
        dt_str = str(raw).strip()
        if dt_str.endswith("Z"):
            dt_str = dt_str[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(dt_str)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return u256(int(dt.timestamp()))
        except Exception as err:
            raise UserError("Invalid execution timestamp format from GenVM message: " + str(err))
    return u256(int(datetime.now(timezone.utc).timestamp()))


def _now() -> int:
    return int(_current_unix_timestamp())


def _str_list(values) -> list:
    out = []
    try:
        n = len(values)
    except Exception:
        return out
    for i in range(n):
        out.append(str(values[i]))
    return out


def _clean_checklist(items) -> list:
    cleaned = []
    try:
        n = len(items)
    except Exception:
        n = 0
    for i in range(n):
        text = str(items[i]).strip()
        if len(text) == 0:
            raise UserError("Checklist items cannot be empty")
        cleaned.append(text)
    if len(cleaned) < 1:
        raise UserError("At least 1 requirement is needed in the checklist")
    return cleaned


def _url_host(url: str) -> str:
    s = str(url).strip().lower()
    if s.startswith("https://"):
        s = s[8:]
    elif s.startswith("http://"):
        s = s[7:]
    else:
        raise UserError("Invalid URL: must start with http:// or https://")
    for sep in ("/", "?", "#"):
        cut = s.find(sep)
        if cut >= 0:
            s = s[:cut]
    if "@" in s:
        s = s.split("@")[-1]
    if ":" in s:
        s = s.split(":")[0]
    if s.startswith("www."):
        s = s[4:]
    if len(s) == 0:
        raise UserError("Could not parse URL host")
    return s


def _clean_http_urls(urls, kind: str, minimum: int) -> list:
    cleaned = []
    try:
        n = len(urls)
    except Exception:
        n = 0
    for i in range(n):
        url = str(urls[i]).strip()
        if len(url) == 0:
            continue
        if not (url.startswith("http://") or url.startswith("https://")):
            raise UserError("Invalid " + kind + " URL: must start with http:// or https://")
        cleaned.append(url)
    if len(cleaned) < minimum:
        raise UserError("At least " + str(minimum) + " " + kind + " URL(s) required")
    return cleaned


def _assert_independent_sources(post_urls, reference_urls) -> None:
    if len(reference_urls) < 2:
        raise UserError("At least 2 independent reference URLs required")
    post_hosts = []
    for u in post_urls:
        post_hosts.append(_url_host(u))
    ref_hosts = []
    for u in reference_urls:
        ref_hosts.append(_url_host(u))
    if len(set(ref_hosts)) < 2:
        raise UserError("Reference URLs must be independent websites (different hosts)")
    for h in ref_hosts:
        if h in post_hosts:
            raise UserError("Reference URL host must not match a post URL host: " + h)


def _bound_page_text(text) -> str:
    s = str(text or "")
    s = s.replace("<<<", "[").replace(">>>", "]").replace("```", "'''")
    if len(s) > RENDER_CHAR_CAP:
        s = s[:RENDER_CHAR_CAP]
    return s


def _page_text(res) -> str:
    if hasattr(res, "body"):
        return str(res.body)
    if hasattr(res, "text"):
        return str(res.text)
    if isinstance(res, dict):
        if "body" in res:
            return str(res["body"])
        if "text" in res:
            return str(res["text"])
        ok = res.get("ok")
        if isinstance(ok, dict):
            if "text" in ok:
                return str(ok["text"])
            if "body" in ok:
                return str(ok["body"])
    return str(res)


def _fetch_page(url: str) -> str:
    """A blocked social page must not roll the whole resolve back."""
    try:
        res = gl.nondet.web.render(url)
    except Exception as e:
        return "FETCH_FAILED: " + str(e)
    text = _page_text(res).strip()
    if len(text) == 0:
        return "FETCH_FAILED: empty page"
    return _bound_page_text(text)


def _leader_payload(leader_res):
    for attr in ("value", "calldata"):
        try:
            payload = getattr(leader_res, attr)
        except Exception:
            continue
        if isinstance(payload, dict):
            return payload
    if isinstance(leader_res, dict):
        return leader_res
    return None


def _extract_result(result) -> dict:
    payload = _leader_payload(result)
    if payload is None and isinstance(result, dict):
        payload = result
    if not isinstance(payload, dict):
        raise UserError("Invalid nondet consensus result")
    return payload


def _parse_verdict(raw) -> dict:
    if isinstance(raw, dict) and "verdict" in raw and "confidence" in raw and "reason" in raw:
        data = raw
    elif isinstance(raw, dict):
        data = raw
    else:
        cleaned = str(raw).strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if len(lines) >= 1 and lines[0].startswith("```"):
                lines = lines[1:]
            if len(lines) >= 1 and lines[-1].startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()
        try:
            data = json.loads(cleaned)
        except Exception as e:
            return {
                "verdict": "",
                "confidence": 0,
                "reason": "Failed to parse LLM response. Error: " + str(e),
            }

    if not isinstance(data, dict):
        return {
            "verdict": "",
            "confidence": 0,
            "reason": "AI verdict response must be a JSON object",
        }

    verdict = str(data.get("verdict", "")).strip().upper()
    if verdict not in VALID_VERDICTS:
        provided = str(data.get("reason", "")).strip()
        if verdict == "" and provided:
            reason = provided
        else:
            reason = "verdict must be COMPLIANT or NON_COMPLIANT — got: " + verdict
            if provided:
                reason = reason + " " + provided
        if len(reason) > 800:
            reason = reason[:800]
        return {
            "verdict": "",
            "confidence": 0,
            "reason": reason,
        }

    try:
        conf = int(data.get("confidence", 0))
    except Exception:
        conf = 0
    if conf < 0 or conf > 100:
        conf = 0

    reason = str(data.get("reason", ""))
    if len(reason) > 800:
        reason = reason[:800]
    return {
        "verdict": verdict,
        "confidence": conf,
        "reason": reason,
    }


def _vote_ok(verdict: str, conf: int) -> bool:
    if verdict in VALID_VERDICTS:
        return True
    return verdict == "" and conf < MIN_CONFIDENCE


def _consensus_accepts(leader_verdict, leader_conf, my_verdict, my_conf) -> bool:
    """Absolute equality on the binary verdict and on the settle-vs-dispute branch."""
    try:
        lc = int(leader_conf)
        mc = int(my_conf)
    except Exception:
        return False
    if not (0 <= lc <= 100 and 0 <= mc <= 100):
        return False
    lv = str(leader_verdict or "").strip().upper()
    mv = str(my_verdict or "").strip().upper()
    if not _vote_ok(lv, lc) or not _vote_ok(mv, mc):
        return False
    if mv != lv:
        return False
    return (mc >= MIN_CONFIDENCE) == (lc >= MIN_CONFIDENCE)


def _pay(recipient, amount) -> None:
    gl.get_contract_at(_to_address(recipient)).emit_transfer(value=u256(amount))


@allow_storage
@dataclass
class Sponsorship:
    brand: Address
    influencer: Address
    campaign_description: str
    requirements_checklist: DynArray[str]
    fee_amount: bigint
    post_deadline: u256
    post_urls: DynArray[str]
    reference_urls: DynArray[str]
    revisions_used: u256
    status: str
    verdict: str
    verdict_reason: str
    confidence: u256
    settled: bool


class Contract(gl.Contract):
    owner: Address
    sponsorship_counter: bigint
    sponsorships: TreeMap[str, Sponsorship]

    def __init__(self):
        self.owner = _to_address(gl.message.sender_address)
        self.sponsorship_counter = bigint(0)

    @gl.public.write.payable
    def create_sponsorship(
        self,
        influencer: Address,
        campaign_description: str,
        requirements_checklist: DynArray[str],
        post_deadline: u256,
    ) -> str:
        fee = bigint(gl.message.value)
        if fee <= bigint(0):
            raise UserError("Must send GEN as sponsorship fee (amount must be > 0)")
        if not campaign_description or len(campaign_description.strip()) == 0:
            raise UserError("Campaign description cannot be empty")
        sender = _to_address(gl.message.sender_address)
        influencer_addr = _to_address(influencer)
        if _same_addr(influencer_addr, sender):
            raise UserError("Brand and influencer cannot be the same address")
        if int(post_deadline) <= 0:
            raise UserError("Post deadline must be a unix timestamp in the future")
        cleaned = _clean_checklist(requirements_checklist)

        sponsorship_id = str(self.sponsorship_counter)
        self.sponsorship_counter = self.sponsorship_counter + bigint(1)

        self.sponsorships[sponsorship_id] = Sponsorship(
            brand=sender,
            influencer=influencer_addr,
            campaign_description=campaign_description.strip(),
            requirements_checklist=cleaned,
            fee_amount=fee,
            post_deadline=u256(post_deadline),
            post_urls=[],
            reference_urls=[],
            revisions_used=u256(0),
            status="PENDING_POST",
            verdict="",
            verdict_reason="",
            confidence=u256(0),
            settled=False,
        )
        return sponsorship_id

    @gl.public.write
    def submit_post(self, sponsorship_id: str, post_urls: DynArray[str], reference_urls: DynArray[str]) -> None:
        if sponsorship_id not in self.sponsorships:
            raise UserError("Sponsorship does not exist")
        s = self.sponsorships[sponsorship_id]
        if not _same_addr(gl.message.sender_address, s.influencer):
            raise UserError("Only the influencer can submit the post")
        if s.status not in ["PENDING_POST", "REVISION_REQUESTED", "DISPUTED"]:
            raise UserError("Cannot submit post in status: " + str(s.status))
        if _now() > int(s.post_deadline):
            raise UserError("Post submission deadline has passed")

        cleaned_posts = _clean_http_urls(post_urls, "post", 1)
        cleaned_refs = _clean_http_urls(reference_urls, "independent reference", 2)
        _assert_independent_sources(cleaned_posts, cleaned_refs)

        s.post_urls = cleaned_posts
        s.reference_urls = cleaned_refs
        s.status = "SUBMITTED"
        self.sponsorships[sponsorship_id] = s

    @gl.public.write
    def claim_expired_refund(self, sponsorship_id: str) -> None:
        """Brand takes the full fee back if the deadline passed with no accepted post."""
        if sponsorship_id not in self.sponsorships:
            raise UserError("Sponsorship does not exist")
        s = self.sponsorships[sponsorship_id]
        if not _same_addr(gl.message.sender_address, s.brand):
            raise UserError("Only brand can claim this refund")
        if s.settled:
            raise UserError("Sponsorship already settled")
        if s.status not in ["PENDING_POST", "REVISION_REQUESTED", "DISPUTED"]:
            raise UserError("Refund only available while no post has been accepted or in final review")
        if _now() <= int(s.post_deadline):
            raise UserError("Post deadline has not passed yet")

        s.status = "EXPIRED_REFUNDED"
        self.sponsorships[sponsorship_id] = s
        try:
            _pay(s.brand, s.fee_amount)
            s.settled = True
            s.status = "EXPIRED_REFUNDED"
        except Exception as e:
            s.settled = False
            s.status = "PAYOUT_FAILED"
            s.verdict_reason = "Expired refund failed: " + str(e)
        self.sponsorships[sponsorship_id] = s

    @gl.public.write
    def resolve_sponsorship(self, sponsorship_id: str) -> None:
        if sponsorship_id not in self.sponsorships:
            raise UserError("Sponsorship does not exist")
        s = self.sponsorships[sponsorship_id]
        if s.settled:
            raise UserError("Sponsorship already settled")
        if s.status != "SUBMITTED":
            raise UserError("Sponsorship not ready for resolution (status: " + str(s.status) + ")")

        description = str(s.campaign_description)
        checklist = _str_list(s.requirements_checklist)
        post_urls_list = _str_list(s.post_urls)
        reference_urls_list = _str_list(s.reference_urls)

        def leader_fn() -> dict:
            post_contents = []
            post_failures = 0
            for url in post_urls_list:
                text = _fetch_page(url)
                if text.startswith("FETCH_FAILED"):
                    post_failures = post_failures + 1
                post_contents.append("[" + url + "]: " + text)

            reference_contents = []
            for url in reference_urls_list:
                text = _fetch_page(url)
                reference_contents.append("[" + url + "]: " + text)

            if len(post_urls_list) > 0 and post_failures == len(post_urls_list):
                failed_url = post_urls_list[0]
                return {
                    "verdict": "",
                    "confidence": 0,
                    "reason": "Failed to fetch post URL: " + failed_url,
                }

            prompt = "You are a neutral influencer sponsorship compliance adjudicator.\n"
            prompt += "Campaign: \"" + description + "\"\n"
            prompt += "Requirements checklist (ALL must be satisfied): " + str(checklist) + "\n"
            prompt += "Influencer's published post content: " + str(post_contents) + "\n"
            prompt += "Independent references (archived copies, platform disclosure policy — prioritize these if they contradict the post content): " + str(reference_contents) + "\n\n"
            prompt += "Decide strictly one of two outcomes:\n"
            prompt += "- \"COMPLIANT\": the post satisfies EVERY item in the checklist.\n"
            prompt += "- \"NON_COMPLIANT\": at least one checklist item is missing, or the evidence is insufficient to confirm it.\n"
            prompt += "If a post page is marked FETCH_FAILED, do not mark COMPLIANT.\n\n"
            prompt += "Return ONLY raw JSON, no markdown:\n"
            prompt += "{\"verdict\": \"COMPLIANT\" | \"NON_COMPLIANT\", \"confidence\": <0-100>, \"reason\": \"<short justification naming which items were met or missed>\"}"

            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return _parse_verdict(raw)

        def validator_fn(leader_res) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False
            leader_payload = _leader_payload(leader_res)
            if not isinstance(leader_payload, dict):
                return False
            try:
                my_res = leader_fn()
            except Exception:
                return False
            parsed_leader = _parse_verdict(leader_payload)
            return _consensus_accepts(
                parsed_leader["verdict"],
                parsed_leader["confidence"],
                my_res["verdict"],
                my_res["confidence"],
            )

        result = _parse_verdict(_extract_result(gl.vm.run_nondet(leader_fn, validator_fn)))

        s.verdict = result["verdict"]
        s.confidence = u256(int(result["confidence"]))
        s.verdict_reason = result["reason"]

        if int(result["confidence"]) < MIN_CONFIDENCE or result["verdict"] not in VALID_VERDICTS:
            s.status = "DISPUTED"
            self.sponsorships[sponsorship_id] = s
            return

        if result["verdict"] == "NON_COMPLIANT":
            if int(s.revisions_used) < 1 and _now() <= int(s.post_deadline):
                s.revisions_used = u256(int(s.revisions_used) + 1)
                s.status = "REVISION_REQUESTED"
                self.sponsorships[sponsorship_id] = s
                return

        self.sponsorships[sponsorship_id] = s
        self._execute_settlement(sponsorship_id)

    def _execute_settlement(self, sponsorship_id: str) -> None:
        """Pay the party already chosen by the binary verdict. No percent math."""
        s = self.sponsorships[sponsorship_id]
        if s.settled:
            raise UserError("Sponsorship already settled")

        if s.verdict == "COMPLIANT":
            recipient = s.influencer
            success_status = "RESOLVED_COMPLIANT"
        elif s.verdict == "NON_COMPLIANT":
            recipient = s.brand
            success_status = "RESOLVED_NON_COMPLIANT"
        else:
            raise UserError("No binary verdict to settle")

        s.status = success_status
        self.sponsorships[sponsorship_id] = s
        try:
            _pay(recipient, s.fee_amount)
            s.settled = True
            s.status = success_status
        except Exception as e:
            s.settled = False
            s.status = "PAYOUT_FAILED"
            s.verdict_reason = s.verdict_reason + " (Transfer failed: " + str(e) + ")"
        self.sponsorships[sponsorship_id] = s

    @gl.public.write
    def retry_resolution(self, sponsorship_id: str) -> None:
        """Replay the payout from the stored verdict. Does not run AI again."""
        if sponsorship_id not in self.sponsorships:
            raise UserError("Sponsorship does not exist")
        s = self.sponsorships[sponsorship_id]
        sender = _to_address(gl.message.sender_address)
        if not (_same_addr(sender, s.brand) or _same_addr(sender, s.influencer)):
            raise UserError("Only brand or influencer can retry")
        if s.status != "PAYOUT_FAILED":
            raise UserError("Can only retry PAYOUT_FAILED sponsorships")
        if s.settled:
            raise UserError("Sponsorship already settled")

        if str(s.verdict) == "":
            s.status = "EXPIRED_REFUNDED"
            self.sponsorships[sponsorship_id] = s
            try:
                _pay(s.brand, s.fee_amount)
                s.settled = True
                s.status = "EXPIRED_REFUNDED"
            except Exception as e:
                s.settled = False
                s.status = "PAYOUT_FAILED"
                s.verdict_reason = s.verdict_reason + " (Retry failed again: " + str(e) + ")"
            self.sponsorships[sponsorship_id] = s
            return

        self._execute_settlement(sponsorship_id)

    def _sponsorship_dict(self, sponsorship_id: str, s) -> dict:
        return {
            "sponsorship_id": sponsorship_id,
            "brand": _addr_str(s.brand),
            "influencer": _addr_str(s.influencer),
            "campaign_description": str(s.campaign_description),
            "requirements_checklist": _str_list(s.requirements_checklist),
            "fee_amount": str(int(s.fee_amount)),
            "post_deadline": str(int(s.post_deadline)),
            "post_urls": _str_list(s.post_urls),
            "reference_urls": _str_list(s.reference_urls),
            "revisions_used": int(s.revisions_used),
            "status": str(s.status),
            "verdict": str(s.verdict),
            "verdict_reason": str(s.verdict_reason),
            "confidence": int(s.confidence),
            "settled": bool(s.settled),
        }

    @gl.public.view
    def get_sponsorship(self, sponsorship_id: str) -> str:
        if sponsorship_id not in self.sponsorships:
            raise UserError("Sponsorship does not exist")
        return json.dumps(self._sponsorship_dict(sponsorship_id, self.sponsorships[sponsorship_id]))

    @gl.public.view
    def list_sponsorships(self) -> str:
        results = []
        n = int(self.sponsorship_counter)
        for i in range(n):
            sid = str(i)
            if sid in self.sponsorships:
                results.append(self._sponsorship_dict(sid, self.sponsorships[sid]))
        return json.dumps(results)

    @gl.public.view
    def get_sponsorship_count(self) -> int:
        return int(self.sponsorship_counter)

    @gl.public.view
    def get_owner(self) -> str:
        return _addr_str(self.owner)
