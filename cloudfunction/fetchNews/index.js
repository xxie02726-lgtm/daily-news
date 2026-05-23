// 云函数：fetchNews（用 @cloudbase/node-sdk，需要在 package.json 声明依赖）

const cloud = require('@cloudbase/node-sdk');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;

const FEEDS = [
  { url: 'https://www.ithome.com/rss/',                      source: 'IT之家',          cat: '科技' },
  { url: 'https://sspai.com/feed',                            source: '少数派',          cat: '科技' },
  { url: 'https://rsshub.app/36kr/newsflashes',               source: '36氪快讯',        cat: '科技' },
  { url: 'https://www.ruanyifeng.com/blog/atom.xml',          source: '阮一峰的网络日志', cat: '编程' },
  { url: 'https://www.v2ex.com/index.xml',                    source: 'V2EX',            cat: '编程' },
  { url: 'https://hellogithub.com/rss',                       source: 'HelloGitHub',     cat: '编程' },
];

function fetchUrl(urlStr, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    const u = new URL(urlStr);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, urlStr).toString();
        return fetchUrl(next, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function pickTag(xml, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? decodeHtml(m[1]).trim() : '';
}
function pickAttr(xml, tag, attr) {
  const re = new RegExp('<' + tag + '\\b[^>]*\\b' + attr + '=["\']([^"\'>]+)["\']', 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}
function parseFeed(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const c = m[1];
    items.push({
      title:   pickTag(c, 'title'),
      link:    pickTag(c, 'link'),
      pubDate: pickTag(c, 'pubDate') || pickTag(c, 'dc:date'),
      summary: pickTag(c, 'description'),
      content: pickTag(c, 'content:encoded') || pickTag(c, 'description'),
    });
  }
  if (items.length === 0) {
    const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((m = entryRe.exec(xml)) !== null) {
      const c = m[1];
      items.push({
        title:   pickTag(c, 'title'),
        link:    pickAttr(c, 'link', 'href') || pickTag(c, 'id'),
        pubDate: pickTag(c, 'updated') || pickTag(c, 'published'),
        summary: pickTag(c, 'summary') || pickTag(c, 'content'),
        content: pickTag(c, 'content') || pickTag(c, 'summary'),
      });
    }
  }
  return items;
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}
function makeSummary(text, maxLen = 120) {
  if (!text) return '';
  const plain = String(text).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > maxLen ? plain.slice(0, maxLen) + '…' : plain;
}
function extractCover(html) {
  const m = String(html || '').match(/<img[^>]+src=["']([^"'>]+)["']/i);
  return m ? m[1] : '';
}

exports.main = async (event, context) => {
  const results = [];

  for (const feed of FEEDS) {
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseFeed(xml);
      let added = 0, skipped = 0;

      for (const item of items.slice(0, 10)) {
        const link = (item.link || '').trim();
        const title = (item.title || '').trim();
        if (!title || !link) continue;

        const itemHash = hash(title + '|' + link);
        const exist = await db.collection('news').where({ hash: itemHash }).count();
        if (exist.total > 0) { skipped++; continue; }

        await db.collection('news').add({
          data: {
            cat: feed.cat, source: feed.source,
            title, link,
            summary: makeSummary(item.summary),
            content: item.content || item.summary || '',
            cover: extractCover(item.content),
            pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
            fetchedAt: new Date().toISOString(),
            isAI: false,
            hash: itemHash,
          }
        });
        added++;
      }
      results.push({ source: feed.source, added, skipped, total: items.length });
    } catch (e) {
      results.push({ source: feed.source, error: String(e.message || e) });
    }
  }

  let cleaned = 0;
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const old = await db.collection('news').where({ pubDate: _.lt(cutoff) }).limit(100).get();
    for (const doc of old.data) {
      await db.collection('news').doc(doc._id).remove();
      cleaned++;
    }
  } catch (e) {}

  return { ok: true, results, cleaned, time: new Date().toISOString() };
};
