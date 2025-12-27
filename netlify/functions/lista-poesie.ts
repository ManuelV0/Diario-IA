// netlify/functions/poesie.ts

import { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const ALLOWED_ORIGINS = [
  "https://theitalianpoetryproject.com",
  "https://poetry.theitalianpoetryproject.com",
  "https://widget.theitalianpoetryproject.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173"
]

const handler: Handler = async (event) => {
  const origin = event.headers.origin || ""
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]

  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin"
  }

  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ""
    }
  }

  // Solo GET
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Metodo non consentito" })
    }
  }

  try {
    const { data, error } = await supabase
      .from('poesie')
      .select('id, title, content, author_name, analisi_letteraria, analisi_psicologica, created_at, audio_url')
      .order('created_at', { ascending: false })

    if (error) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: error.message })
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(data)
    }
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message })
    }
  }
}

export { handler }
