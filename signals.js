// netlify/functions/signals.js
//
// IMPORTANTe: NUNCA coloque sua chave aqui em texto.
// Configure em Environment Variables:
// - YOUTUBE_API_KEY=...
//
// Este endpoint:
// - GET  -> retorna snapshot atual (se existir)
// - POST -> atualiza snapshot (respeitando throttling básico)

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "ctr_optimizer";
const SNAPSHOT_KEY = "youtube_snapshot_v1";

const DEFAULT_WINDOW_DAYS = 30;       // “um mês”
const DEFAULT_REFRESH_DAYS = 21;      // você quer puxar ~a cada 21 dias
const MIN_VIDEO_VIEWS = 50000;        // filtro: vídeos fortes
const MIN_CHANNEL_SUBS = 50000;       // filtro: canais fortes
const REGION_CODE = "BR";
const RELEVANCE_LANG = "pt";

// Consultas “sementes” (simples e baratas) por nicho.
// Você pode ajustar depois, mas já dá um snapshot bem útil.
const SEED_QUERIES_BY_NICHE = {
  "Entretenimento": ["história narrada", "história emocionante", "história de vida"],
  "Relações Humanas": ["relacionamento", "traição", "término"],
  "Educação": ["curiosidades", "história explicada", "caso real"],
  "Espiritualidade": ["oração", "mensagem bíblica", "devocional"],
  "Finanças": ["renda extra", "dinheiro", "finanças pessoais"],
  "Música / Áudio": ["worship", "lofi", "instrumental"],
  "Saúde / Bem-estar": ["ansiedade", "sono", "relaxamento"],
  "Mistério / Curiosidade": ["mistério", "caso real", "true crime"],
  "Tecnologia": ["inteligência artificial", "ferramentas", "automação"],
  "Lifestyle": ["rotina", "vida simples", "minimalismo"]
};

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(data)
  };
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeTitle(title) {
  const stop = new Set([
    "a","o","as","os","um","uma","de","do","da","dos","das","em","no","na","nos","nas",
    "que","se","e","ou","mas","por","pra","para","com","sem","sobre","como","quando",
    "isso","aquilo","algo","coisa","hoje","ontem","amanha","agora","sempre","nunca",
    "voce","você","eu","ele","ela","eles","elas","meu","minha","seu","sua","teu","tua"
  ]);
  return normalize(title)
    .split(" ")
    .filter(w => w.length >= 3 && !stop.has(w));
}

function countNgrams(tokens, n, map) {
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join(" ");
    map.set(gram, (map.get(gram) || 0) + 1);
  }
}

function topK(map, k) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([text, count]) => ({ text, count }));
}

function classifyTemplate(title) {
  const t = normalize(title);
  const templates = [
    { name: "por que", test: () => t.startsWith("por que") || t.startsWith("porque") },
    { name: "como", test: () => t.startsWith("como ") },
    { name: "a verdade", test: () => t.includes("a verdade") },
    { name: "ninguem", test: () => t.includes("ninguém") || t.includes("ninguem") },
    { name: "cuidado/pare", test: () => t.includes("cuidado") || t.includes("pare") },
    { name: "erro", test: () => t.includes("erro") },
    { name: "segredo", test: () => t.includes("segredo") },
    { name: "o que", test: () => t.startsWith("o que ") || t.includes(" o que ") }
  ];
  const hit = templates.find(x => x.test());
  return hit ? hit.name : "outros";
}

async function ytFetch(url, apiKey) {
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function searchVideos({ q, publishedAfterISO, apiKey, maxResults = 12 }) {
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    q,
    order: "viewCount",
    maxResults: String(maxResults),
    regionCode: REGION_CODE,
    relevanceLanguage: RELEVANCE_LANG,
    publishedAfter: publishedAfterISO,
    key: apiKey
  });

  const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
  const data = await ytFetch(url, apiKey);

  const items = (data.items || []).map(it => ({
    videoId: it.id && it.id.videoId,
    channelId: it.snippet && it.snippet.channelId,
    title: it.snippet && it.snippet.title,
    publishedAt: it.snippet && it.snippet.publishedAt,
    channelTitle: it.snippet && it.snippet.channelTitle
  })).filter(x => x.videoId);

  return items;
}

async function getVideosStats(videoIds, apiKey) {
  // videos.list aceita até 50 ids por chamada
  const out = new Map();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: "snippet,statistics",
      id: batch.join(","),
      key: apiKey
    });
    const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
    const data = await ytFetch(url, apiKey);
    for (const it of (data.items || [])) {
      out.set(it.id, {
        videoId: it.id,
        title: it.snippet?.title || "",
        channelId: it.snippet?.channelId || "",
        channelTitle: it.snippet?.channelTitle || "",
        publishedAt: it.snippet?.publishedAt || "",
        viewCount: Number(it.statistics?.viewCount || 0),
        likeCount: Number(it.statistics?.likeCount || 0),
        commentCount: Number(it.statistics?.commentCount || 0)
      });
    }
  }
  return out;
}

async function getChannelsStats(channelIds, apiKey) {
  const out = new Map();
  for (let i = 0; i < channelIds.length; i += 50) {
    const batch = channelIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: "statistics,snippet",
      id: batch.join(","),
      key: apiKey
    });
    const url = `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`;
    const data = await ytFetch(url, apiKey);
    for (const it of (data.items || [])) {
      out.set(it.id, {
        channelId: it.id,
        channelTitle: it.snippet?.title || "",
        subscriberCount: Number(it.statistics?.subscriberCount || 0),
        channelViewCount: Number(it.statistics?.viewCount || 0)
      });
    }
  }
  return out;
}

