import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// ====== ENV ======
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const POEMS_AUTHOR_COLUMN = (process.env.POEMS_AUTHOR_COLUMN || 'user_id') as 'user_id' | 'author_id'
const MIN_POEMS_TO_UPDATE = Number(process.env.MIN_POEMS_TO_UPDATE || 3)

// URL base per chiamare altre Netlify Functions dello stesso sito
const SITE_BASE_URL =
  process.env.URL ||
  process.env.DEPLOY_PRIME_URL ||
  process.env.NETLIFY_LOCAL_URL ||
  '' // se vuoto, useremo relativa "/.netlify/functions/..."

// ====== CLIENTS ======
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// ====== CORS ======
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

// ====== UTILS ======
function safeJsonParse<T = any>(v: any): T | null {
  if (!v) return null
  if (typeof v === 'object') return v as T
  try { return JSON.parse(String(v)) } catch { return null }
}

function buildFnUrl(name: string) {
  // Preferisci assoluto se disponibile, altrimenti relativo (funziona anche in produzione)
  const base = SITE_BASE_URL?.startsWith('http') ? SITE_BASE_URL : ''
  return `${base}/.netlify/functions/${name}`
}

async function upsertPoem({
  id, authorId, title, content
}: { id: string, authorId: string, title?: string | null, content?: string | null }) {
  // Se esiste aggiorno i campi di base (title/content); altrimenti inserisco
  const payload: any = {
    id,
    [POEMS_AUTHOR_COLUMN]: authorId,
  }
  if (title != null) payload.title = title
  if (content != null) payload.content = content

  const { error } = await supabase
    .from('poesie')
    .upsert(payload, { onConflict: 'id' })
  if (error) throw new Error(`Errore upsert poesia: ${error.message}`)
}

async function saveAnalyses(poemId: string, {
  analisi_psicologica,
  analisi_letteraria,
  profilo_poetico
}: {
  analisi_psicologica: any,
  analisi_letteraria: any,
  profilo_poetico: any
}) {
  const { error } = await supabase
    .from('poesie')
    .update({
      analisi_psicologica,
      analisi_letteraria,
      profilo_poetico
    })
    .eq('id', poemId)

  if (error) throw new Error(`Errore salvataggio analisi: ${error.message}`)
}

async function countPoemsByAuthor(authorId: string): Promise<number> {
  const { count, error } = await supabase
    .from('poesie')
    .select('id', { count: 'exact', head: true })
    .eq(POEMS_AUTHOR_COLUMN as any, authorId)
  if (error) throw new Error(`Errore conteggio poesie: ${error.message}`)
  return count ?? 0
}

async function triggerJournalUpdate(authorId: string, newestPoem?: { id: string, title?: string | null, content?: string | null }) {
  const url = buildFnUrl('aggiorna-journal')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: authorId,
      poem_id: newestPoem?.id,
      title: newestPoem?.title,
      content: newestPoem?.content,
      source: 'forza-analisi'
    })
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(`aggiorna-journal HTTP ${res.status} ${msg}`)
  }
}

// ====== PROMPTS (semplici e robusti per JSON) ======
function promptAnalisiPsicologica(text: string) {
  return `Analizza il seguente testo poetico dal punto di vista psicologico. Rispondi in JSON valido con queste chiavi:
{
  "fallacie_logiche": string[] | {nome:string,evidenze:string[]}[],
  "bias_cognitivi": string[] | {nome:string,evidenze:string[]}[],
  "meccanismi_di_difesa": string[] | {nome:string,evidenze:string[]}[],
  "schemi_autosabotanti": string[] | {nome:string,evidenze:string[]}[],
  "sintesi": string
}
Testo:
"""${text}"""`}
}

