// netlify/functions/aggiorna-journal/index.ts

import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// ---- ENV CONFIG ----
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY,
  POEMS_AUTHOR_COLUMN = 'user_id',
  MIN_POEMS_TO_UPDATE = '3',
  PUBLIC_BASE_URL
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
}
if (!OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY in environment');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- UTILS ----
function normalizePoem(poem: any) {
  return {
    id: poem.id,
    title: poem.title || poem.titolo || '',
    text: poem.content || poem.testo || ''
  };
}

function buildCorpus(poems: { title: string; text: string }[]) {
  return poems.map((p) => `${p.title}\n\n${p.text}`).join('\n\n---\n\n');
}

// ---- HANDLER ----
export const handler: Handler = async (event) => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const authorId = body.author_id || body.user_id || body[POEMS_AUTHOR_COLUMN];
    const debug = !!body.debug;
    const dryRun = !!body.dry_run;

    if (!authorId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Missing author_id or ${POEMS_AUTHOR_COLUMN}` })
      };
    }

    // 1) Recupero poesie
    const { data: poems, error: poemsError } = await supabase
      .from('poesie')
      .select('id, title, titolo, content, testo, created_at')
      .eq(POEMS_AUTHOR_COLUMN, authorId)
      .order('created_at', { ascending: true });

    if (poemsError) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Supabase select poems error: ${JSON.stringify(poemsError)}` })
      };
    }

    const normalizedPoems = (poems || []).map(normalizePoem);
    if (debug) console.log('Normalized poems:', normalizedPoems);

    const poemsCount = normalizedPoems.length;
    if (poemsCount < Number(MIN_POEMS_TO_UPDATE)) {
      return {
        statusCode: 200,
        body: JSON.stringify({ triggered: false, poemsCount, reason: 'Below minimum threshold' })
      };
    }

    // 2) Recupero diario precedente
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('poetic_journal, last_updated')
      .eq('id', authorId)
      .single();

    if (profileError) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Supabase select profile error: ${JSON.stringify(profileError)}` })
      };
    }

    const previousJournal = profile?.poetic_journal || '';

    // 3) Prompt GPT
    const corpus = buildCorpus(normalizedPoems);
    const prompt = `
Aggiorna il diario dell'autore in base a queste poesie:
${corpus}

Diario precedente:
${previousJournal}
    `;

    let gptResponse;
    try {
      gptResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      });
    } catch (err) {
      console.error('OpenAI error:', err);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'OpenAI request failed' })
      };
    }

    const newJournal = gptResponse.choices[0]?.message?.content || '';

    if (dryRun) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          triggered: true,
          poemsCount,
          previousJournal,
          newJournal
        })
      };
    }

    // 4) Salvataggio in Supabase
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        poetic_journal: newJournal,
        last_updated: new Date().toISOString()
      })
      .eq('id', authorId);

    if (updateError) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Supabase update profile error: ${JSON.stringify(updateError)}` })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ triggered: true, poemsCount, updated: true })
    };
  } catch (err) {
    console.error('Unexpected error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
    };
  }
};
