import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

/* ============================
   CORS HEADERS (RIUSABILI)
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
     PRE-FLIGHT (OBBLIGATORIO)
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
       ENV (DENTRO HANDLER!)
       ============================ */
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'Supabase environment variables mancanti'
        })
      };
    }

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

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

    if (poesiaErr || !poesia?.poetic_embedding_vec) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'Embedding non trovato per la poesia richiesta'
        })
      };
    }

    /* ============================
       2️⃣ MATCH VIA RPC
       ============================ */
    const { data: matches, error: matchErr } = await supabase.rpc(
      'match_poesie',
      {
        poesia_id,
        query_embedding: poesia.poetic_embedding_vec,
        match_count: 5
      }
    );

    if (matchErr) {
      console.error('[RPC match_poesie ERROR]', matchErr);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'Errore nel calcolo delle poesie consigliate'
        })
      };
    }

    /* ============================
       3️⃣ RESPONSE OK
       ============================ */
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        matches: matches || []
      })
    };

  } catch (err: any) {
    console.error('[MATCH POESIE UNEXPECTED ERROR]', err);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: err?.message || 'Errore interno del server'
      })
    };
  }
};

export default handler;
