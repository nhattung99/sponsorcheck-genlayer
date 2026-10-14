import {
  studioRpcUrl,
  STUDIO_RPC,
  formatWalletError,
  sameAddress,
  resolveReadAccount,
  VIEW_FROM,
  unwrapViewResult,
  normalizeSponsorshipList,
  normalizeSponsorshipRow,
  parseCount,
  shouldKeepPolling,
  newestSponsorshipId,
  pollUntilStatusChanges,
  deadlinePassed,
  independentSourceError,
  urlHost,
  flowCurrentStep,
  FLOW_STEPS,
  nextActionHint,
  statusLabel,
} from '../sponsorshipPoll.js';
import {
  DEADLINE_PRESETS,
  selectedChecklist,
  deadlineUnixFromPreset,
  EXAMPLE_POST_URL,
  EXAMPLE_REFERENCE_URLS,
} from '../data/presets.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${msg}: expected ${right}, got ${left}`);
}

const row = {
  sponsorship_id: '0',
  status: 'PENDING_POST',
  fee_amount: '1000',
  brand: '0x0000000000000000000000000000000000000002',
  influencer: '0x0000000000000000000000000000000000000003',
};

async function run() {
  console.log('Starting sponsorship poll tests...');

  assertEqual(studioRpcUrl(undefined), STUDIO_RPC, 'node uses Studio RPC');
  assertEqual(studioRpcUrl('https://sponsorcheck.vercel.app'), 'https://sponsorcheck.vercel.app/api/genlayer', 'browser proxy');
  assert(formatWalletError({ message: 'User rejected the request' }).includes('Confirm'), 'rejected wallet is explained');
  assert(sameAddress('0xAbC', '0xabc') === true, 'address compare ignores case');
  assertEqual(resolveReadAccount(undefined).address, VIEW_FROM, 'missing account uses view from');
  assertEqual(unwrapViewResult(JSON.stringify([row]))[0].status, 'PENDING_POST', 'json list');
  assertEqual(normalizeSponsorshipList([row]).length, 1, 'native list');
  assertEqual(normalizeSponsorshipRow({ id: 4, status: 'SUBMITTED' }).sponsorship_id, '4', 'fallback id');
  assertEqual(parseCount('2'), 2, 'count string');
  assert(shouldKeepPolling({ previousCount: 0, currentCount: 0, rows: [] }) === true, 'keep polling empty');
  assert(shouldKeepPolling({ previousCount: 0, currentCount: 1, rows: [row] }) === false, 'stop when listed');
  assertEqual(newestSponsorshipId([{ sponsorship_id: '2' }, { sponsorship_id: '10' }]), '10', 'newest id');

  let n = 0;
  const settled = await pollUntilStatusChanges({
    fromStatus: 'SUBMITTED',
    attempts: 4,
    intervalMs: 1,
    sleep: async () => {},
    loadRow: async () => {
      n += 1;
      return n < 3 ? { status: 'SUBMITTED' } : { status: 'REVISION_REQUESTED', verdict: 'NON_COMPLIANT' };
    },
  });
  assert(settled.status === 'REVISION_REQUESTED', 'poll leaves SUBMITTED');
  assert(n === 3, 'poll retries');

  assert(deadlinePassed('1', 2_000_000) === true, 'past deadline');
  assert(deadlinePassed('5000', 2_000_000) === false, 'future deadline');
  assert(urlHost('https://www.Example.com/a') === 'example.com', 'host strips www');
  assert(independentSourceError(['https://example.com/p'], ['https://example.net/a', 'https://help.x.com/rules']) === '', 'independent refs ok');
  assert(independentSourceError(['https://example.com/p'], ['https://example.com/other', 'https://example.net/a']) !== '', 'ref host cannot match post');
  assert(independentSourceError(['https://example.com/p'], ['https://a.test/1']) !== '', 'need two refs');

  const week = DEADLINE_PRESETS.find((item) => item.id === '7d');
  const twoWeeks = DEADLINE_PRESETS.find((item) => item.id === '14d');
  assert(twoWeeks.seconds - week.seconds === 7n * 86400n, 'deadline presets differ by exact days');
  const soon = deadlineUnixFromPreset(86400n);
  assert(soon > BigInt(Date.now()) / 1000n, 'preset deadline is in the future');

  const items = selectedChecklist({ hashtag: true, product: false }, 'Tag @brand');
  assertEqual(items[0], 'Public ad hashtag is present (#ad or #sponsored)', 'checked preset kept');
  assert(items[items.length - 1] === 'Tag @brand', 'custom requirement appended');
  assert(selectedChecklist({}, '   ').length === 0, 'blank custom is ignored');

  assertEqual(flowCurrentStep('SUBMITTED'), 'ai', 'submitted waits on AI');
  assertEqual(flowCurrentStep('REVISION_REQUESTED'), 'submit', 'revision goes back to submit');
  assertEqual(flowCurrentStep('RESOLVED_COMPLIANT'), 'done', 'compliant is done');
  assert(FLOW_STEPS.length === 4, 'four steps');
  const revision = nextActionHint({ status: 'REVISION_REQUESTED', isBrand: false, isInfluencer: true });
  assert(revision.title.toLowerCase().includes('1 revision'), 'revision copy names the one fix');
  assert(statusLabel('PAYOUT_FAILED').toLowerCase().includes('failed'), 'payout failed is labeled');

  const sample = [EXAMPLE_POST_URL, ...EXAMPLE_REFERENCE_URLS].join(' ').toLowerCase();
  assert(!sample.includes('instagram') && !sample.includes('tiktok'), 'sample links are public pages');
  assert(independentSourceError([EXAMPLE_POST_URL], EXAMPLE_REFERENCE_URLS) === '', 'sample links are independent');

  console.log('All sponsorship poll tests passed.');
}

run();
