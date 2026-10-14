# SponsorCheck — Neutral influencer sponsorship escrow on GenLayer

Brands pay influencers up front and then argue about whether the post matched the brief. Influencers worry the brand will claw the fee back after a post that did meet the brief. Small deals cannot afford a human referee.

SponsorCheck holds the sponsorship fee in **one Intelligent Contract**. The brand locks real GEN, the influencer submits the post plus at least two independent references, and GenLayer AI returns exactly one of two verdicts:

`COMPLIANT` · `NON_COMPLIANT`

There is no percentage, no tolerance band, and no second money figure. The whole `fee_amount` goes to the influencer or back to the brand.

> SponsorCheck dies without GenLayer: no EVM contract can read a social post and match it to a natural-language checklist, and no third party is cheap enough to referee each small brand-influencer deal. Only GenLayer's decentralized AI consensus can do this at near-zero cost.

## Live app

Not deployed yet. The frontend boots without a contract address (warning banner, writes disabled, no white screen).

## Deployed contract

- **Network:** studionet only
- **Address:** `0xCdC820B2961F728122954E8a3BdD696B2a912CC9`
- **Explorer:** https://genlayer-explorer.vercel.app/address/0xCdC820B2961F728122954E8a3BdD696B2a912CC9

## Why one revision, and why the verdict is binary

Missing `#ad` is a fixable mistake. Taking the whole fee for that, on the first try, would make the product unusable. The first `NON_COMPLIANT` while the deadline is still open moves the deal to `REVISION_REQUESTED` and does **not** move GEN. `revisions_used` becomes 1. A later `NON_COMPLIANT`, or a `NON_COMPLIANT` after the deadline, refunds the brand.

JobVerdict was rejected because a percent tolerance let two validators "agree" while locking two different amounts. SponsorCheck validators compare with absolute equality:

- the verdict string is identical (`COMPLIANT` or `NON_COMPLIANT`)
- both confidences are on the same side of 60 (`>= 60` settles, `< 60` is `DISPUTED`)

No numeric tolerance. Confidence never scales the fee.

## Why one contract

The brand sends GEN into this contract on `create_sponsorship`. Payouts use `gl.get_contract_at(recipient).emit_transfer(value=u256(fee_amount))`. There is no second contract and no value-forward hop.

## Resolution flow

1. **Create** — brand sets influencer, campaign text, checklist (at least one item), post deadline, and attaches `fee_amount` GEN. Brand and influencer must differ.
2. **Submit** — only the influencer, and only while status is `PENDING_POST`, `REVISION_REQUESTED`, or `DISPUTED`, and only before the deadline. At least 1 post URL and 2 reference URLs on different hosts, and reference hosts must differ from the post host. Status becomes `SUBMITTED`.
3. **Resolve** — anyone can call `resolve_sponsorship` while status is `SUBMITTED`. `gl.vm.run_nondet` renders each URL and asks for JSON `{verdict, confidence, reason}`.
4. `confidence < 60`, an empty verdict, or unparseable JSON → `DISPUTED`. The fee stays put. The influencer may submit again.
5. If every post URL fails to render, the contract does not ask the model and does not pay anyone. Status becomes `DISPUTED` with reason `Failed to fetch post URL: ...`, so the influencer can submit an archive link. A hard revert would leave status `SUBMITTED`, and `submit_post` cannot replace URLs in that status.
6. `NON_COMPLIANT` with `revisions_used == 0` and `now <= post_deadline` → `REVISION_REQUESTED`. Fee stays put.
7. Otherwise `_execute_settlement` pays the full fee: influencer on `COMPLIANT` (`RESOLVED_COMPLIANT`), brand on `NON_COMPLIANT` (`RESOLVED_NON_COMPLIANT`).
8. A failed transfer sets `PAYOUT_FAILED` and keeps the verdict. `retry_resolution` (brand or influencer) pays the same party again and does not rerun AI. An expired refund that failed has an empty verdict; retry pays the brand and finishes as `EXPIRED_REFUNDED`.
9. If the deadline passes while status is still `PENDING_POST`, `REVISION_REQUESTED`, or `DISPUTED`, the brand calls `claim_expired_refund`. No AI.

Status is written to the success value before `emit_transfer`, so a re-entrant resolve no longer sees `SUBMITTED`.

## Honest limit — blocked social networks

Many networks (Instagram, TikTok) block automated reads or require a login, so `gl.nondet.web.render` may not see the post. That is a limit of the data source, not a bug in the contract. The reliable inputs are public posts (X, YouTube, blogs) or a timestamped archive of the post, plus a second independent page (platform disclosure rules, a second archive). The submit step in the UI says this in the banner, and the contract treats a total post-fetch failure as `DISPUTED` instead of guessing.

## Verified APIs

| Need | API used | Do not use |
|---|---|---|
| Caller | `gl.message.sender_address` | `gl.message.sender` |
| Pay GEN | `gl.get_contract_at(addr).emit_transfer(value=u256(amount))` | `gl.transfer(...)` |
| Receive GEN | `@gl.public.write.payable` + `gl.message.value` on `create_sponsorship` | plain `@gl.public.write` when attaching GEN (current Studio raises `called non-payable method`) |
| Timestamp | `gl.message.datetime` parsed with `datetime.fromisoformat` via `_current_unix_timestamp` | `gl.block.timestamp` |
| TreeMap default | `map.get(key, default)` is available; this contract uses `in` plus index walks | — |

