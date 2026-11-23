// Brauzer uchun bitta Supabase mijozi (faqat anon/publishable kalit; xavfsizlik RLS va RPC orqali).
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  console.error('[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY topilmadi (.env faylini tekshiring)')
}

export const supabase = createClient(url ?? '', key ?? '', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
