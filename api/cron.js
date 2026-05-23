// Vercel Serverless Function: /api/cron
// 由 vercel.json 配置的 Cron 定时调用（每 2 小时一次）
// 从所有热榜 + RSS 源抓新闻，写入 Supabase

const { createClient } = require('@supabase/supabase-js');

// ===== 配置（环境变量在 Vercel Dashboard 配） =====
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://jtjuvefisqrwuilrmyva.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const HOT_API_BASE  = process.env.HOT_API_BASE  || 'https://news-hot-api.vercel.app';
const CRON_SECRET   = process.env.CRON_SECRET   || '';

// ===== 数据源（跟前端 index.html 一致）=====
const HOTLISTS = [
  // 国内科技
  { api: HOT_API_BASE + '/ithome',       source: 'IT之家',     cat: '科技', color: 'itHome'  },
  { api: HOT_API_BASE + '/ifanr',        source: '爱范儿',     cat: '科技', color: 'ifanr'   },
  { api: HOT_API_BASE + '/sspai',        source: '少数派',     cat: '科技', color: 'sspai'   },
  // 商业 / 财经
  { api: HOT_API_BASE + '/36kr',         source: '36氪',       cat: '财经', color: 'kr36'    },
  { api: HOT_API_BASE + '/huxiu',        source: '虎嗅',       cat: '财经', color: 'huxiu'   },
  { api: HOT_API_BASE + '/juejin',       source: '掘金',       cat: '财经', color: 'juejin'  },
  // 时政
  { api: HOT_API_BASE + '/thepaper',     source: '澎湃新闻',   cat: '时事', color: 'paper'   },
  { api: HOT_API_BASE + '/qq-news',      source: '腾讯新闻',   cat: '时事', color: 'tencent' },
  { api: HOT_API_BASE + '/sina-news',    source: '新浪新闻',   cat: '时事', color: 'sina'    },
];

const FEEDS = [
  // 国际时政
  { url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml',  source: 'BBC 中文',     cat: '时事' },
  { url: 'https://rss.dw.com/rdf/rss-chi-all',              source: 'DW 德国之声',  cat: '时事' },
  // 国外科技
  { url: 'https://news.ycombinator.com/rss',                source: 'HackerNews',   cat: '科技' },
  { url: 'https://techcrunch.com/feed/',                    source: 'TechCrunch',   cat: '科技' },
  { url: 'https://www.theverge.com/rss/index.xml',          source: 'The Verge',    cat: '科技' },
  // 美股
  { url: 'https://finance.yahoo.com/news/rssindex',         source: 'Yahoo Finance', cat: '财经' },
];

// ===== 工具函数 =====
function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}
function parseHot(h) {
  if (h == null) return 0;
  if (typeof h === 'number') return h;
  const s = String(h).replace(/[,\s]/g, '');
  const num = parseFloat(s) || 0;
  if (s.includes('亿')) return num * 100000000;
  if (s.includes('万') || s.includes('w') || s.includes('W')) return num * 10000;
  if (s.includes('k') || s.includes('K')) return num * 1000;
  return num;
}
function stripHtmlText(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function pickFirstImg(html) {
  const m = String(html || '').match(/<img[^>]+src=["']([^"'>]+)["']/i);
  return m ? m[1] : '';
}
function getBestCover(item) {
  if (item.thumbnail && /^https?:/.test(item.thumbnail)) return item.thumbnail;
  if (item.enclosure) {
    const enc = item.enclosure;
    if (typeof enc === 'string' && /^https?:/.test(enc)) return enc;
    if (Array.isArray(enc) && enc[0]) return enc[0].link || enc[0].url || '';
    if (typeof enc === 'object' && (enc.link || enc.url)) return enc.link || enc.url;
  }
  return pickFirstImg(item.content || item.description || '');
}

// ===== 抓取函数 =====
async function fetchOneHotlist(h) {
  const res = await fetch(h.api);
  const data = await res.json();
  if (!data || !data.data) throw new Error('热榜 API 返回异常');
  return data.data.slice(0, 15).map((item, idx) => ({
    title: (item.title || '').trim(),
    link: (item.url || item.mobileUrl || '').trim(),
    summary: item.desc || '',
    content: item.desc || item.content || '',
    cover: item.cover || item.pic || '',
    hot: parseHot(item.hot),
    rank: idx + 1,
    pubDate: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(),
  }));
}

async function fetchOneRss(feed) {
  const apiUrl = `https://api.rss2json.com/v1/api.json?count=10&rss_url=${encodeURIComponent(feed.url)}`;
  const res = await fetch(apiUrl);
  const data = await res.json();
  if (data.status !== 'ok' || !data.items) throw new Error(data.message || 'RSS 转换失败');
  return data.items.slice(0, 10).map(item => {
    const desc = item.description || item.content || '';
    return {
      title: (item.title || '').trim(),
      link: (item.link || '').trim(),
      summary: stripHtmlText(desc).slice(0, 120) + (desc.length > 120 ? '…' : ''),
      content: desc,
      cover: getBestCover(item),
      hot: 0,
      rank: 0,
      pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    };
  });
}

// ===== 主处理函数 =====
module.exports = async function handler(req, res) {
  // 验证：只允许 Vercel Cron 或带 CRON_SECRET 的请求触发
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!SUPABASE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY 未配置' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const t0 = Date.now();
  const summary = [];
  let totalAdded = 0;

  const ALL_SOURCES = [
    ...HOTLISTS.map(h => ({ ...h, type: 'hot' })),
    ...FEEDS.map(f => ({ ...f, type: 'rss' })),
  ];

  for (const src of ALL_SOURCES) {
    try {
      const items = src.type === 'hot' ? await fetchOneHotlist(src) : await fetchOneRss(src);
      let added = 0, skipped = 0;

      for (const item of items) {
        if (!item.title || !item.link) continue;
        const itemHash = strHash(item.title + '|' + item.link);

        // 去重
        const { count, error: cntErr } = await supabase
          .from('news')
          .select('id', { count: 'exact', head: true })
          .eq('hash', itemHash);
        if (cntErr) { console.error('count error', cntErr); continue; }
        if (count && count > 0) { skipped++; continue; }

        // 插入
        const { error: insErr } = await supabase.from('news').insert([{
          cat:        src.cat,
          source:     src.source,
          color:      src.color || '',
          title:      item.title,
          link:       item.link,
          summary:    item.summary,
          content:    item.content,
          cover:      item.cover || '',
          hot:        item.hot || 0,
          rank:       item.rank || 0,
          is_hot:     src.type === 'hot',
          is_ai:      false,
          pub_date:   item.pubDate,
          fetched_at: new Date().toISOString(),
          hash:       itemHash,
        }]);
        if (insErr) console.error('insert error', src.source, insErr.message);
        else added++;
      }

      summary.push({ source: src.source, added, skipped, total: items.length });
      totalAdded += added;
    } catch (e) {
      summary.push({ source: src.source, error: String(e.message || e) });
    }
  }

  // 顺手清理 30 天前的旧新闻
  let cleaned = 0;
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('news').delete({ count: 'exact' }).lt('pub_date', cutoff);
    cleaned = count || 0;
  } catch (e) { /* ignore */ }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  res.status(200).json({
    ok: true,
    elapsed: elapsed + 's',
    totalAdded,
    cleaned,
    summary,
    time: new Date().toISOString(),
  });
};
