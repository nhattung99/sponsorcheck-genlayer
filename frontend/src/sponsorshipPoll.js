export const STUDIO_RPC = 'https://studio.genlayer.com/api';
export const VIEW_FROM = '0x0000000000000000000000000000000000000001';

export function studioRpcUrl(origin) {
  if (!origin || typeof origin !== 'string') return STUDIO_RPC;
  return `${origin.replace(/\/$/, '')}/api/genlayer`;
}

export function formatWalletError(err, fallback = 'Wallet request failed') {
  const raw = `${err?.shortMessage || ''} ${err?.details || ''} ${err?.message || ''}`.toLowerCase();
  if (raw.includes('user rejected') || raw.includes('user denied') || raw.includes('user cancel')) {
    return 'MetaMask cancelled the request. Switch to Genlayer Studio Network, then click Confirm.';
  }
  if (raw.includes('no address provided') || raw.includes('no account')) {
    return 'Connect a wallet first, then try again.';
  }
  if (raw.includes('unrecognized chain') || raw.includes('chain disconnected') || raw.includes('4902')) {
    return 'Approve adding Genlayer Studio Network in MetaMask, then send the transaction again.';
  }
  return err?.shortMessage || err?.message || fallback;
}

export function sameAddress(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function resolveReadAccount(account) {
  if (typeof account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(account)) {
    return { address: account };
  }
  if (account && typeof account === 'object' && typeof account.address === 'string') {
    return { address: account.address };
  }
  return { address: VIEW_FROM };
}

export function unwrapViewResult(res) {
  if (res === null || res === undefined) return res;
  if (typeof res === 'bigint') return Number(res);
  if (typeof res === 'number' || typeof res === 'boolean') return res;
  if (res instanceof Uint8Array) {
    return unwrapViewResult(new TextDecoder().decode(res));
  }
  if (res instanceof Map) {
    return unwrapViewResult(Object.fromEntries(res));
  }
  if (typeof res === 'object') {
    if (Array.isArray(res)) return res.map((item) => unwrapViewResult(item));
    if ('result' in res) return unwrapViewResult(res.result);
    if ('data' in res && (typeof res.data === 'string' || Array.isArray(res.data))) {
      return unwrapViewResult(res.data);
    }
    return res;
  }
  if (typeof res !== 'string') return res;

  const trimmed = res.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length > 4 && trimmed.length % 2 === 0) {
    try {
      const hex = trimmed.slice(2);
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      const text = new TextDecoder().decode(bytes).trim();
      if (text.startsWith('[') || text.startsWith('{') || /^\d+$/.test(text)) {
        return unwrapViewResult(text);
      }
    } catch {
      // keep original string
    }
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return unwrapViewResult(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function normalizeSponsorshipRow(row, fallbackId) {
  if (row === null || row === undefined) return null;
  const unwrapped = unwrapViewResult(row);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return null;
  const id = unwrapped.sponsorship_id ?? unwrapped.id ?? fallbackId;
  if (id === null || id === undefined || id === '') return null;
  return { ...unwrapped, sponsorship_id: String(id) };
}

export function normalizeSponsorshipList(raw) {
  const unwrapped = unwrapViewResult(raw);
  if (Array.isArray(unwrapped)) {
    return unwrapped
      .map((row, index) => normalizeSponsorshipRow(row, String(index)))
      .filter(Boolean);
  }
  if (unwrapped && typeof unwrapped === 'object' && Array.isArray(unwrapped.sponsorships)) {
    return normalizeSponsorshipList(unwrapped.sponsorships);
  }
  const single = normalizeSponsorshipRow(unwrapped);
  return single ? [single] : [];
}

export function parseCount(raw) {
  const unwrapped = unwrapViewResult(raw);
  if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return unwrapped;
  if (typeof unwrapped === 'string' && /^\d+$/.test(unwrapped)) return Number(unwrapped);
  if (unwrapped && typeof unwrapped === 'object' && unwrapped.count != null) {
    return parseCount(unwrapped.count);
  }
  return null;
}

export function shouldKeepPolling({ previousCount, currentCount, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  if (typeof currentCount === 'number' && currentCount > previousCount) return false;
  if (rows.length > previousCount) return false;
  return true;
}

export function newestSponsorshipId(rows) {
  let best = null;
  let bestN = -1n;
  for (const row of rows || []) {
    const id = String(row?.sponsorship_id ?? '');
    if (!/^\d+$/.test(id)) continue;
    const n = BigInt(id);
    if (best === null || n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

export async function pollUntilListed({
  previousCount,
  load,
  attempts = 20,
  intervalMs = 2000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let last = { rows: [], count: previousCount };
  for (let i = 0; i < attempts; i += 1) {
    last = await load();
    if (!shouldKeepPolling({ previousCount, currentCount: last.count, rows: last.rows })) {
      return last;
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return last;
}

export async function pollUntilStatusChanges({
  loadRow,
  fromStatus,
  attempts = 36,
  intervalMs = 5000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await loadRow();
    const status = String(last?.status || '');
    if (status && status !== fromStatus) return last;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return last;
}

export function deadlinePassed(unixStr, nowMs = Date.now()) {
  const raw = String(unixStr ?? '').trim();
  if (!/^\d+$/.test(raw)) return false;
  const nowSec = BigInt(nowMs) / 1000n;
  return nowSec > BigInt(raw);
}

export function formatDeadline(unixStr) {
  const raw = String(unixStr ?? '').trim();
  if (!/^\d+$/.test(raw)) return '—';
  const sec = Number(raw);
  if (!Number.isFinite(sec)) return raw;
  try {
    return new Date(sec * 1000).toUTCString();
  } catch {
    return raw;
  }
}

export function urlHost(url) {
  let s = String(url || '').trim().toLowerCase();
  if (s.startsWith('https://')) s = s.slice(8);
  else if (s.startsWith('http://')) s = s.slice(7);
  else return '';
  const cutAt = ['/', '?', '#'].map((sep) => s.indexOf(sep)).filter((n) => n >= 0);
  if (cutAt.length) {
    let cut = cutAt[0];
    for (const n of cutAt) if (n < cut) cut = n;
    s = s.slice(0, cut);
  }
  if (s.includes('@')) s = s.split('@').pop();
  if (s.includes(':')) s = s.split(':')[0];
  if (s.startsWith('www.')) s = s.slice(4);
  return s;
}

export function independentSourceError(postUrls, referenceUrls) {
  const posts = (postUrls || []).map((u) => String(u).trim()).filter(Boolean);
  const refs = (referenceUrls || []).map((u) => String(u).trim()).filter(Boolean);
  if (posts.length < 1) return 'At least 1 post URL is required.';
  if (refs.length < 2) return 'At least 2 independent reference URLs are required.';
  const postHosts = posts.map(urlHost);
  const refHosts = refs.map(urlHost);
  if (postHosts.some((h) => !h) || refHosts.some((h) => !h)) {
    return 'Every link must start with http:// or https://.';
  }
  if (new Set(refHosts).size < 2) {
    return 'The two reference sources must be on different websites.';
  }
  for (const host of refHosts) {
    if (postHosts.includes(host)) {
      return 'A reference source must be on a different website from the post.';
    }
  }
  return '';
}

export const FLOW_STEPS = [
  { id: 'create', label: '1. Create' },
  { id: 'submit', label: '2. Submit post' },
  { id: 'ai', label: '3. AI check' },
  { id: 'done', label: '4. Payout' },
];

export function flowCurrentStep(status) {
  const s = String(status || '');
  if (!s) return 'create';
  if (s === 'PENDING_POST' || s === 'REVISION_REQUESTED' || s === 'DISPUTED') return 'submit';
  if (s === 'SUBMITTED') return 'ai';
  return 'done';
}

export function statusLabel(status) {
  const map = {
    PENDING_POST: 'Waiting for the post',
    SUBMITTED: 'Submitted, waiting for AI',
    REVISION_REQUESTED: 'Revision needed',
    RESOLVED_COMPLIANT: 'Compliant — paid the influencer',
    RESOLVED_NON_COMPLIANT: 'Non-compliant — refunded the brand',
    DISPUTED: 'Not confident enough — submit evidence again',
    PAYOUT_FAILED: 'Payout failed',
    EXPIRED_REFUNDED: 'Expired — refunded the brand',
  };
  return map[status] || status || '—';
}

export function nextActionHint({ status, isBrand, isInfluencer }) {
  const s = String(status || '');
  if (s === 'PENDING_POST' && isInfluencer) {
    return { title: 'Your turn to submit the post', body: 'Paste a public post link and at least two independent verification sources.' };
  }
  if (s === 'PENDING_POST' && isBrand) {
    return { title: 'Waiting on the influencer', body: 'Share the sponsorship id. The fee stays in escrow until there is a result or the deadline passes.' };
  }
  if (s === 'SUBMITTED') {
    return { title: 'Ready to check', body: 'Click Request an AI check. Validators agree only when they return the same COMPLIANT or NON_COMPLIANT result.' };
  }
  if (s === 'REVISION_REQUESTED' && isInfluencer) {
    return { title: 'You have 1 revision left', body: 'Update the post so it meets the checklist, then submit again. The fee has not moved.' };
  }
  if (s === 'DISPUTED') {
    return { title: 'The evidence is not confident enough', body: 'The influencer can submit the post again, or a clearer archive link. The fee stays in escrow.' };
  }
  if (s === 'PAYOUT_FAILED') {
    return { title: 'Payout did not finish', body: 'The verdict is already stored. Click Try again to send the same fee. AI will not run again.' };
  }
  if (s === 'RESOLVED_COMPLIANT') {
    return { title: 'Paid the influencer', body: 'The post met every checklist item.' };
  }
  if (s === 'RESOLVED_NON_COMPLIANT') {
    return { title: 'Refunded the brand', body: 'The post missed the checklist after the revision, or the deadline had passed.' };
  }
  if (s === 'EXPIRED_REFUNDED') {
    return { title: 'Refunded because the deadline passed', body: 'No post was accepted before the deadline.' };
  }
  return { title: 'Follow this sponsorship', body: 'Connect a studionet wallet to create a deal or submit a post.' };
}
