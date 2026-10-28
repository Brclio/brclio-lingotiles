import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Cloud, Download, LogOut, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-react';
import type { AccountSnapshot, AccountClient } from '../account/client';

type Props = { account: AccountSnapshot & { client: AccountClient }; onClose: () => void };
export default function AccountDialog({ account, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  const action = async (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await task(); } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(() => account.client.authenticate(mode, { email: String(data.get('email')).trim(), password: String(data.get('password')), ...(mode === 'register' ? { name: String(data.get('name')).trim() } : {}) }));
  };
  return <dialog ref={ref} className="account-dialog" aria-labelledby="account-title" onCancel={onClose} onClick={event => { if (event.currentTarget === event.target && !busy) onClose(); }}>
    <div className="dialog-content">
      <div className="dialog-top"><div className="account-eyebrow"><UserRound size={15} />你的学习账号</div><button className="icon-button" aria-label="关闭账号窗口" onClick={onClose}><X size={19} /></button></div>
      <h2 id="account-title">{account.user ? `你好，${account.user.name || '学习者'}` : mode === 'login' ? '把一点点进步，带在身边。' : '从今天起，积累自己的词汇。'}</h2>
      {account.user ? <>
        <p className="account-email">{account.user.email}</p>
        <div className="account-stats"><div><strong>{account.progress.saved.length}</strong><span>收藏单词</span></div><div><strong>{account.cards.length}</strong><span>收集词卡</span></div><div><strong>{account.progress.sessions}</strong><span>通关练习</span></div></div>
        <div className="account-sync-detail"><Cloud size={19} /><div><strong>{account.status === 'synced' ? '学习数据已同步' : account.status === 'syncing' ? '正在同步学习数据…' : '本机有待同步的学习数据'}</strong><p>收藏、词卡、每次通关和动画偏好跟随账号保存。</p></div></div>
        {account.error && <p className="account-error" role="alert">{account.error}</p>}
        <button className="secondary-button full-width" disabled={busy || account.status === 'syncing'} onClick={() => void action(account.client.sync)}><RefreshCw size={16} />{account.status === 'syncing' ? '同步中…' : '立即同步'}</button>
        <div className="account-import"><h3>这台设备以前的游客记录</h3><p>如果游客记录属于你，可以把它们合并进当前账号。也可以继续保留游客记录，不导入。</p><button className="text-button" disabled={busy || account.importedGuest} onClick={() => void action(account.client.importGuest)}><Download size={15} />{account.importedGuest ? '已加入同步队列' : '导入这台设备的游客记录'}</button></div>
        <button className="text-button account-logout" disabled={busy} onClick={() => void action(async () => { await account.client.logout(); onClose(); })}><LogOut size={16} />退出登录</button>
      </> : <>
        <p className="account-description">登录后，收藏、学习足迹和收集词卡可在不同设备间同步。</p>
        <div className="account-tabs" aria-label="账号操作"><button type="button" aria-pressed={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>登录</button><button type="button" aria-pressed={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>创建账号</button></div>
        <form className="account-form" onSubmit={submit} key={mode}>
          {mode === 'register' && <label>怎么称呼你<input name="name" autoComplete="nickname" required maxLength={60} placeholder="你的名字" /></label>}
          <label>邮箱<input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" /></label>
          <label>密码<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : undefined} maxLength={128} placeholder={mode === 'register' ? '至少 10 位，建议使用长密码' : '输入你的密码'} /></label>
          {error && <p className="account-error" role="alert">{error}</p>}
          <button className="primary-button full-width" disabled={busy || !account.ready} type="submit">{busy ? '正在处理…' : mode === 'login' ? '登录，继续积累' : '创建我的账号'}<ArrowRight size={16} /></button>
        </form>
        <div className="account-divider"><span>或者</span></div>
        <a className={`google-login ${!account.googleEnabled ? 'disabled' : ''}`} href={account.googleEnabled ? '/api/auth/google' : undefined} aria-disabled={!account.googleEnabled}><span className="google-mark" aria-hidden="true">G</span>使用 Google 账号继续</a>
        {!account.googleEnabled && <p className="account-google-note">Google 登录暂未配置，可先使用邮箱注册或登录。</p>}
        <p className="account-privacy"><ShieldCheck size={15} />游客记录由你选择是否导入；账号数据分别保存。</p>
      </>}
      {account.user && error && <p className="account-error" role="alert">{error}</p>}
    </div>
  </dialog>;
}
