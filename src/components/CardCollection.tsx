import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Layers3, Search, Volume2 } from 'lucide-react';
import { cardWord, type CollectedCard } from '../account/data';
import { loadWordIllustrations } from '../game/wordIllustrations';
import WordIllustration from './WordIllustration';

type Props = { cards: CollectedCard[]; saved: string[]; onSave: (id: string) => void; speak: (word: string) => void; onBack: () => void };
const SIZE = 18;
export default function CardCollection({ cards, saved, onSave, speak, onBack }: Props) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [, refresh] = useState(0);
  const filtered = useMemo(() => [...cards].filter(card => `${card.word} ${card.meaning}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => (b.lastCollectedAt ?? b.collectedAt).localeCompare(a.lastCollectedAt ?? a.collectedAt)), [cards, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / SIZE));
  const current = Math.min(page, pages - 1);
  const displayed = useMemo(() => filtered.slice(current * SIZE, (current + 1) * SIZE), [filtered, current]);
  useEffect(() => { let stopped = false; void loadWordIllustrations(displayed.map(cardWord)).then(() => { if (!stopped) refresh(value => value + 1); }).catch(() => {}); return () => { stopped = true; }; }, [displayed]);
  return <section className="collection" aria-labelledby="collection-title">
    <div className="page-heading"><div><p className="history-eyebrow">MY WORD COLLECTION</p><h1 id="collection-title">配对过的单词，收成自己的词卡。</h1><p>每完成一组配对就收入词卡册，未通关也会保留。</p></div><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} />返回闯关</button></div>
    <div className="collection-toolbar"><p><Layers3 size={18} /><strong>{cards.length}</strong> 张不同词卡<span>· 可以随时回看、朗读与收藏</span></p><label className="search-box"><Search size={16} /><span className="sr-only">搜索已收集词卡</span><input type="search" value={query} placeholder="搜索单词或含义" onChange={event => { setQuery(event.target.value); setPage(0); }} /></label></div>
    {displayed.length ? <div className="collection-grid">{displayed.map(card => <article className="collection-card" key={card.wordId}><WordIllustration word={cardWord(card)} className="collection-image" loading="lazy" /><div className="collection-card-heading"><h2 lang="en">{card.word}</h2><button className="pronounce" aria-label={`朗读 ${card.word}`} onClick={() => speak(card.word)}><Volume2 size={17} /></button><button className={`save-button ${saved.includes(card.wordId) ? 'saved' : ''}`} aria-label={`${saved.includes(card.wordId) ? '取消收藏' : '收藏'} ${card.word}`} aria-pressed={saved.includes(card.wordId)} onClick={() => onSave(card.wordId)}><Bookmark size={18} fill={saved.includes(card.wordId) ? 'currentColor' : 'none'} /></button></div>{card.phonetic && <p className="notebook-phonetic" lang="en">{card.phonetic}</p>}<p className="collection-meaning"><span className="pos-chip">{card.pos}</span>{card.meaning}</p>{card.example && <p className="collection-example" lang="en">{card.example}</p>}<p className="collection-card-date">{card.count ?? 1} 次收获 · 首次 {new Date(card.collectedAt).toLocaleDateString('zh-CN')}</p></article>)}</div> : <div className="empty-state"><Layers3 size={36} strokeWidth={1.3} /><h2>{query ? '没有找到这张词卡' : '你的第一张词卡，等你来收集'}</h2><p>{query ? '试试更短的关键词。' : '开始一局挑战，完成单词、词性与含义的配对。'}</p><button className="secondary-button" onClick={onBack}>去收集词卡<ArrowRight size={16} /></button></div>}
    {filtered.length > SIZE && <div className="dictionary-pagination"><button className="secondary-button" disabled={!current} onClick={() => setPage(current - 1)}><ArrowLeft size={15} />上一页</button><span>第 {current + 1} / {pages} 页 · {filtered.length} 张词卡</span><button className="secondary-button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页<ArrowRight size={15} /></button></div>}
  </section>;
}