function promptAnalisiLetteraria(text: string) {
  return `Analizza il testo poetico dal punto di vista letterario. Rispondi in JSON con:
{
  "analisi_tematica_filosofica": {
    "temi_principali": [{ "tema": string, "spiegazione": string, "citazioni": string[] }],
    "temi_secondari": (string|{tema:string,commento?:string,citazioni?:string[]})[],
    "tesi_filosofica": string
  },
  "analisi_stilistica_narratologica": {
    "stile": string | { ritmo?: string, lessico?: string, sintassi?: string },
    "narratore": string | null,
    "tempo_narrativo": string | null,
    "dispositivi_retorici": (string|{nome:string,effetto?:string})[],
    "personaggi": [{ "nome": string, "arco"?: string, "motivazioni"?: string, "meccanismi_di_difesa"?: string[] }]
  },
  "contesto_storico_biografico": { "storico"?: string, "biografico"?: string },
  "sintesi_critica_conclusione": string | { "sintesi": string, "valutazione_finale"?: string }
}
Testo:
"""${text}"""`}
}

function promptProfiloPoetico(text: string) {
  return `In base a questo testo, produci un profilo poetico locale (solo da questa poesia). JSON con:
{
  "sintesi": string,
  "tratti_stilistici": string[],
  "influenze": string[]
}
Testo:
"""${text}"""`}
}

// ====== OPENAI CALLS ======
async function runOpenAI(text: string) {
  const [psico, lett, prof] = await Promise.all([
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'user', content: promptAnalisiPsicologica(text) }],
      response_format: { type: 'json_object' }
    }),
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'user', content: promptAnalisiLetteraria(text) }],
      response_format: { type: 'json_object' }
    }),
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'user', content: promptProfiloPoetico(text) }],
      response_format: { type: 'json_object' }
    })
  ])

  const analisi_psicologica = safeJsonParse(psico.choices[0]?.message?.content) ?? { sintesi: '' }
  const analisi_letteraria = safeJsonParse(lett.choices[0]?.message?.content) ?? {}
  const profilo_poetico = safeJsonParse(prof.choices[0]?.message?.content) ?? {}

  return { analisi_psicologica, analisi_letteraria, profilo_poetico }
}

// ====== HANDLER ======
export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }

  try {
    const body = safeJsonParse<any>(event.body) || {}

    // Supporto sia Webhook Supabase che chiamata manuale
    const isWebhook = !!(body?.type && body?.record)
    const rec = body?.record || {}

    const poemId: string | undefined = isWebhook ? rec.id : (body.poem_id || body.id)
    const authorId: string | undefined = isWebhook ? rec[POEMS_AUTHOR_COLUMN] : (body.author_id || body.user_id)
    const title: string | null | undefined =
      (isWebhook ? (rec.titolo ?? rec.title) : body.title) ?? null
    const content: string | null | undefined =
      (isWebhook ? (rec.testo ?? rec.text ?? rec.content) : (body.poemText ?? body.text ?? body.content)) ?? null

    if (!poemId || !authorId) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'poem_id/author_id mancanti' }) }
    }

    // 1) Upsert poesia di base (per essere sicuri che esista)
    await upsertPoem({ id: poemId, authorId, title, content })

    // 2) Se non ho il testo, provo a leggerlo dal DB
    let testo = content
    if (!testo) {
      const { data, error } = await supabase
        .from('poesie')
        .select('content, testo, text')
        .eq('id', poemId)
        .single()
      if (error) throw error
      testo = data?.content ?? data?.testo ?? data?.text ?? ''
    }

    // 3) Analisi con OpenAI (solo se ho testo)
    if (testo && testo.trim().length > 0) {
      const analyses = await runOpenAI(testo)
      await saveAnalyses(poemId, analyses)
    }

    // 4) Trigger aggiornamento diario se raggiunta soglia
    const count = await countPoemsByAuthor(authorId)
    if (count >= MIN_POEMS_TO_UPDATE && count % MIN_POEMS_TO_UPDATE === 0) {
      await triggerJournalUpdate(authorId, { id: poemId, title, content: testo || null })
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        poemId,
        authorId,
        analyses: !!testo,
        poemsCount: count,
        triggeredUpdate: (count >= MIN_POEMS_TO_UPDATE && count % MIN_POEMS_TO_UPDATE === 0)
      })
    }
  } catch (err: any) {
    console.error('forza-analisi error:', err)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err?.message || 'Errore generico' }) }
  }
}
