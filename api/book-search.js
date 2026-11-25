// 레테의 건너편 — 국립중앙도서관 ISBN 서지정보 API 심부름꾼
// 주소: /api/book-search?q=책제목  또는  /api/book-search?q=ISBN
// API 키는 코드에 없고, Vercel 환경 변수 NL_API_KEY 에서 꺼내 씁니다.

const NL_URL = 'https://www.nl.go.kr/seoji/SearchApi.do';

module.exports = async (req, res) => {
  const key = process.env.NL_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Vercel에 NL_API_KEY 환경 변수가 없습니다.' });
  }

  const q = String((req.query && req.query.q) || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: '검색어가 없습니다.' });

  const raw = q.replace(/[-\s]/g, '');
  const isIsbn = /^(\d{9}[\dXx]|\d{13})$/.test(raw);

  const url = new URL(NL_URL);
  url.searchParams.set('cert_key', key);
  url.searchParams.set('result_style', 'json');
  url.searchParams.set('page_no', '1');
  url.searchParams.set('page_size', '10');
  url.searchParams.set(isIsbn ? 'isbn' : 'title', isIsbn ? raw : q);

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(502).json({ error: '국립중앙도서관 서버 응답 오류 (' + r.status + ')' });
    const j = await r.json();
    const docs = Array.isArray(j.docs) ? j.docs : [];

    const items = await Promise.all(docs.map(async d => ({
      title: [d.TITLE, d.VOL].filter(Boolean).join(' ').trim(),
      author: cleanAuthor(d.AUTHOR),
      publisher: (d.PUBLISHER || '').trim(),
      isbn: (d.EA_ISBN || '').trim(),
      total_pages: parsePages(d.PAGE),
      cover: toHttps(d.TITLE_URL),
      description: cleanText(d.BOOK_INTRODUCTION) || cleanText(d.BOOK_SUMMARY) ||
        (await readNlText(d.BOOK_INTRODUCTION_URL)) || (await readNlText(d.BOOK_SUMMARY_URL))
    })));

    // 같은 검색은 하루 동안 Vercel이 기억 → 하루 호출 한도 절약
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(502).json({ error: '국립중앙도서관에 연결하지 못했습니다.' });
  }
};

// "지은이: 한강 ; 옮긴이: 홍길동" → "한강, 홍길동"
function cleanAuthor(s) {
  return String(s || '')
    .split(/[;,]/)
    .map(x => x.replace(/^[^:]*:/, '').replace(/\s*(지음|글|그림|옮김|저|역|편)\s*$/, '').trim())
    .filter(Boolean)
    .join(', ');
}

// "352 p." → "352"
function parsePages(s) {
  const m = String(s || '').match(/(\d{1,5})\s*(p|쪽|면)/i) || String(s || '').match(/^\s*(\d{1,5})\s*$/);
  return m ? m[1] : '';
}

function toHttps(u) {
  u = String(u || '').trim();
  return u ? u.replace(/^http:/, 'https:') : '';
}

function cleanText(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
}

// 2021년 2월 이전 자료는 소개글이 파일 주소로만 와서, 그 파일을 읽어 옵니다 (nl.go.kr 주소만).
async function readNlText(u) {
  try {
    if (!u) return '';
    const url = new URL(toHttps(u));
    if (!/(^|\.)nl\.go\.kr$/.test(url.hostname)) return '';
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { text = new TextDecoder('euc-kr').decode(buf); }
    return cleanText(text);
  } catch (e) {
    return '';
  }
}
