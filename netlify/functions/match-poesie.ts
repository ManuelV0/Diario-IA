// netlify/functions/match-poesie.ts
import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  /* PRE-FLIGHT */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

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

    /* 1️⃣ Recupero poesia */
    const { data: poesia, error } = await supabase
      .from('poesie')
      .select('id, poetic_embedding_vec')
      .eq('id', poesia_id)
      .single();

    if (error || !poesia) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ matches: [] })
      };
    }

    /* ===========================
       CASO A — MATCH SEMANTICO
       =========================== */
    if (poesia.poetic_embedding_vec) {
      const { data: matches, error: rpcError } = await supabase.rpc(
        'match_poesie',
        {
          poesia_id,
          query_embedding: poesia.poetic_embedding_vec,
          match_count: 5
        }
      );

      if (!rpcError && Array.isArray(matches) && matches.length > 0) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({ matches })
        };
      }
    }

    /* ===========================
       CASO B — FALLBACK ROBUSTO
       =========================== */
    const { data: fallback } = await supabase
      .from('poesie')
      .select('id, title, author_name')
      .neq('id', poesia_id)
      .not('poetic_embedding_vec', 'is', null)
      .order('created_at', { ascending: false })
      .limit(5);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ matches: fallback || [] })
    };

  } catch (err: any) {
    console.error('[MATCH POESIE FATAL]', err);

    return {
      statusCode: 200, // ⚠️ volutamente 200 → il frontend non deve rompersi
      headers: corsHeaders,
      body: JSON.stringify({ matches: [] })
    };
  }
};

export default handler;