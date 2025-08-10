
const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// --- CONFIGURAZIONE SUPABASE (SERVICE KEY necessaria!) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = 'uScy1bXtKz8vPzfdFsFw'; // Voce italiana maschile ElevenLabs

console.log("[BOOT] SUPABASE_URL:", SUPABASE_URL);
console.log("[BOOT] SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY.slice(0,8)+"..." : "undefined");
console.log("[BOOT] ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.slice(0,8)+"..." : "undefined");

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
);

// --- CORS UNIVERSALE ROBUSTO ---
const ALLOWED_ORIGINS = [
  "https://www.theitalianpoetryproject.com",
  "https://theitalianpoetryproject.com",
  "https://poetry.theitalianpoetryproject.com",
  "https://widget.theitalianpoetryproject.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173"
];

exports.handler = async function(event, context) {
  const origin = event.headers.origin || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin"
  };

  // --- Preflight CORS ---
  if (event.httpMethod === "OPTIONS") {
    console.log("[CORS] Preflight OPTIONS request");
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ""
    };
  }

  // --- Solo POST ---
  if (event.httpMethod !== 'POST') {
    console.log("[ERROR] Metodo non ammesso:", event.httpMethod);
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Solo POST ammesso' }),
    };
  }

  // --- Check ENV ---
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ELEVENLABS_API_KEY) {
    console.log("[ERROR] Variabili ENV mancanti!", {
      SUPABASE_URL,
      SUPABASE_SERVICE_KEY,
      ELEVENLABS_API_KEY
    });
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Configurazione server incompleta (env missing)' }),
    };
  }

  // --- Parse dati body ---
  let text, poesia_id;
  try {
    ({ text, poesia_id } = JSON.parse(event.body || '{}'));
    console.log("[PAYLOAD] text:", text ? text.slice(0,30)+"..." : undefined, "poesia_id:", poesia_id);
  } catch (err) {
    console.log("[ERROR] Body non valido:", err);
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Body non valido' }),
    };
  }

  if (!text || !poesia_id) {
    console.log("[ERROR] text o poesia_id mancante!");
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Testo o ID poesia mancante' }),
    };
  }

  try {
    // 1. Richiesta TTS a ElevenLabs
    console.log("[TTS] Invio richiesta a ElevenLabs...");
    const ttsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!ttsResponse.ok) {
      const errorText = await ttsResponse.text();
      console.log("[ERROR] ElevenLabs:", ttsResponse.status, errorText);
      return {
        statusCode: ttsResponse.status,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Errore dal servizio vocale', details: errorText }),
      };
    }

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    console.log("[TTS] Audio generato:", audioBuffer.length, "bytes");

    // 2. Carica su Supabase Storage
    const fileName = `poesia-${poesia_id}-${Date.now()}.mp3`;
    console.log("[SUPABASE] Upload in corso:", fileName);

    const { error: uploadError } = await supabase
      .storage
      .from('poetry-audio')
      .upload(fileName, audioBuffer, {
        contentType: 'audio/mpeg',
        upsert: true
      });

    if (uploadError) {
      console.log("[ERROR] Supabase upload error:", uploadError);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Upload audio fallito', details: uploadError.message }),
      };
    }
    console.log("[SUPABASE] Upload OK");

    // 3. Ottieni URL pubblico
    const { data: { publicUrl }, error: urlError } = supabase
      .storage
      .from('poetry-audio')
      .getPublicUrl(fileName);

    if (urlError || !publicUrl) {
      console.log("[ERROR] Supabase getPublicUrl error:", urlError);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'URL pubblico non trovato', details: urlError?.message }),
      };
    }
    console.log("[SUPABASE] URL pubblico:", publicUrl);

    // 4. Aggiorna la tabella poesie
    const { error: updateError } = await supabase
      .from('poesie')
      .update({ audio_url: publicUrl, audio_generated: true })
      .eq('id', poesia_id);

    if (updateError) {
      console.log("[WARNING] DB update error:", updateError.message);
    } else {
      console.log("[DB] poesia aggiornata con audio_url");
    }

    // Successo finale!
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ audio_url: publicUrl }),
    };

  } catch (error) {
    console.log("[ERROR] catch generale:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Errore interno del server', details: error.message }),
    };
  }
};
