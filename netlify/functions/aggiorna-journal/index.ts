import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'

/**
 * ==========================
 *   ENV & CONFIG
 * ==========================
 */
const FORZA_ANALISI_URL = process.env.FORZA_ANALISI_URL!
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const AUTHOR_COL_ENV = process.env.POEMS_AUTHOR_COLUMN || 'user_id'
const MIN_POEMS = Number(process.env.MIN_POEMS_TO_UPDATE || 3)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')

/**
 * ==========================
 *   CLIENT
 * ==========================
 */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/**
 * ==========================
 *   CORS & UTILS
 * ==========================
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

function errToString(e: any) {
  try { if (e?.message) return e.message; return JSON.stringify(e) } catch { return String(e) }
}
function safeJson<T = any>(v: any): T | null {
  if (!v) return null
  if (typeof v === 'object') return v as T
  try { return JSON.parse(String(v)) } catch { return null }
}
function buildPublicPageUrl(authorId: string) {
  if (!PUBLIC_BASE_URL) return ''
  return `${PUBLIC_BASE_URL}/autore/${authorId}`
}
async function maybeGenerateQrDataUrl(url: string): Promise<string | null> {
  if (!url) return null
  try { return await QRCode.toDataURL(url) } catch { return null }
}
function normalizePoemRecord(p: any) {
  const title = p.titolo ?? p.title ?? null
  const text  = p.content ?? null
  return { title: title ?? null, text: text ?? null }
}

/**
 * ==========================
 *   HANDLER
 * ==========================
 */
export const handler: Handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }

  const reqId =
    event.headers?.['x-nf-request-id'] ||
    event.headers?.['x-request-id'] ||
    (context as any)?.awsRequestId ||
    Math.random().toString(36).slice(2)

  const log = (msg: string, extra?: any) => {
    if (extra) {
      try {
        const copy = JSON.parse(JSON.stringify(extra, (_, v) => (
          typeof v === 'string' && v.length > 800 ? v.slice(0, 800) + '…[trim]' : v
        )))
        console.log(`[aggiorna-journal][${reqId}] ${msg}`, copy)
      } catch { console.log(`[aggiorna-journal][${reqId}] ${msg}`, extra) }
    } else {
      console.log(`[aggiorna-journal][${reqId}] ${msg}`)
    }
  }
  const logErr = (msg: string, err?: any) => console.error(`[aggiorna-journal][${reqId}] ${msg}`, err)

  try {
    log('invoked')

    const body = safeJson<any>(event.body) || {}
    const debug = !!body.debug || event.queryStringParameters?.debug === '1'
    const dryRun = !!body.dry_run

    const isWebhook = !!(body?.type && body?.record)
    const rec = isWebhook ? body.record : body

    const authorId: string | undefined =
      rec[AUTHOR_COL_ENV] || rec.author_id || rec.user_id || rec.profile_id

    if (!authorId) {
      logErr('author_id mancante', { recKeys: Object.keys(rec || {}) })
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'author_id mancante', reqId }) }
    }

    // -------- 1) Count poesie
    async function tryCount(col: string) {
      const { data: rows, count, error } = await supabase
        .from('poesie')
        .select('id', { count: 'exact' })
        .eq(col as any, authorId)
        .limit(1)
      return { col, count: count ?? 0, sample: rows?.[0] || null, error: error && { message: error.message } }
    }
    let activeCol = AUTHOR_COL_ENV
    let r = await tryCount(AUTHOR_COL_ENV)
    if (r.error) { r = await tryCount('profile_id'); if (!r.error) activeCol = 'profile_id' }
    if (r.error) { r = await tryCount('user_id');    if (!r.error) activeCol = 'user_id' }
    if (r.error) throw new Error(`Supabase count error: ${JSON.stringify(r)}`)

    const poemsCount = r.count
    if ((poemsCount ?? 0) < MIN_POEMS) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: true, triggered: false, reason: `Soglia non raggiunta (${poemsCount}/${MIN_POEMS})`, authorId })
      }
    }

    // -------- 2) Carica poesie
    const { data: poems, error: poemsErr } = await supabase
      .from('poesie')
      .select('id, titolo, title, content')
      .eq(activeCol as any, authorId)
      .order('id', { ascending: true })
    if (poemsErr) throw poemsErr
    if (!poems?.length) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Nessuna poesia', authorId }) }

    // -------- 3) Precedente QR
    let existingQr: string | null = null
    let hasQrColumn = true
    try {
      const { data: prof, error: profErr } = await supabase
        .from('profiles')
        .select('qr_code_url')
        .eq('id', authorId)
        .single()
      if (!profErr && prof) {
        existingQr = prof.qr_code_url ?? null
      } else if (profErr?.message?.includes('qr_code_url')) {
        hasQrColumn = false
      }
    } catch { hasQrColumn = false }

    // -------- 4) Dry-run
    if (dryRun) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: true, dryRun: true, authorId, poemsCount, activeCol, hadExistingQr: !!existingQr })
      }
    }

    // -------- 5) Chiamata a FORZA ANALISI
    let diarioAggiornato: any = null
    try {
      const targetUrl = FORZA_ANALISI_URL || `${event.headers['x-forwarded-proto'] || 'https'}://${event.headers.host}/.netlify/functions/forza-analisi`
      const faResp = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author_id: authorId })
      })
      if (!faResp.ok) throw new Error(`forza-analisi error ${faResp.status}`)
      const faJson = await faResp.json()
      diarioAggiornato = faJson?.diario || faJson || null
    } catch (e) {
      logErr('Errore chiamata forza-analisi', e)
    }

    if (!diarioAggiornato) {
      diarioAggiornato = {
        descrizione_autore: 'Profilo in aggiornamento.',
        profilo_poetico: {
          voce: '', stile: '', tono: '',
          temi_ricorrenti: [], immagini_metafore_tipiche: [], influenze_letterarie: []
        },
        ultimo_aggiornamento_iso: new Date().toISOString()
      }
    }

    // -------- 6) Public URL + QR
    const publicUrl = buildPublicPageUrl(authorId)
    let qrToSave: string | undefined
    if (hasQrColumn && publicUrl && !existingQr) {
      const qr = await maybeGenerateQrDataUrl(publicUrl)
      if (qr) qrToSave = qr
    }

    // -------- 7) UPDATE stato corrente in profiles
    const updatePayload: any = {
      poetic_journal: diarioAggiornato,
      last_updated: new Date().toISOString()
    }
    if (qrToSave) updatePayload.qr_code_url = qrToSave

    const { error: updErr } = await supabase
      .from('profiles')
      .update(updatePayload)
      .eq('id', authorId)
    if (updErr) throw updErr

    // -------- 8) INSERT storico
    const { error: histErr } = await supabase
      .from('diario_autore_history')
      .insert({
        author_id: authorId,
        contenuto: diarioAggiornato,
        source: 'netlify/aggiorna-journal'
      })
    if (histErr) logErr('history insert error', histErr)

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        triggered: true,
        authorId,
        poemsCount,
        diario: diarioAggiornato,
        qrGenerated: !!qrToSave,
        publicUrl: publicUrl || null
      })
    }
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: errToString(err), where: 'aggiorna-journal' })
    }
  }
}

export default handler
