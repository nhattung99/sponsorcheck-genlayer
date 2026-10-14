export const FEE_PRESETS = ['0.5', '1', '2', '5', '10'];

export const DEADLINE_PRESETS = [
  { id: '24h', label: '24 giờ', seconds: 86400n },
  { id: '3d', label: '3 ngày', seconds: 3n * 86400n },
  { id: '7d', label: '7 ngày', seconds: 7n * 86400n },
  { id: '14d', label: '14 ngày', seconds: 14n * 86400n },
];

export const CHECKLIST_PRESETS = [
  { id: 'hashtag', text: 'Public ad hashtag is present (#ad or #sponsored)' },
  { id: 'product', text: 'Post names the product' },
  { id: 'link', text: 'Post includes the signup link or discount code' },
  { id: 'window', text: 'Post was published within the agreed window' },
  { id: 'tag', text: 'Post tags the brand account' },
];

export const EXAMPLE_POST_URL = 'https://example.com';
export const EXAMPLE_REFERENCE_URLS = [
  'https://example.net',
  'https://www.rfc-editor.org/rfc/rfc2606.txt',
];

export const DESCRIPTION_HINT = 'Tên sản phẩm, hashtag, link hoặc mã phải xuất hiện trong bài. Ví dụ: Aurora Bottle, mã AURORA, link đăng ký trong bio.';

export function selectedChecklist(selectedIds, customText) {
  const items = CHECKLIST_PRESETS
    .filter((item) => selectedIds && selectedIds[item.id])
    .map((item) => item.text);
  const custom = String(customText || '').trim();
  if (custom) items.push(custom);
  return items;
}

export function deadlineUnixFromPreset(seconds) {
  const nowSec = BigInt(Date.now()) / 1000n;
  return nowSec + BigInt(seconds);
}
