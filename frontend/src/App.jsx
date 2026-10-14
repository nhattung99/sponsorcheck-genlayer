import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wallet,
  Megaphone,
  ClipboardPaste,
  Scale,
  RefreshCw,
  RotateCcw,
  Copy,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import {
  CONTRACT_ADDRESS,
  hasContractAddress,
  getWriteClient,
  getListClient,
  loadSponsorships,
  readView,
  waitForTx,
  ensureStudioNetwork,
  formatWalletError,
  parseGenToWei,
  formatWeiToGen,
  sanitizeGenInput,
  readWei,
  txExplorerUrl,
  receiptLooksFailed,
  studionet,
} from './genlayerClient.js';
import {
  sameAddress,
  deadlinePassed,
  formatDeadline,
  FLOW_STEPS,
  flowCurrentStep,
  nextActionHint,
  statusLabel,
  pollUntilListed,
  pollUntilStatusChanges,
  newestSponsorshipId,
  independentSourceError,
  resolveReadAccount,
} from './sponsorshipPoll.js';
import {
  FEE_PRESETS,
  DEADLINE_PRESETS,
  CHECKLIST_PRESETS,
  EXAMPLE_POST_URL,
  EXAMPLE_REFERENCE_URLS,
  DESCRIPTION_HINT,
  selectedChecklist,
  deadlineUnixFromPreset,
} from './data/presets.js';

const shortAddr = (a) => {
  if (!a) return '—';
  const s = String(a);
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
};

const pasteClipboard = async () => {
  const text = await navigator.clipboard.readText();
  return (text || '').trim();
};

const feeLabel = (val) => `${formatWeiToGen(readWei(val))} GEN`;

const statusClass = (status) => `badge badge-${String(status || 'none').toLowerCase()}`;

