// netlify/functions/forza-analisi/index.ts
import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import QRCode from 'qrcode'

// ===== ENV & CONFIG =====
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const AUTHOR_COL = process.env.POEMS_AUTHOR_COLUMN || 'user_id'
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

// ===== CLIENTS =====
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// ===== UTILS =====
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}
const isUuid = (s?: string) =>
  typeof s === 'string' &&
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(s)
const errToString = (e: any) => (e && e.message) ? e.message : String(e)
const newReqId = () => Math.random().toString(36).slice(2, 9)
const log = (...a: any[]) => console.log('[forza-analisi]', ...a)
const logErr = (...a: any[]) => console.error('[forza-analisi]', ...a)
const pickAuthorId = (body: any): string | null =>
  body?.author_id || body?.user_id || body?.record?.user_id || null

type Poem = { title: string; content: string }
const normalizePoem = (p: any): Poem => ({
  title: (p?.title ?? p?.titolo ?? '') || '',
  content: (p?.content ?? '') || ''
})

// ===== SUPABASE OPS =====
async function fetchAllPoems(authorId: string): Promise<Poem[]> {
  const { data, error } = await supabase
    .from('poesie')
    .select('id,title,titolo,content,created_at')
    .eq(AUTHOR_COL, authorId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Supabase select poems error: ${JSON.stringify(error)}`)
  return (data || []).map(normalizePoem)
}

async function fetchProfile(authorId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, poetic_journal, qr_code_url, public_page_url, last_updated')
    .eq('id', authorId)
    .single()
  if (error) throw new Error(`Supabase select profile error: ${JSON.stringify(error)}`)
  return data
}

async function updateProfileJournal(authorId: string, journal: any, qrDataUrl?: string | null) {
  const patch: any = {
    poetic_journal: journal,
    last_updated: new Date().toISOString()
  }
  if (qrDataUrl) patch.qr_code_url = qrDataUrl

  const { error } = await supabase.from('profiles').update(patch).eq('id', authorId)
  if (error) throw new Error(`Supabase update profile error: ${JSON.stringify(error)}`)
}

async function insertHistory(authorId: string, journal: any) {
  const { error } = await supabase
    .from('diario_autore_history')
    .insert({
      author_id: authorId,
      contenuto: journal,
      source: 'netlify/forza-analisi'
    })
  if (error) logErr('history insert error', error)
}

// ===== JOURNAL / OPENAI =====
function buildCorpus(poems: Poem[]) {
  return poems
    .map((p, i) => {
      const t = p.title?.trim() ? `Titolo: ${p.title}\n` : ''
      const c = p.content?.trim() || ''
      return `--- POESIA #${i + 1} ---\n${t}${c}`
    })
    .join('\n\n')
}

function buildPrompt(prev: any | null, corpus: string) {
  const prevBlock = prev
    ? `Diario precedente (JSON). Aggiorna senza perdere informazioni utili:\n${JSON.stringify(prev).slice(0, 6000)}`
    : 'Non esiste ancora un diario: creane uno partendo dalle poesie.'
  return [
    `Sei un editor letterario. Ti fornisco un corpus di poesie di un autore. Crea o aggiorna un "poetic_journal" in JSON con questa struttura:`,
    `{
  "descrizione_autore": string,
  "profilo_poetico": {
    "temi_ricorrenti": string[],
    "stile": string,
    "evoluzione": string
  },
  "ultime_opere_rilevanti": [{"id": string, "titolo": string}]
}`,
    `Linee guida: tono conciso; niente esagerazioni; niente dati personali non presenti nei testi.`,
    `CORPUS:\n${corpus}`,
    prevBlock
  ].join('\n\n')
}

async function callOpenAIForJournal(prompt: string) {
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'Sei un assistente che produce JSON valido.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4
  })
  const text = completion.choices[0]?.message?.content?.trim() || ''
  try { return JSON.parse(text) } catch { return { descrizione_autore: text } }
}

async function maybeGenerateQr(authorId: string, profile: any): Promise<string | null> {
  if (!PUBLIC_BASE_URL) return null
  if (profile?.qr_code_url) return null
  const publicUrl = profile?.public_page_url || `${PUBLIC_BASE_URL}/autore/${authorId}`
  try { return await QRCode.toDataURL(publicUrl) } catch { return null }
}

// ===== HANDLER =====
export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' }

  const reqId = newReqId()
  try {
    const body = event.body ? JSON.parse(event.body) : {}
    const debug = !!(body?.debug || event.queryStringParameters?.debug)

    const authorId = pickAuthorId(body)
    if (!isUuid(authorId || '')) {
      const msg = `Invalid author_id (expected UUID): ${authorId}`
      if (debug) log('reqId=', reqId, msg)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: msg, reqId }) }
    }

    // carico poesie + profilo
    const poems = await fetchAllPoems(authorId!)
    const corpus = buildCorpus(poems)
    const profile = await fetchProfile(authorId!)
    const prevJournal = profile?.poetic_journal || null

    // OpenAI
    let newJournal: any
    try {
      const prompt = buildPrompt(prevJournal, corpus)
      newJournal = await callOpenAIForJournal(prompt)
    } catch (e) {
      logErr('OpenAI error', errToString(e))
      newJournal = {
        descrizione_autore: 'Profilo in aggiornamento: riprova più tardi.',
        profilo_poetico: { temi_ricorrenti: [], stile: '', evoluzione: '' },
        ultime_opere_rilevanti: []
      }
    }

    // QR
    const qrDataUrl = await maybeGenerateQr(authorId!, profile)

    // update + storico
    await updateProfileJournal(authorId!, newJournal, qrDataUrl)
    await insertHistory(authorId!, newJournal)

    const res = {
      forced: true,
      updated: true,
      authorId,
      poemsCount: poems.length,
      wroteFields: ['poetic_journal', 'last_updated', 'history'].concat(qrDataUrl ? ['qr_code_url'] : []),
      reqId
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(res) }

  } catch (err: any) {
    logErr('FATAL', err)
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: errToString(err), where: 'forza-analisi' })
    }
  }
}

export default handler
