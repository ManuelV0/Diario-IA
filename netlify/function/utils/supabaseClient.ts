// /netlify/functions/utils/supabaseClient.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ───────────────────────────
// Config base Supabase
// ───────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

/**
 * Nome della colonna che collega una poesia al suo autore.
 * Nel tuo schema attuale è "user_id". Imposta nelle ENV:
 *   POEMS_AUTHOR_COLUMN=user_id
 * Se in futuro userai "author_id", ti basta cambiare la ENV.
 */
export const POEMS_AUTHOR_COLUMN = process.env.POEMS_AUTHOR_COLUMN || 'author_id';

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ───────────────────────────
// Tipi minimi
// ───────────────────────────
export type ProfilesRow = {
  id: string;
  username?: string | null;
  full_name?: string | null;
  diario_autore?: any | null;
  diario_updated_at?: string | null; // ISO string
};

export type PoesieRow = {
  id: string;
  titolo?: string | null;
  testo?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  analisi_psicologica?: any | null;
  analisi_letteraria?: any | null;
  profilo_poetico?: any | null;
};

// ───────────────────────────
// Helpers PROFILO
// ───────────────────────────
export async function getProfileBasic(authorId: string) {
  return supabase
    .from('profiles')
    .select('id, username, full_name, diario_autore, diario_updated_at')
    .eq('id', authorId)
    .single<ProfilesRow>();
}

export async function updateProfileDiarySingleState(authorId: string, diario: any, whenIso: string) {
  return supabase
    .from('profiles')
    .update({ diario_autore: diario, diario_updated_at: whenIso })
    .eq('id', authorId);
}

/** Batch: mappa { profile_id: diario_updated_at } per filtrare chi è già aggiornato */
export async function getProfilesDiaryUpdatedAt(authorIds: string[]): Promise<Record<string, string | null>> {
  if (!authorIds.length) return {};
  const { data, error } = await supabase
    .from('profiles')
    .select('id, diario_updated_at')
    .in('id', authorIds);
  if (error || !data) return {};
  const map: Record<string, string | null> = {};
  for (const row of data as ProfilesRow[]) map[row.id] = row.diario_updated_at ?? null;
  return map;
}

// ───────────────────────────
// Helpers DIARIO STORICO (opzionale)
// ───────────────────────────
export async function insertDiaryHistory(authorId: string, diario: any, whenIso: string, source = 'aggiorna-journal') {
  return supabase
    .from('diario_autore_history')
    .insert({ author_id: authorId, contenuto: diario, source, created_at: whenIso });
}

// ───────────────────────────
// Helpers POESIE
// ───────────────────────────
export async function getPoemById(poemId: string) {
  return supabase
    .from('poesie')
    .select('id, titolo, testo, created_at, updated_at, analisi_psicologica, analisi_letteraria, profilo_poetico')
    .eq('id', poemId)
    .single<PoesieRow>();
}

export async function getPoemsByAuthor(authorId: string, { all = true, limit = 1 } = {}) {
  const base = supabase
    .from('poesie')
    .select('id, titolo, testo, created_at')
    .eq(POEMS_AUTHOR_COLUMN as any, authorId)
    .order('created_at', { ascending: false });

  return all ? base : base.limit(limit);
}

export async function updatePoemAnalyses(poemId: string, data: Partial<PoesieRow>) {
  return supabase
    .from('poesie')
    .update({
      analisi_psicologica: data.analisi_psicologica ?? null,
      analisi_letteraria: data.analisi_letteraria ?? null,
      profilo_poetico: data.profilo_poetico ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', poemId);
}

export async function countPoemsByAuthor(authorId: string) {
  const { count, error } = await supabase
    .from('poesie')
    .select('id', { count: 'exact', head: true })
    .eq(POEMS_AUTHOR_COLUMN as any, authorId);
  return { count: count ?? 0, error };
}

/** Upsert minimale per garantire che il conteggio salga durante i test/E2E */
export async function upsertPoemMinimal(
  poemId: string,
  authorId: string,
  { title, text }: { title?: string | null; text?: string | null }
) {
  const data: any = {
    id: poemId,
    titolo: title ?? null,
    testo: text ?? null,
    updated_at: new Date().toISOString(),
  };
  data[POEMS_AUTHOR_COLUMN] = authorId; // chiave dinamica (user_id o author_id)
  return supabase.from('poesie').upsert(data, { onConflict: 'id' });
}

// ───────────────────────────
// Helpers BATCH (per rebuild-journal)
// ───────────────────────────
/** Ritorna gli author_id/user_id che hanno almeno `min` poesie */
export async function getAuthorsWithAtLeastNPoems(min = 3): Promise<{ authors: string[]; error: any | null }> {
  const { data, error } = await supabase
    .from('poesie')
    .select(`${POEMS_AUTHOR_COLUMN}, count:id`)
    .group(POEMS_AUTHOR_COLUMN);

  if (error) return { authors: [], error };

  const rows = (data as any[]) ?? [];
  const authors = rows
    .filter((r) => Number(r.count) >= min)
    .map((r) => String(r[POEMS_AUTHOR_COLUMN]))
    .filter(Boolean);

  return { authors, error: null };
}
