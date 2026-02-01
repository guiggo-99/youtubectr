
// netlify/functions/analyze.js
//
// IMPORTANTe: NUNCA coloque suas chaves aqui em texto.
// Configure em Environment Variables:
// - GEMINI_API_KEY=...
// - OPENAI_API_KEY=...
//
// Modelo (opcional):
// - GEMINI_MODEL=...
// - OPENAI_MODEL=...

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "ctr_optimizer";
const SNAPSHOT_KEY = "youtube_snapshot_v1";

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

function safeExtractJSON(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function clampText(s, maxChars) {
  const t = String(s || "");
  return t.length <= maxChars ? t : t.slice(0, maxChars) + "\n[...cortado...]";
}

function validateAIResult(obj) {
  if (!obj || typeof obj !== "object") return null;

  const title = String(obj.title || "").trim();
  const thumbText = String(obj.thumb_text || obj.thumbText || "").trim();
  const thumbPrompt = String(obj.thumb_prompt || obj.thumbPrompt || "").trim();
  const keywords = Array.isArray(obj.keywords) ? obj.keywords.map(x => String(x).trim()).filter(Boolean) : [];

  if (!title || title.length < 10) return null;
  if (!thumbText || thumbText.length < 2) return null;
  if (!thumbPrompt || thumbPrompt.length < 20) return null;

  // evita thumbText genérico
  const badThumb = new Set(["VIBE","ASSISTA","VEJA","CLIQUE","AGORA","TOP","MELHOR"]);
  if (badThumb.has(thumbText.toUpperCase())) return null;

  return { title, thumbText, thumbPrompt, keywords, patternUsed: String(obj.pattern_used || obj.patternUsed || "").trim() };
}

function buildPrompt({ formData, extracted, snapshot }) {
  const { format, niche, subniche, intention, emotion, risk } = formData;

  const snap = snapshot
    ? {
        generatedAt: snapshot.generatedAt,
        validUntil: snapshot.validUntil,
        filters: snapshot.filters,
        aggregates: snapshot.aggregates,
        samples: (snapshot.samples || []).slice(0, 20)
      }
    : null;

  // O extracted vem do front (reduz tokens e melhora coerência).
  const content = {
    primaryTheme: extracted?.primaryTheme,
    themes: extracted?.allThemes?.slice?.(0, 8) || [],
    anchorQuestions: extracted?.anchorQuestions?.slice?.(0, 4) || [],
    impactLines: extracted?.impactLines?.slice?.(0, 4) || [],
    excerpt: clampText(extracted?.rawExcerpt || "", 1400)
  };

  return `
Você é um especialista brasileiro em YouTube CTR (títulos e thumbnails) e precisa gerar respostas COERENTES e ESPECÍFICAS.

## CONTEXTO DO USUÁRIO
- Formato: ${format}
- Nicho: ${niche}
- Subnicho: ${subniche}
- Intenção: ${intention}
- Emoção desejada: ${emotion}
- Perfil de risco: ${risk}

## CONTEÚDO (resumo extraído do texto)
- Tema principal: ${content.primaryTheme || "(indefinido)"}
- Temas alternativos: ${content.themes.join(" | ") || "(nenhum)"}
- Perguntas âncora: ${content.anchorQuestions.join(" | ") || "(nenhuma)"}
- Linhas de impacto: ${content.impactLines.join(" | ") || "(nenhuma)"}

Trecho do texto (para manter fidelidade sem gastar tokens demais):
"""${content.excerpt}"""

## SNAPSHOT YOUTUBE (o que está funcionando agora)
${snap ? JSON.stringify(snap) : "(sem snapshot disponível — ainda assim gere a melhor resposta possível)"}

## TAREFA
Gere:
1) title: 1 título otimizado (PT-BR), ESPECÍFICO, fiel ao conteúdo.  
   - Se formato=Short: <= 55 caracteres
   - Se formato=Vídeo longo: <= 70 caracteres
   - Proibido: placeholders genéricos (ex.: "o que ninguém te contou" se não tiver gancho real no texto)
2) thumb_text: 1–3 palavras, CAIXA ALTA, NÃO genérico (evite: VIBE, ASSISTA, VEJA, AGORA)
3) thumb_prompt: um prompt completo e copiável (PT-BR) para gerar thumbnail em IA de imagens, incluindo:
   - Composição 16:9, close/medium shot conforme emoção
   - Cenário e símbolo coerente com o texto
   - Iluminação/contraste (rim light, fundo escuro se necessário)
   - Tipografia recomendada (usar o thumb_text)
   - Paleta sugerida e elementos a evitar
4) keywords: 5–8 palavras-chave (PT-BR) coerentes
5) pattern_used: em 1 linha, cite qual padrão do snapshot você adaptou (ex.: “Por que…”, “A verdade…”, etc.)

## FORMATO DE SAÍDA
Responda APENAS com JSON válido, sem texto fora do JSON:
{
  "title": "...",
  "thumb_text": "...",
  "thumb_prompt": "...",
  "keywords": ["..."],
  "pattern_used": "..."
}
`.trim();
}

async function callGemini({ apiKey, model, prompt }) {
  // Docs oficiais: usar x-goog-api-key no servidor (não no browser).
  // https://ai.google.dev/ (ver exemplos do generateContent)  (citamos no texto do chat)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 700
      }
    })
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, raw: text };
  }

  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, status: 500, raw: text }; }

  const outText =
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
    "";

  return { ok: true, status: 200, text: outText };
}

