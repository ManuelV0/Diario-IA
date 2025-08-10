import type { Handler } from '@netlify/functions';
import fetch from 'node-fetch';
import {
  getAuthorsWithAtLeastNPoems,
  getProfilesDiaryUpdatedAt,
} from '../utils/supabaseClient';

const LOCAL_NETLIFY_URL = process.env.LOCAL_NETLIFY_URL || 'http://localhost:8888';
const MIN_POEMS_TO_UPDATE = parseInt(process.env.MIN_POEMS_TO_UPDATE || '3', 10);
const CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY || '3', 10);
const BACKFILL_COOLDOWN_HOURS = parseInt(process.env.BACKFILL_COOLDOWN_HOURS || '24', 10);

function msSince(iso?: string | null) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return isNaN(t) ? Number.POSITIVE_INFINITY : Date.now() - t;
}
function hoursToMs(h: number) { return h * 60 * 60 * 1000; }

async function triggerJournal(author_id: string) {
  const started = Date.now();
  const url = `${LOCAL_NETLIFY_URL}/.netlify/functions/aggiorna-journal`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Non passiamo "content": la function pesca dal DB
    body: JSON.stringify({ author_id }),
  });
  const json = await res.json().catch(() => ({}));
  const elapsed = Date.now() - started;
  return { status: res.status, author_id, ms: elapsed, json };
}

export const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const authorIdSingle: string | undefined = body.author_id;
    const force = body.force === true || body.force === '1' || event.queryStringParameters?.force === '1';

    // Caso singolo autore (test/manuale)
    if (authorIdSingle) {
      const out = await triggerJournal(authorIdSingle);
      return { statusCode: 200, body: JSON.stringify({ ok: out.status === 200, result: out }) };
    }

    // 1) Autori con almeno N poesie
    const { authors, error } = await getAuthorsWithAtLeastNPoems(MIN_POEMS_TO_UPDATE);
    if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    if (!authors.length) return { statusCode: 200, body: JSON.stringify({ ok: true, processed: 0, results: [] }) };

    // 2) Filtro cooldown (salta chi è stato aggiornato < X ore fa), a meno di force
    const updatedMap = await getProfilesDiaryUpdatedAt(authors);
    const cutoffMs = hoursToMs(BACKFILL_COOLDOWN_HOURS);
    const toProcess = authors.filter((id) => force || msSince(updatedMap[id]) > cutoffMs);
    const skipped = authors
      .filter((id) => !toProcess.includes(id))
      .map((id) => ({ author_id: id, reason: 'cooldown', last_update: updatedMap[id] || null }));

    if (!toProcess.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          processed: 0,
          skipped,
          message: force ? 'Nessuno da processare' : `Tutti in cooldown (${BACKFILL_COOLDOWN_HOURS}h).`,
        }),
      };
    }

    // 3) Batch con concorrenza limitata
    const queue = [...toProcess];
    const results: any[] = [];

    async function worker() {
      while (queue.length) {
        const id = queue.shift()!;
        try {
          const res = await triggerJournal(id);
          results.push(res);
        } catch (e: any) {
          results.push({ author_id: id, status: 500, error: e?.message });
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, toProcess.length) }, () => worker());
    await Promise.all(workers);

    const okCount = results.filter((r) => r.status === 200).length;
    const totalMs = results.reduce((acc, r) => acc + (r.ms || 0), 0);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        processed: results.length,
        okCount,
        avg_ms_per_author: results.length ? Math.round(totalMs / results.length) : 0,
        cooldown_hours: BACKFILL_COOLDOWN_HOURS,
        force,
        skipped,
        results,
      }),
    };
  } catch (err: any) {
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || 'Errore inatteso' }) };
  }
};
