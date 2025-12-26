
// netlify/functions/match-poesie.ts
import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

export const handler: Handler = async (event) => {
  try {
    // 🔒 Solo POST
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method Not Allowed' })
      };
    }

    // 📥 Parse body
    let body: any = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Body JSON non valido' })
      };
    }

    const { poesia_id } = body;

    if (!poesia_id) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'poesia_id mancante' })
      };
    }

    // 1️⃣ Recupero embedding della poesia richiesta
    const { data: poesia, error: poesiaErr } = await supabase
      .from('poesie')
      .select('poetic_embedding_vec')
      .eq('id', poesia_id)
      .single();

    if (poesiaErr || !poesia?.poetic_embedding_vec) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Embedding non trovato per la poesia richiesta' })
      };
    }

    // 2️⃣ Match tramite RPC SQL (pgvector)
    const { data: matches, error: matchErr } = await supabase.rpc(
      'match_poesie',
      {
        poesia_id, // ✅ QUESTO ERA IL PUNTO CHIAVE
        query_embedding: poesia.poetic_embedding_vec,
        match_count: 5
      }
    );

    if (matchErr) {
      console.error('RPC match_poesie error:', matchErr);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Errore nel calcolo delle poesie consigliate' })
      };
    }

    // 3️⃣ Risposta finale
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matches: matches || [] })
    };

  } catch (err: any) {
    console.error('Unexpected match-poesie error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: err?.message || 'Errore interno del server'
      })
    };
  }
};

export default handler;