const FlowStrip = ({ status }) => {
  const current = flowCurrentStep(status);
  const indexOf = { create: 0, submit: 1, ai: 2, done: 3 };
  const currentIdx = indexOf[current] ?? 0;
  return (
    <ol className="flow-strip">
      {FLOW_STEPS.map((step, i) => {
        const done = currentIdx > i || (current === 'done' && step.id === 'done');
        const isCurrent = currentIdx === i;
        return (
          <li key={step.id} className={`flow-step${isCurrent ? ' current' : ''}${done ? ' done' : ''}`}>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
};

export default function App() {
  const [account, setAccount] = useState(null);
  const [rows, setRows] = useState([]);
  const [details, setDetails] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [copied, setCopied] = useState('');

  const [influencerAddr, setInfluencerAddr] = useState('');
  const [description, setDescription] = useState('');
  const [checked, setChecked] = useState({
    hashtag: true,
    product: true,
    link: false,
    window: false,
    tag: false,
  });
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const [feeStr, setFeeStr] = useState('1');
  const [deadlineId, setDeadlineId] = useState('7d');
  const [postUrls, setPostUrls] = useState(['']);
  const [refUrls, setRefUrls] = useState(['', '']);

  const feeWei = useMemo(() => parseGenToWei(feeStr), [feeStr]);
  const checklistPreview = useMemo(
    () => selectedChecklist(checked, customOpen ? customText : ''),
    [checked, customOpen, customText]
  );

  const requireReady = () => {
    if (!hasContractAddress) {
      throw new Error('Chưa có địa chỉ contract. Deploy trên studionet, rồi đặt VITE_CONTRACT_ADDRESS.');
    }
    if (!account) {
      throw new Error('Hãy kết nối ví trước.');
    }
  };

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        setErrorMessage('Cần MetaMask để dùng SponsorCheck trên studionet.');
        return;
      }
      setErrorMessage(null);
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const addr = accounts[0];
      try {
        await ensureStudioNetwork();
      } catch (err) {
        console.warn('studionet switch note:', err);
      }
      setAccount(addr);
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Không kết nối được ví'));
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.ethereum?.request) return undefined;
    window.ethereum.request({ method: 'eth_accounts' }).then((accs) => {
      if (Array.isArray(accs) && accs[0]) setAccount(accs[0]);
    }).catch(() => {});
    const onAccounts = (accs) => {
      const next = Array.isArray(accs) && accs[0] ? accs[0] : null;
      setAccount(next);
    };
    window.ethereum.on?.('accountsChanged', onAccounts);
    return () => {
      window.ethereum?.removeListener?.('accountsChanged', onAccounts);
    };
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) setActiveId(id);
  }, []);

  const fetchRows = useCallback(async ({ silent = false } = {}) => {
    if (!hasContractAddress) {
      setRows([]);
      return { rows: [], count: 0 };
    }
    try {
      if (!silent) setLoading(true);
      const client = getListClient(account);
      if (!client) return { rows: [], count: 0 };
      const loaded = await loadSponsorships(client, account);
      setRows(loaded.rows);
      if (!silent && !loaded.rows.length && loaded.listError) {
        setErrorMessage(loaded.listError.message || 'Không đọc được danh sách hợp đồng');
      }
      return loaded;
    } catch (err) {
      console.warn('list_sponsorships failed:', err);
      if (!silent) setErrorMessage(err?.message || 'Không đọc được danh sách hợp đồng');
      return { rows: [], count: 0 };
    } finally {
      if (!silent) setLoading(false);
    }
  }, [account]);

  const fetchDetail = async (sponsorshipId) => {
    if (!hasContractAddress || sponsorshipId == null || String(sponsorshipId).startsWith('0x')) return null;
    try {
      const client = getListClient(account);
      const row = normalizeDetail(await readView(client, 'get_sponsorship', [String(sponsorshipId)], account));
      if (row) {
        setDetails((prev) => ({ ...prev, [String(sponsorshipId)]: row }));
        return row;
      }
      return null;
    } catch (err) {
      console.warn('get_sponsorship failed:', err);
      return null;
    }
  };

  useEffect(() => {
    fetchRows();
    if (!hasContractAddress) return undefined;
    const timer = setInterval(() => {
      fetchRows({ silent: true });
    }, 15000);
    return () => clearInterval(timer);
  }, [fetchRows]);

  const runWrite = async (fnName, args, value, { resolving, fromStatus } = {}) => {
    requireReady();
    setErrorMessage(null);
    setTxHash(null);
    if (resolving) setResolvingId(resolving);
    setLoading(true);
    const isAi = fnName === 'resolve_sponsorship';
    try {
      await ensureStudioNetwork();
      const client = getWriteClient(account);
      const sender = resolveReadAccount(account);
      const hash = await client.writeContract({
        address: CONTRACT_ADDRESS,
        functionName: fnName,
        args,
        account: sender,
        value: value === undefined ? 0n : value,
      });
      setTxHash(hash);
      const receipt = await waitForTx(client, hash, isAi
        ? { retries: 90, interval: 5000 }
        : { retries: 40, interval: 2000 });

      if (isAi) {
        const settled = await pollUntilStatusChanges({
          fromStatus: fromStatus || 'SUBMITTED',
          attempts: 36,
          intervalMs: 5000,
          loadRow: async () => {
            await fetchRows({ silent: true });
            return fetchDetail(String(args[0]));
          },
        });
        const status = String(settled?.status || '');
        if (!status || status === (fromStatus || 'SUBMITTED')) {
          const explorer = txExplorerUrl(hash);
          const stuck = `Chưa thấy phán quyết mới. Bấm làm mới sau vài phút. Dùng bài công khai hoặc link archive, không dùng Instagram/TikTok. Explorer: ${explorer}`;
          if (receiptLooksFailed(receipt)) {
            throw new Error(`GenVM đã hoàn tác lần kiểm tra này. ${stuck}`);
          }
          setErrorMessage(stuck);
        }
        return hash;
      }

      const previousCount = rows.length;
      if (fnName === 'create_sponsorship') {
        const listed = await pollUntilListed({
          previousCount,
          attempts: 20,
          intervalMs: 2000,
          load: () => fetchRows({ silent: true }),
        });
        const created = newestSponsorshipId(listed.rows);
        if (created) {
          setActiveId(created);
          await fetchDetail(created);
        }
      } else {
        await fetchRows({ silent: true });
        if (args[0] != null) await fetchDetail(String(args[0]));
      }
      return hash;
    } catch (err) {
      setErrorMessage(formatWalletError(err, 'Giao dịch thất bại'));
      return null;
    } finally {
      setLoading(false);
      setResolvingId(null);
    }
  };

  const onCreate = async (event) => {
    event.preventDefault();
    try {
      const checklist = selectedChecklist(checked, customOpen ? customText : '');
      if (!description.trim()) throw new Error('Hãy mô tả chiến dịch.');
      if (checklist.length < 1) throw new Error('Chọn ít nhất 1 mục checklist.');
      if (!/^0x[0-9a-fA-F]{40}$/.test(influencerAddr.trim())) {
        throw new Error('Địa chỉ influencer phải là 0x và 40 ký tự hex.');
      }
      if (sameAddress(influencerAddr.trim(), account)) {
        throw new Error('Brand và influencer không được trùng ví.');
      }
      if (feeWei <= 0n) throw new Error('Phí tài trợ phải lớn hơn 0.');
      const preset = DEADLINE_PRESETS.find((item) => item.id === deadlineId) || DEADLINE_PRESETS[2];
      const deadline = deadlineUnixFromPreset(preset.seconds);
      await runWrite(
        'create_sponsorship',
        [influencerAddr.trim(), description.trim(), checklist, deadline],
        feeWei
      );
    } catch (err) {
      setErrorMessage(err?.message || 'Không tạo được hợp đồng');
    }
  };

  const onSubmitPost = async (event) => {
    event.preventDefault();
    try {
      const posts = postUrls.map((u) => u.trim()).filter(Boolean);
      const refs = refUrls.map((u) => u.trim()).filter(Boolean);
      const problem = independentSourceError(posts, refs);
      if (problem) throw new Error(problem);
      await runWrite('submit_post', [String(activeId), posts, refs]);
    } catch (err) {
      setErrorMessage(err?.message || 'Không nộp được bài');
    }
  };

  const copyText = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1600);
    } catch (err) {
      setErrorMessage('Không đọc được clipboard. Hãy dán thủ công.');
    }
  };

  const visible = rows.filter((row) => {
    if (filter === 'brand') return sameAddress(row.brand, account);
    if (filter === 'influencer') return sameAddress(row.influencer, account);
    return true;
  });

  const active = activeId
    ? (details[activeId] || rows.find((row) => String(row.sponsorship_id) === String(activeId)) || null)
    : null;

  const isBrand = active ? sameAddress(account, active.brand) : false;
  const isInfluencer = active ? sameAddress(account, active.influencer) : false;
  const canSubmit = active && isInfluencer && ['PENDING_POST', 'REVISION_REQUESTED', 'DISPUTED'].includes(active.status);
  const canResolve = active && active.status === 'SUBMITTED';
  const canRetry = active && active.status === 'PAYOUT_FAILED' && (isBrand || isInfluencer);
  const canRefund = active && isBrand && !active.settled
    && ['PENDING_POST', 'REVISION_REQUESTED', 'DISPUTED'].includes(active.status)
    && deadlinePassed(active.post_deadline);
  const hint = active ? nextActionHint({ status: active.status, isBrand, isInfluencer }) : null;
  const networkName = studionet?.name || 'studionet';

  return (
    <div className="app">
      <div className="free-banner">
        Miễn phí sử dụng — chỉ tốn phí gas mạng GenLayer khi ký giao dịch. Không có phí nền tảng nào khác.
      </div>

      <header className="header">
        <div className="brand">
          <div className="brand-mark"><Megaphone size={20} /></div>
          <div>
            <h1>SponsorCheck</h1>
            <p>Escrow tài trợ · studionet</p>
          </div>
        </div>
        <div className="header-right">
          <div className="network"><span className="dot" /> {networkName}</div>
          <button className="btn-secondary" onClick={connectWallet} type="button">
            <Wallet size={16} />
            {account ? shortAddr(account) : 'Kết nối ví'}
          </button>
        </div>
      </header>

      {!hasContractAddress && (
        <div className="missing-banner" role="status">
          Chưa có địa chỉ contract. App vẫn mở được — chưa gửi giao dịch. Sau khi deploy tay trên studionet và thấy Result: SUCCESS, đặt <span className="mono">VITE_CONTRACT_ADDRESS</span> rồi build lại.
        </div>
      )}

      {hasContractAddress && (
        <p className="contract-line mono">
          Contract {shortAddr(CONTRACT_ADDRESS)}
        </p>
      )}

      <p className="pitch">
        Brand khóa phí GEN. Influencer nộp bài kèm nguồn xác minh. AI chỉ trả COMPLIANT hoặc NON_COMPLIANT — đủ checklist thì trả influencer, thiếu thì được sửa 1 lần, sau đó hoặc quá hạn thì hoàn brand.
      </p>

      {errorMessage && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={16} />
          <span>{errorMessage}</span>
          <button type="button" className="btn-ghost" onClick={() => setErrorMessage(null)}>Đóng</button>
        </div>
      )}
      {txHash && (
        <a className="tx-link" href={txExplorerUrl(txHash)} target="_blank" rel="noreferrer">
          Xem giao dịch trên explorer
        </a>
      )}

      <div className="layout">
        <form className="card" onSubmit={onCreate}>
          <h2>Tạo hợp đồng</h2>
          <p className="hint">Brand ký và gửi GEN vào escrow. Chỉ chọn checklist, mức phí và hạn — mô tả là ô chữ duy nhất.</p>

          <label className="label">Địa chỉ influencer</label>
          <div className="url-row">
            <input
              className="input mono"
              placeholder="0x..."
              value={influencerAddr}
              onChange={(e) => setInfluencerAddr(e.target.value.trim())}
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                try { setInfluencerAddr(await pasteClipboard()); }
                catch { setErrorMessage('Không đọc được clipboard.'); }
              }}
            >
              <ClipboardPaste size={14} /> Dán
            </button>
          </div>

          <label className="label">Mô tả chiến dịch</label>
          <textarea
            className="textarea"
            rows={4}
            maxLength={800}
            placeholder={DESCRIPTION_HINT}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="hint">{DESCRIPTION_HINT}</p>

          <label className="label">Checklist yêu cầu</label>
          <div className="checks">
            {CHECKLIST_PRESETS.map((item) => (
              <label key={item.id} className="check">
                <input
                  type="checkbox"
                  checked={Boolean(checked[item.id])}
                  onChange={() => setChecked((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                />
                <span>{item.text}</span>
              </label>
            ))}
          </div>
          <button type="button" className="btn-ghost" onClick={() => setCustomOpen((v) => !v)}>
            {customOpen ? 'Ẩn yêu cầu khác' : 'Thêm yêu cầu khác'}
          </button>
          {customOpen && (
            <input
              className="input"
              maxLength={180}
              placeholder="Yêu cầu ngắn, không bắt buộc"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
            />
          )}
          <p className="hint">{checklistPreview.length} mục sẽ ghi vào hợp đồng.</p>

          <label className="label">Phí tài trợ</label>
          <div className="chips">
            {FEE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`chip${feeStr === preset ? ' active' : ''}`}
                onClick={() => setFeeStr(preset)}
              >
                {preset} GEN
              </button>
            ))}
          </div>
          <input
            className="input mono"
            inputMode="decimal"
            value={feeStr}
            onChange={(e) => setFeeStr(sanitizeGenInput(e.target.value))}
          />
          <p className="hint">Sẽ khóa {feeLabel(feeWei)} vào contract.</p>

          <label className="label">Hạn đăng bài</label>
          <select className="select" value={deadlineId} onChange={(e) => setDeadlineId(e.target.value)}>
            {DEADLINE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>

          <button className="btn-primary" type="submit" disabled={loading}>
            Tạo và khóa phí
          </button>
        </form>

        <section className="card">
          <div className="split">
            <h2>Hợp đồng</h2>
            <button type="button" className="btn-ghost" onClick={() => fetchRows()} disabled={loading || !hasContractAddress}>
              <RefreshCw size={14} /> Làm mới
            </button>
          </div>
          <div className="filter-row">
            {[
              ['all', 'Tất cả'],
              ['brand', 'Tôi là brand'],
              ['influencer', 'Tôi là influencer'],
            ].map(([id, label]) => (
              <button key={id} type="button" className={`chip${filter === id ? ' active' : ''}`} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          {!hasContractAddress && <p className="empty">Danh sách hiện khi đã có địa chỉ contract trên studionet.</p>}
          {hasContractAddress && visible.length === 0 && <p className="empty">Chưa có hợp đồng nào trong bộ lọc này.</p>}
          <div className="list">
            {visible.map((row) => (
              <button
                key={row.sponsorship_id}
                type="button"
                className={`sponsorship${String(activeId) === String(row.sponsorship_id) ? ' selected' : ''}`}
                onClick={() => {
                  setActiveId(String(row.sponsorship_id));
                  fetchDetail(row.sponsorship_id);
                }}
              >
                <div className="split">
                  <strong>#{row.sponsorship_id}</strong>
                  <span className={statusClass(row.status)}>{statusLabel(row.status)}</span>
                </div>
                <p>{row.campaign_description}</p>
                <p className="hint">{feeLabel(row.fee_amount)} · hạn {formatDeadline(row.post_deadline)}</p>
              </button>
            ))}
          </div>
        </section>
      </div>

      {active && (
        <section className="card detail">
          <FlowStrip status={active.status} />
          <div className="split">
            <h2>Hợp đồng #{active.sponsorship_id}</h2>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => copyText(`${window.location.origin}${window.location.pathname}?id=${active.sponsorship_id}`, 'share')}
            >
              <Copy size={14} /> {copied === 'share' ? 'Đã chép' : 'Chia sẻ'}
            </button>
          </div>
          <p>{active.campaign_description}</p>
          <div className="meta">
            <span>Brand {shortAddr(active.brand)}</span>
            <span>Influencer {shortAddr(active.influencer)}</span>
            <span>{feeLabel(active.fee_amount)}</span>
            <span><Clock size={12} /> {formatDeadline(active.post_deadline)}</span>
            <span>Sửa đã dùng: {String(active.revisions_used ?? 0)}/1</span>
          </div>
          {Array.isArray(active.requirements_checklist) && (
            <ul className="checklist-read">
              {active.requirements_checklist.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
          {hint && (
            <div className="hint-box">
              <strong>{hint.title}</strong>
              <p>{hint.body}</p>
            </div>
          )}
          {active.verdict && (
            <div className={`verdict ${String(active.verdict).toUpperCase() === 'COMPLIANT' ? 'verdict-compliant' : 'verdict-non'}`}>
              <div className="split">
                <strong>{active.verdict}</strong>
                <span>Độ chắc {String(active.confidence ?? 0)}/100</span>
              </div>
              <p className="reason">{active.verdict_reason}</p>
            </div>
          )}
          {!active.verdict && active.verdict_reason && (
            <p className="reason">{active.verdict_reason}</p>
          )}

          {canResolve && (
            <button
              type="button"
              className="btn-ai"
              disabled={loading}
              onClick={() => runWrite('resolve_sponsorship', [String(active.sponsorship_id)], 0n, { resolving: active.sponsorship_id })}
            >
              <Scale size={16} />
              {resolvingId === String(active.sponsorship_id) ? 'Đang đọc bài đăng và đối chiếu checklist…' : 'Yêu cầu AI kiểm tra'}
            </button>
          )}

          {canRetry && (
            <button
              type="button"
              className="btn-primary"
              disabled={loading}
              onClick={() => runWrite('retry_resolution', [String(active.sponsorship_id)])}
            >
              <RotateCcw size={16} /> Thử lại
            </button>
          )}

          {canRefund && (
            <button
              type="button"
              className="btn-danger"
              disabled={loading}
              onClick={() => runWrite('claim_expired_refund', [String(active.sponsorship_id)])}
            >
              Lấy lại phí (hết hạn)
            </button>
          )}

          {canSubmit && deadlinePassed(active.post_deadline) && (
            <p className="revision-note">Đã quá hạn nộp bài. Brand có thể lấy lại phí.</p>
          )}

          {canSubmit && !deadlinePassed(active.post_deadline) && (
            <form onSubmit={onSubmitPost}>
              <div className="social-banner">
                Dùng bài đăng công khai (X, YouTube, blog) hoặc link bản lưu trữ archive. Instagram/TikTok thường chặn truy cập tự động nên AI có thể không đọc được.
              </div>
              {active.status === 'REVISION_REQUESTED' && (
                <p className="revision-note">Bạn còn 1 lần sửa bài. Phí vẫn nằm nguyên trong escrow.</p>
              )}
              <label className="label">Link bài đăng</label>
              {postUrls.map((url, index) => (
                <div className="url-row" key={`post-${index}`}>
                  <input
                    className="input mono"
                    placeholder="https://"
                    value={url}
                    onChange={(e) => {
                      const next = [...postUrls];
                      next[index] = e.target.value;
                      setPostUrls(next);
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={async () => {
                      try {
                        const next = [...postUrls];
                        next[index] = await pasteClipboard();
                        setPostUrls(next);
                      } catch {
                        setErrorMessage('Không đọc được clipboard.');
                      }
                    }}
                  >
                    <ClipboardPaste size={14} /> Dán
                  </button>
                </div>
              ))}
              <label className="label">Nguồn xác minh độc lập (tối thiểu 2)</label>
              {refUrls.map((url, index) => (
                <div className="url-row" key={`ref-${index}`}>
                  <input
                    className="input mono"
                    placeholder="https:// archive hoặc chính sách nền tảng"
                    value={url}
                    onChange={(e) => {
                      const next = [...refUrls];
                      next[index] = e.target.value;
                      setRefUrls(next);
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={async () => {
                      try {
                        const next = [...refUrls];
                        next[index] = await pasteClipboard();
                        setRefUrls(next);
                      } catch {
                        setErrorMessage('Không đọc được clipboard.');
                      }
                    }}
                  >
                    <ClipboardPaste size={14} /> Dán
                  </button>
                </div>
              ))}
              <div className="row-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setPostUrls([EXAMPLE_POST_URL]);
                    setRefUrls([...EXAMPLE_REFERENCE_URLS]);
                  }}
                >
                  Điền link mẫu công khai
                </button>
                <button className="btn-primary" type="submit" disabled={loading}>Nộp bài</button>
              </div>
            </form>
          )}
        </section>
      )}
    </div>
  );
}

function normalizeDetail(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!raw.sponsorship_id && raw.sponsorship_id !== 0) return raw.sponsorship_id === '' ? null : raw;
  return { ...raw, sponsorship_id: String(raw.sponsorship_id) };
}
