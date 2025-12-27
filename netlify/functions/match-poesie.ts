// netlify/functions/match-poesie.ts
import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

/* ============================
   SUPABASE CONFIG
   ============================ */
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

/* ============================
   CORS HEADERS (GLOBAL)
   ============================ */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

/* ============================
   HANDLER
   ============================ */
export const handler: Handler = async (event) => {
  /* ============================
     PREFLIGHT (OBBLIGATORIO)
     ============================ */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  /* ============================
     SOLO POST
     ============================ */
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    /* ============================
       PARSE BODY
       ============================ */
    let body: any = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Body JSON non valido' })
      };
    }

    const { poesia_id } = body;

    if (!poesia_id) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'poesia_id mancante' })
      };
    }

    /* ============================
       1️⃣ RECUPERO EMBEDDING
       ============================ */
    const { data: poesia, error: poesiaErr } = await supabase
      .from('poesie')
      .select('poetic_embedding_vec')
      .eq('id', poesia_id)
      .single();

    const embedding = poesia?.poetic_embedding_vec;

    /**
     * 🔒 PROTEZIONE CRITICA
     * - embedding mancante / nullo / vuoto
     * - niente RPC
     * - UX stabile → matches vuoto
     */
    if (
      poesiaErr ||
      !embedding ||
      !Array.isArray(embedding) ||
      embedding.length === 0
    ) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ matches: [] })
      };
    }

    /* ============================
       2️⃣ MATCH VIA RPC (pgvector)
       ============================ */
    const { data: matches, error: matchErr } = await supabase.rpc(
      'match_poesie',
      {
        poesia_id,
        query_embedding: embedding,
        match_count: 5
      }
    );

    if (matchErr) {
      console.error('[RPC match_poesie ERROR]', matchErr);

      // ❗ MAI 500 al frontend
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ matches: [] })
      };
    }

    /* ============================
       3️⃣ RESPONSE OK
       ============================ */
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        matches: Array.isArray(matches) ? matches : []
      })
    };

  } catch (err: any) {
    console.error('[MATCH POESIE UNEXPECTED ERROR]', err);

    // ❗ FAIL-SAFE ASSOLUTO
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ matches: [] })
    };
  }
};

export default handler;