async function callOpenAI({ apiKey, model, prompt }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.6,
      max_output_tokens: 700
    })
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, raw: text };

  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, status: 500, raw: text }; }

  const outText = data.output_text || "";
  return { ok: true, status: 200, text: outText };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;   // <-- COLOQUE SUA CHAVE EM ENV VAR (Netlify)
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;   // <-- COLOQUE SUA CHAVE EM ENV VAR (Netlify)

  const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

  try {
    const body = (() => {
      try { return JSON.parse(event.body || "{}"); } catch { return {}; }
    })();

    const formData = body.formData || {};
    const extracted = body.extracted || {};
    const allowOpenAI = Boolean(body.allowOpenAI);

    if (!formData.idea || String(formData.idea).trim().length < 10) {
      return json(400, { ok: false, error: "Texto/ideia muito curta." });
    }
    if (!formData.niche || !formData.subniche) {
      return json(400, { ok: false, error: "Selecione nicho e especificidade." });
    }

    // carrega snapshot
    const store = getStore(STORE_NAME);
    const snapshot = await store.get(SNAPSHOT_KEY, { type: "json" });

    const prompt = buildPrompt({ formData, extracted, snapshot });

    // 1) tenta Gemini (default)
    if (!GEMINI_API_KEY) {
      // Sem chave: força modo local no front
      return json(200, {
        ok: true,
        provider: "LOCAL",
        mode: "missing_gemini_key",
        message: "GEMINI_API_KEY não configurada. Usando modo local no front."
      });
    }

    const g = await callGemini({ apiKey: GEMINI_API_KEY, model: GEMINI_MODEL, prompt });
    if (g.ok) {
      const parsed = validateAIResult(safeExtractJSON(g.text));
      if (parsed) {
        return json(200, {
          ok: true,
          provider: "GEMINI",
          ...parsed
        });
      }
      // Se a IA não respeitou JSON/qualidade, não faz nova chamada (pra economizar).
      return json(502, {
        ok: false,
        error: "Gemini respondeu em formato inválido. Tente novamente com um texto mais específico."
      });
    }

    // Gemini falhou — NÃO trocar automaticamente. Pede confirmação.
    const geminiMsg = `Gemini indisponível/limitado (status ${g.status}).`;
    if (!allowOpenAI) {
      return json(409, {
        ok: false,
        needsConfirmation: true,
        suggestedProvider: "OPENAI",
        message: `${geminiMsg} Posso usar OpenAI (isso pode consumir créditos)?`
      });
    }

    // 2) se confirmado, tenta OpenAI
    if (!OPENAI_API_KEY) {
      return json(400, { ok: false, error: "OPENAI_API_KEY não configurada nas variáveis de ambiente." });
    }

    const o = await callOpenAI({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL, prompt });
    if (!o.ok) {
      return json(500, { ok: false, error: `OpenAI falhou (status ${o.status}).` });
    }

    const parsed = validateAIResult(safeExtractJSON(o.text));
    if (!parsed) {
      return json(502, { ok: false, error: "OpenAI respondeu em formato inválido. Tente novamente." });
    }

    return json(200, {
      ok: true,
      provider: "OPENAI",
      ...parsed
    });

  } catch (err) {
    return json(500, { ok: false, error: err.message || "Erro interno" });
  }
};
