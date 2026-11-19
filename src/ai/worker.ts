import { searchBestMove } from './search'
import type { Move, Position } from '../chess'

interface WorkerCtx {
  postMessage(message: unknown): void
  onmessage: ((ev: MessageEvent) => void) | null
}

interface SearchRequest {
  gameId: number
  position: Position
  depth: number
}

interface SearchResponse {
  gameId: number
  move: Move | null
  error?: string
}

const ctx = self as unknown as WorkerCtx

ctx.onmessage = (event: MessageEvent) => {
  const { gameId, position, depth } = event.data as SearchRequest
  try {
    const move = searchBestMove(position, depth)
    const response: SearchResponse = { gameId, move }
    ctx.postMessage(response)
  } catch (err) {
    const response: SearchResponse = {
      gameId,
      move: null,
      error: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(response)
  }
}