async function buildSnapshot({ apiKey, refreshDays = DEFAULT_REFRESH_DAYS, windowDays = DEFAULT_WINDOW_DAYS }) {
  const now = new Date();
  const publishedAfter = new Date(now.getTime() - refreshDays * 24 * 60 * 60 * 1000).toISOString();
  const validUntil = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000).toISOString();

  // 1) coleta vídeos por “sementes”
  const queries = [];
  for (const niche of Object.keys(SEED_QUERIES_BY_NICHE)) {
    for (const q of SEED_QUERIES_BY_NICHE[niche]) {
      queries.push({ niche, q });
    }
  }

  // Limite de custo: não explode com dezenas de buscas.
  // Aqui são ~10 nichos * 3 queries = 30 chamadas search.list (100 unidades cada).
  // Se quiser mais barato, reduza para 1–2 queries por nicho.
  const MAX_SEARCH_CALLS = 20; // equilíbrio custo x qualidade
  const slicedQueries = queries.slice(0, MAX_SEARCH_CALLS);

  const found = [];
  for (const { niche, q } of slicedQueries) {
    const items = await searchVideos({ q, publishedAfterISO: publishedAfter, apiKey, maxResults: 12 });
    items.forEach(it => found.push({ ...it, nicheSeed: niche, seedQuery: q }));
  }

  const videoIds = [...new Set(found.map(x => x.videoId))];
  const videosMap = await getVideosStats(videoIds, apiKey);

  const channelIds = [...new Set([...videosMap.values()].map(v => v.channelId).filter(Boolean))];
  const channelsMap = await getChannelsStats(channelIds, apiKey);

  // 2) filtra e prepara lista final
  const all = [];
  for (const v of videosMap.values()) {
    const ch = channelsMap.get(v.channelId);
    if (!ch) continue;

    if (v.viewCount < MIN_VIDEO_VIEWS) continue;
    if (ch.subscriberCount < MIN_CHANNEL_SUBS) continue;

    all.push({
      videoId: v.videoId,
      title: v.title,
      publishedAt: v.publishedAt,
      viewCount: v.viewCount,
      likeCount: v.likeCount,
      commentCount: v.commentCount,
      channelId: v.channelId,
      channelTitle: ch.channelTitle || v.channelTitle,
      subscriberCount: ch.subscriberCount,
      channelViewCount: ch.channelViewCount
    });
  }

  // 3) agrega padrões de título
  const wordCounts = new Map();
  const bigrams = new Map();
  const trigrams = new Map();
  const templates = new Map();
  const lengths = [];

  for (const item of all) {
    const tokens = tokenizeTitle(item.title);
    lengths.push(item.title.length);

    for (const w of tokens) wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    countNgrams(tokens, 2, bigrams);
    countNgrams(tokens, 3, trigrams);

    const temp = classifyTemplate(item.title);
    templates.set(temp, (templates.get(temp) || 0) + 1);
  }

  lengths.sort((a, b) => a - b);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  const avg = lengths.length ? Math.round(lengths.reduce((s, x) => s + x, 0) / lengths.length) : 0;

  const snapshot = {
    version: 1,
    generatedAt: now.toISOString(),
    validUntil,
    refreshDays,
    windowDays,
    filters: {
      regionCode: REGION_CODE,
      relevanceLanguage: RELEVANCE_LANG,
      minVideoViews: MIN_VIDEO_VIEWS,
      minChannelSubs: MIN_CHANNEL_SUBS
    },
    aggregates: {
      topWords: topK(wordCounts, 30),
      topBigrams: topK(bigrams, 25),
      topTrigrams: topK(trigrams, 20),
      topTemplates: topK(templates, 10),
      titleLength: { avg, median }
    },
    samples: all
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 30)
      .map(x => ({
        title: x.title,
        viewCount: x.viewCount,
        channelTitle: x.channelTitle,
        subscriberCount: x.subscriberCount
      })),
    totalCandidates: all.length
  };

  return snapshot;
}

exports.handler = async (event) => {
  const store = getStore(STORE_NAME);
  const apiKey = process.env.YOUTUBE_API_KEY; // <-- COLOQUE SUA CHAVE EM ENV VAR (Netlify)

  try {
    if (event.httpMethod === "GET") {
      const snapshot = await store.get(SNAPSHOT_KEY, { type: "json" });
      if (!snapshot) {
        return json(200, {
          ok: true,
          status: "empty",
          snapshot: null
        });
      }
      return json(200, { ok: true, status: "ready", snapshot });
    }

    if (event.httpMethod === "POST") {
      if (!apiKey) {
        return json(400, { ok: false, error: "YOUTUBE_API_KEY não configurada nas variáveis de ambiente." });
      }

      const body = (() => {
        try { return JSON.parse(event.body || "{}"); } catch { return {}; }
      })();

      const force = Boolean(body.force);
      const refreshDays = Number(body.refreshDays || DEFAULT_REFRESH_DAYS);
      const windowDays = Number(body.windowDays || DEFAULT_WINDOW_DAYS);

      const existing = await store.get(SNAPSHOT_KEY, { type: "json" });

      // Throttle simples: se já atualizou há menos de 6h, não refaz (a não ser force=true)
      if (!force && existing?.generatedAt) {
        const ageMs = Date.now() - new Date(existing.generatedAt).getTime();
        if (ageMs < 6 * 60 * 60 * 1000) {
          return json(200, { ok: true, status: "throttled", snapshot: existing });
        }
      }

      const snapshot = await buildSnapshot({ apiKey, refreshDays, windowDays });
      await store.set(SNAPSHOT_KEY, snapshot);

      return json(200, { ok: true, status: "updated", snapshot });
    }

    return json(405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Erro interno" });
  }
};
