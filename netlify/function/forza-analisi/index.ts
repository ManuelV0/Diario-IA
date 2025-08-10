import type { Handler } from '@netlify/functions';
import OpenAI from 'openai';
import {
  upsertPoemMinimal,
  updatePoemAnalyses,
  countPoemsByAuthor,
} from '../utils/supabaseClient';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LOCAL_NETLIFY_URL = process.env.LOCAL_NETLIFY_URL || 'http://localhost:8888';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const MIN_POEMS_TO_UPDATE = parseInt(process.env.MIN_POEMS_TO_UPDATE || '3', 10);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ─────────────────────────────
// Utils
// ─────────────────────────────
const hasKeys = (o: any) => !!o && typeof o === 'object' && Object.keys(o).length > 0;

async function withTimeout<T>(p: Promise<T>, ms = 30000): Promise<T> {
  const t = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms));
  return Promise.race([p, t]) as Promise<T>;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  try { return await fn(); } catch (e) { if (retries <= 0) throw e; return withRetry(fn, retries - 1); }
}

function buildMessages(kind: 'psico' | 'letterario' | 'profilo', payload: any) {
  const base = [{ role: 'system' as const, content: 'Sei un analista di poesia. Rispondi SOLO con JSON valido.' }];
  if (kind === 'psico') return [...base, { role: 'user' as const, content: JSON.stringify({
    task: 'analisi_psicologica',
    schema_atteso: { emozioni_prevalenti: ['string'], tensioni: ['string'], prospettiva_io: 'string', note: 'string' },
    poesia: payload
  }) }];
  if (kind === 'letterario') return [...base, { role: 'user' as const, content: JSON.stringify({
    task: 'analisi_letteraria',
    schema_atteso: { figure_ret: ['string'], metriche: ['string'], stile: ['string'], note: 'string' },
    poesia: payload
  }) }];
  return [...base, { role: 'user' as const, content: JSON.stringify({
    task: 'profilo_poetico',
    schema_atteso: {
      voce: 'string',
      tono: ['string'],
      temi_ricorrenti: ['string'],
      immagini_metafore_tipiche: ['string'],
      influenze_letterarie: ['string'],
      sintesi: 'string'
    },
    poesia: payload
  }) }];
}

async function askGPT(messages: any[]) {
  const res = await withRetry(
    () => withTimeout(openai.chat.completions.create({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages
    }), 45000),
    1
  );
  const content = res.choices[0]?.message?.content || '{}';
  try { return JSON.parse(content); } catch { return {}; }
}

// ─────────────────────────────
// Handler
// ─────────────────────────────
export const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };

    const body = JSON.parse(event.body || '{}');

    // accettiamo user_id per retrocompat, ma preferiamo author_id come input applicativo
    const author_id: string | undefined = body.author_id || body.user_id;
    const poemId: string | undefined = body.poem_id || body.poemId;
    const title: string = body.title || '';
    const poemText: string = body.content || body.poemText || '';

    if (!author_id) return { statusCode: 400, body: JSON.stringify({ error: 'author_id mancante' }) };
    if (!poemId) return { statusCode: 400, body: JSON.stringify({ error: 'poem_id mancante' }) };
    if (!poemText) return { statusCode: 400, body: JSON.stringify({ error: 'poemText/content mancante' }) };

    // 1) Upsert minimale della poesia (garantisce che il count salga anche in test isolati)
    const upsertRes = await upsertPoemMinimal(poemId, author_id, { title, text: poemText });
    if (upsertRes.error) {
      console.error('[forza-analisi] upsert poesia error:', upsertRes.error.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Errore upsert poesia', detail: upsertRes.error.message }) };
    }

    // 2) Analisi GPT in parallelo
    const payload = { title, content: poemText, author_id, poem_id: poemId };
    const [analisi_psicologica, analisi_letteraria, profilo_poetico] = await Promise.all([
      askGPT(buildMessages('psico', payload)),
      askGPT(buildMessages('letterario', payload)),
      askGPT(buildMessages('profilo', payload)),
    ]);

    // 3) Aggiorna record poesia con le analisi
    const updateRes = await updatePoemAnalyses(poemId, {
      analisi_psicologica,
      analisi_letteraria,
      profilo_poetico,
    });
    if (updateRes.error) {
      console.error('[forza-analisi] update poesia error:', updateRes.error.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Errore update poesia', detail: updateRes.error.message }) };
    }

    // 4) Conta poesie per autore
    const { count: poemsCount, error: countErr } = await countPoemsByAuthor(author_id);
    if (countErr) console.warn('[forza-analisi] countPoemsByAuthor error:', countErr.message);

    let journal: any = null;
    let triggered = false;
    console.info('[forza-analisi] poemsCount:', poemsCount, 'author:', author_id);

    // 5) Trigger automatico ogni N poesie (default 3)
    if (!countErr && poemsCount >= MIN_POEMS_TO_UPDATE && poemsCount % MIN_POEMS_TO_UPDATE === 0) {
      console.info('[forza-analisi] threshold reached → triggering aggiorna-journal', { author_id, poemsCount, poemId });
      const journalUrl = `${LOCAL_NETLIFY_URL}/.netlify/functions/aggiorna-journal`;
      const r = await fetch(journalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // NON passiamo content: il journal pesca dal DB
        body: JSON.stringify({ author_id, poem_id: poemId, title, public_page_url: PUBLIC_BASE_URL }),
      });
      journal = await r.json().catch(() => ({}));
      triggered = true;
    } else {
      console.info('[forza-analisi] threshold not reached — no journal update', {
        author_id,
        poemsCount,
        needed: MIN_POEMS_TO_UPDATE - (poemsCount % MIN_POEMS_TO_UPDATE || MIN_POEMS_TO_UPDATE),
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        poem_id: poemId,
        author_id,
        saved_fields: {
          analisi_psicologica: hasKeys(analisi_psicologica),
          analisi_letteraria: hasKeys(analisi_letteraria),
          profilo_poetico: hasKeys(profilo_poetico),
        },
        poemsCount,
        journal_triggered: triggered,
        journal,
      }),
    };
  } catch (err: any) {
    console.error('[forza-analisi] Error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || 'Errore inatteso' }) };
  }
};
