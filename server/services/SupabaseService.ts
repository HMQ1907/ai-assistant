import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

export class SupabaseService {
  constructor(
    private readonly options: {
      url: string
      serviceRoleKey: string
    }
  ) {}

  getClient(): SupabaseClient {
    if (!this.options.url || !this.options.serviceRoleKey) {
      throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
    }

    client ??= createClient(this.options.url, this.options.serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })

    return client
  }
}
