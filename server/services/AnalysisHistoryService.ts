import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AiTradeRecommendation } from '../../types/ai'
import type { AnalysisHistoryRecord, AnalysisPayload, ResultStatus } from '../../types/trading'

let db: DatabaseSync | null = null

export class AnalysisHistoryService {
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    const resolved = resolve(databasePath)
    mkdirSync(dirname(resolved), { recursive: true })
    db ??= new DatabaseSync(resolved)
    this.database = db
    this.migrate()
  }

  create(input: { requestPayload: AnalysisPayload; aiResponseRaw: string; parsedResult: AiTradeRecommendation }): AnalysisHistoryRecord {
    const statement = this.database.prepare(`
      INSERT INTO analysis_history (
        created_at, request_payload, ai_response_raw, parsed_result, decision, symbol, direction,
        confidence, entry, stop_loss, take_profit, result_status, user_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const createdAt = new Date().toISOString()
    const result = statement.run(
      createdAt,
      JSON.stringify(input.requestPayload),
      input.aiResponseRaw,
      JSON.stringify(input.parsedResult),
      input.parsedResult.decision,
      input.parsedResult.symbol,
      input.parsedResult.direction,
      input.parsedResult.confidence,
      JSON.stringify(input.parsedResult.entry_zone),
      input.parsedResult.stop_loss,
      input.parsedResult.take_profit,
      'PENDING',
      ''
    )
    return this.get(Number(result.lastInsertRowid))
  }

  list(): AnalysisHistoryRecord[] {
    const rows = this.database.prepare('SELECT * FROM analysis_history ORDER BY id DESC LIMIT 100').all()
    return rows.map(toRecord)
  }

  get(id: number): AnalysisHistoryRecord {
    const row = this.database.prepare('SELECT * FROM analysis_history WHERE id = ?').get(id)
    if (!row) throw new Error(`Analysis history record not found: ${id}`)
    return toRecord(row)
  }

  update(id: number, input: { result_status?: ResultStatus | undefined; user_note?: string | undefined }): AnalysisHistoryRecord {
    const existing = this.get(id)
    this.database
      .prepare('UPDATE analysis_history SET result_status = ?, user_note = ? WHERE id = ?')
      .run(input.result_status ?? existing.result_status, input.user_note ?? existing.user_note, id)
    return this.get(id)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS analysis_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        ai_response_raw TEXT NOT NULL,
        parsed_result TEXT NOT NULL,
        decision TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        entry TEXT NOT NULL,
        stop_loss REAL NOT NULL,
        take_profit REAL NOT NULL,
        result_status TEXT NOT NULL,
        user_note TEXT NOT NULL
      )
    `)
  }
}

function toRecord(row: unknown): AnalysisHistoryRecord {
  const value = row as Record<string, unknown>
  return {
    id: Number(value.id),
    created_at: String(value.created_at),
    request_payload: String(value.request_payload),
    ai_response_raw: String(value.ai_response_raw),
    parsed_result: String(value.parsed_result),
    decision: value.decision === 'TRADE' ? 'TRADE' : 'NO_TRADE',
    symbol: String(value.symbol),
    direction: value.direction === 'BUY' || value.direction === 'SELL' ? value.direction : 'NONE',
    confidence: Number(value.confidence),
    entry: String(value.entry),
    stop_loss: Number(value.stop_loss),
    take_profit: Number(value.take_profit),
    result_status: normalizeStatus(String(value.result_status)),
    user_note: String(value.user_note)
  }
}

function normalizeStatus(value: string): ResultStatus {
  if (value === 'WIN' || value === 'LOSS' || value === 'SKIPPED') return value
  return 'PENDING'
}
