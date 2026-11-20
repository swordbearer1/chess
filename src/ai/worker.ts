import { searchBestMove, type SearchResult } from './search'
import type { Position } from '../chess'

interface WorkerCtx {
  postMessage(message: unknown): void
  onmessage: ((ev: MessageEvent) => void) | null
}

interface SearchRequest {
  gameId: number
  position: Position
  maxDepth: number
  timeBudgetMs: number
}

interface SearchResponse {
  gameId: number
  result?: SearchResult
  error?: string
}

const ctx = self as unknown as WorkerCtx

ctx.onmessage = (event: MessageEvent) => {
  const { gameId, position, maxDepth, timeBudgetMs } = event.data as SearchRequest
  try {
    const result = searchBestMove(position, { maxDepth, timeBudgetMs })
    const response: SearchResponse = { gameId, result }
    ctx.postMessage(response)
  } catch (err) {
    const response: SearchResponse = {
      gameId,
      error: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(response)
  }
}
