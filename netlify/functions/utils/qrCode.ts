
// Utils QR — Netlify Functions
// Dipendenza: npm install qrcode

// Nota compatibilità: usare namespace import per funzionare sia in CJS che ESM
import * as QRCode from 'qrcode';

/**
 * Genera un QR come DataURL PNG (base64).
 * Usalo quando vuoi incorporare l'immagine direttamente nella UI.
 */
export async function buildQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    margin: 1,
    errorCorrectionLevel: 'M',
    // width: 256, // opzionale; lasciare al default se non serve
  });
}

/**
 * (Opzionale) Genera un buffer PNG (Uint8Array) utile per upload su storage.
 */
export async function buildQrPngBuffer(text: string): Promise<Uint8Array> {
  return QRCode.toBuffer(text, {
    margin: 1,
    errorCorrectionLevel: 'M',
    // width: 512, // opzionale
    type: 'png',
  });
}
