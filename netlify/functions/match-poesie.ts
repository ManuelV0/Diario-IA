
// netlify/functions/match-poesie.ts
import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

/* ============================
   SUPABASE
   ============================ */
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

/* ============================
   CORS HEADERS (OBBLIGATORI)
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

  /* ===== PRE-FLIGHT ===== */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  /* ===== SOLO POST ===== */
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const { poesia_id } = body;

    if (!poesia_id) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'poesia_id mancante' })
      };
    }

    /* 1️⃣ EMBEDDING */
    const { data: poesia } = await supabase
      .from('poesie')
      .select('poetic_embedding_vec')
      .eq('id', poesia_id)
      .single();

    if (!poesia?.poetic_embedding_vec) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Embedding non trovato' })
      };
    }

    /* 2️⃣ MATCH */
    const { data: matches, error } = await supabase.rpc(
      'match_poesie',
      {
        poesia_id,
        query_embedding: poesia.poetic_embedding_vec,
        match_count: 5
      }
    );

    if (error) {
      console.error('[RPC ERROR]', error);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Errore RPC' })
      };
    }

    /* 3️⃣ OK */
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ matches: matches || [] })
    };

  } catch (err: any) {
    console.error('[MATCH ERROR]', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Errore interno' })
    };
  }
};

export default handler;
