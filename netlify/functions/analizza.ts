// netlify/functions/poetry-ai.js
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// === Utility per ENV ===
const reqEnv = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Variabile d'ambiente mancante: ${k}`);
  return v;
};

// === Config ===
const SUPABASE_URL = reqEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = reqEnv('SUPABASE_ANON_KEY'); // per auth.getUser
const SUPABASE_SERVICE_ROLE_KEY = reqEnv('SUPABASE_SERVICE_ROLE_KEY'); // per DB write
const OPENAI_API_KEY = reqEnv('OPENAI_API_KEY');

const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const supabaseDb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: 'public' }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// CORS
const CORS = {
  'Access-Control-Allow-Origin': '*', // restringi ai tuoi domini se vuoi
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

// Helpers
const json = (status, body) => ({ statusCode: status, body: JSON.stringify(body), headers: CORS });

const buildPrompt = (content) => `
Agisci come un "Futurista Strategico" e un analista di sistemi complessi.
Il tuo compito non è predire il futuro, ma mappare le sue possibilità per fornire un vantaggio decisionale.

Argomento: ${content}

Proiettalo 20 anni nel futuro e crea un dossier strategico completo in formato JSON con la seguente struttura obbligatoria:

{
  "vettori_di_cambiamento_attuali": [
    "Descrizione del vettore 1",
    "Descrizione del vettore 2",
    "Descrizione del vettore 3"
  ],
  "scenario_ottimistico": "Descrizione dettagliata dell'utopia plausibile",
  "scenario_pessimistico": "Descrizione dettagliata della distopia plausibile",
  "fattori_inattesi": {
    "positivo_jolly": "Evento positivo imprevisto",
    "negativo_cigno_nero": "Evento negativo imprevisto"
  },
  "dossier_strategico_oggi": {
    "azioni_preparatorie_immediate": [
      "Azione 1",
      "Azione 2",
      "Azione 3"
    ],
    "opportunita_emergenti": [
      "Opportunità 1",
      "Opportunità 2"
    ],
    "rischio_esistenziale_da_mitigare": "Descrizione del rischio"
  }
}

Requisiti:
- Pensa in modo sistemico.
- Tono lucido e privo di sensazionalismo.
- Usa esempi concreti.
`;

const mockAnalysis = () => ({
  vettori_di_cambiamento_attuali: [
    "Avanzamenti tecnologici generici",
    "Cambiamenti sociali globali",
    "Tendenze economiche emergenti"
  ],
  scenario_ottimistico: "Utopia plausibile con cooperazione globale e uso etico delle tecnologie.",
  scenario_pessimistico: "Distopia plausibile con crisi geopolitiche e uso dannoso delle tecnologie.",
  fattori_inattesi: {
    positivo_jolly: "Scoperta scientifica che risolve una crisi globale.",
    negativo_cigno_nero: "Evento catastrofico che sconvolge l'economia mondiale."
  },
  dossier_strategico_oggi: {
    azioni_preparatorie_immediate: [
      "Investire in formazione continua",
      "Diversificare le entrate",
      "Costruire reti di collaborazione"
    ],
    opportunita_emergenti: [
      "Tecnologie sostenibili",
      "Mercati legati all’adattamento climatico"
    ],
    rischio_esistenziale_da_mitigare: "Collasso ecologico globale"
  }
});

export const handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Solo POST consentito' });
  }

  // Auth
  const authHeader = event.headers.authorization || event.headers.Authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return json(401, { error: 'Token JWT mancante' });

  let user;
  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) throw error || new Error('Utente non trovato');
    user = data.user;
  } catch (e) {
    return json(403, { error: 'Accesso non autorizzato', details: e?.message });
  }

  // Body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Formato JSON non valido' });
  }

  const contentRaw = typeof body.content === 'string' ? body.content.trim() : '';
  if (!contentRaw) return json(400, { error: 'Il campo "content" è obbligatorio' });

  // Protezione token/contesto: taglia se troppo lungo (evita sfori di token)
  const content = contentRaw.length > 6000 ? contentRaw.slice(0, 6000) + '…' : contentRaw;

  // OpenAI
  let analysis = null;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildPrompt(content) }],
      temperature: 0.7,
    });

    const text = completion.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text);

    // Validazione minima delle chiavi attese
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.vettori_di_cambiamento_attuali &&
      parsed.scenario_ottimistico &&
      parsed.scenario_pessimistico &&
      parsed.fattori_inattesi &&
      parsed.dossier_strategico_oggi
    ) {
      analysis = parsed;
    } else {
      analysis = mockAnalysis();
    }
  } catch (e) {
    console.error('OpenAI error:', e);
    analysis = mockAnalysis();
  }

  // Inserimento DB
  const row = {
    title: body.title || null,
    content,
    author_name: body.author_name || user.user_metadata?.full_name || null,
    profile_id: user.id,
    instagram_handle: body.instagram_handle || null,
    analisi_letteraria: null, // non usata
    analisi_psicologica: analysis, // JSONB
    match_id: body.match_id || null,
    created_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await supabaseDb.from('poesie').insert(row).select('*').single();
    if (error) throw error;
    return json(201, data);
  } catch (e) {
    console.error('DB error:', e);
    return json(500, { error: 'Errore interno del server', details: e?.message });
  }
};
