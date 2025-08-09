import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import QRCode from 'qrcode'

export default function PublicAuthorPage() {
  const { id } = useParams<{ id: string }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diario, setDiario] = useState<any>(null)
  const [qr, setQr] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('diario_autore')
          .eq('id', id)
          .single()
        if (error) throw error
        let parsed = data?.diario_autore
        if (typeof parsed === 'string') {
          try { parsed = JSON.parse(parsed) } catch {}
        }
        setDiario(parsed)
        setQr(await QRCode.toDataURL(window.location.href))
      } catch (e: any) {
        setError(e.message || 'Errore caricamento diario')
      } finally {
        setLoading(false)
      }
    })()
  }, [id])

  if (loading) return <div className="p-4">Caricamento…</div>
  if (error) return <div className="p-4 text-red-600">{error}</div>
  if (!diario) return <div className="p-4">Nessun diario trovato.</div>

  return (
    <div className="max-w-3xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Diario dell’autore</h1>
      {diario.descrizione_autore && <p>{diario.descrizione_autore}</p>}
      {/* altri campi come temi_ricorrenti, profilo_poetico, ecc */}
      {qr && <img src={qr} alt="QR" className="mt-4 w-32" />}
    </div>
  )
}