Header copied from the current Studio template and the hash used by the latest contracts in this workspace (AuditBounty, CredentialCheck, CargoVerdict):

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

An older note that `@gl.public.write.payable` "does not exist" is wrong for this Studio runner. CargoVerdict and AuditBounty both deploy with the same Depends hash and mark value-receiving methods `.payable`. Only `create_sponsorship` is payable. Every other write is `@gl.public.write`.

### Write methods

- `create_sponsorship(influencer, campaign_description, requirements_checklist, post_deadline) -> sponsorship_id` — attach GEN `> 0`
- `submit_post(sponsorship_id, post_urls, reference_urls)` — influencer only
- `resolve_sponsorship(sponsorship_id)` — AI, only from `SUBMITTED`
- `claim_expired_refund(sponsorship_id)` — brand only, deadline passed, no accepted post
- `retry_resolution(sponsorship_id)` — brand or influencer, only `PAYOUT_FAILED`

### View methods

All views return JSON text except the count and owner:

- `get_sponsorship(sponsorship_id) -> str`
- `list_sponsorships() -> str`
- `get_sponsorship_count() -> int`
- `get_owner() -> str`

`fee_amount` and `post_deadline` are decimal integer strings, never JSON numbers, so the browser does not round them.

## Money handling — one field only

`fee_amount` is the only money field. It is the full sponsorship fee in wei (10^18 base units per GEN). Nothing in the contract or the frontend multiplies it by a percent.

| Step | Where | What happens |
|---|---|---|
| WRITE | `frontend/src/App.jsx` create form | Chip or typed GEN string → `parseGenToWei` → `writeContract({ value })` |
| WRITE | `create_sponsorship` | `fee = bigint(gl.message.value)` stored on `Sponsorship.fee_amount` |
| WRITE | `_execute_settlement` | `emit_transfer(value=u256(s.fee_amount))` to influencer or brand |
| WRITE | `claim_expired_refund` and the empty-verdict branch of `retry_resolution` | same full `fee_amount` back to the brand |
| READ | `get_sponsorship` / `list_sponsorships` | `str(int(fee_amount))` inside JSON |
| READ | `frontend/src/App.jsx` | `readWei` (digit string or bigint only) → `formatWeiToGen` |

`parseGenToWei` and `formatWeiToGen` are string splits plus `BigInt`. They do not call `parseFloat`, `Math.round`, `Math.floor`, or `Math.ceil`. `scripts/check-no-float-money.js` scans `frontend/src/**/*.{js,jsx}` and fails the build if those calls sit near `fee`, `amount`, `payout`, `refund`, `balance`, `wei`, or `gen`. The frontend `prebuild` script runs it.

Display chips such as `1 GEN` are labels. The value that leaves the browser is the wei integer from `parseGenToWei`.

## Deploy on studionet (manual)

Do this in GenLayer Studio. Do not switch the app to another chain.

1. Open [GenLayer Studio](https://studio.genlayer.com) on **studionet**.
2. Create a contract and paste `contracts/sponsor_check.py` unchanged, including the two header lines.
3. Deploy. Wait until the receipt says **Result: SUCCESS**.
4. Copy the contract address and send it back. The next step sets `frontend/.env` as `VITE_CONTRACT_ADDRESS=0x...`, builds, pushes, and deploys the frontend.

Local preview without that address:

```bash
cd frontend
npm install
npm run dev
```

The page must show the missing-address banner and the free-to-use banner. Creating a deal shows an error instead of a blank page.

## Tests

```bash
pip install -r requirements.txt
python -m pytest tests/test_sponsor_check.py -q
cd frontend && npm test
```

Covered paths: compliant payout to the influencer, first non-compliant revision with the fee untouched then a compliant resubmit, non-compliant after the one revision refunds the brand, non-compliant after the deadline skips revision, expired deal with no post refunds the brand, late submit blocked, confidence below 60 disputes then a resubmit can resolve, web fetch failure and broken JSON dispute without paying, empty checklist / missing URLs / same party blocked, double submit and double resolve blocked, and a forced `emit_transfer` failure on all three payout branches (compliant, final non-compliant, expired refund) followed by `retry_resolution` to the correct recipient.

## Frontend

Checklist items are checkboxes. One optional short custom line. Fee chips plus a numeric field. Deadline is a dropdown: 24 hours, 3 days, 7 days, 14 days. Post and reference rows have a paste button. The submit step shows the archive / Instagram warning. `REVISION_REQUESTED` says the influencer still has one fix. `DISPUTED` can resubmit. `PAYOUT_FAILED` has **Try again**. The sticky banner states that the only cost is GenLayer gas.

Wallet traffic stays on `chains.studionet`. Reads go through `/api/genlayer`, which Vercel and the Vite dev server proxy to `https://studio.genlayer.com/api`.
