/**
 * 联机协议冒烟测试：以两个 WebSocket 客户端走完 创建/加入/走子/校验/断线/重连/重开/离开 全流程。
 * 运行前需先启动服务端：npm run server
 */
import WebSocket from 'ws'
import { applyMove, generateLegalMoves, initialPosition } from '../src/chess'
import type { Color, Move } from '../src/chess'

const URL = process.env.WS_URL ?? 'ws://localhost:8787'

interface Msg {
  type: string
  [key: string]: unknown
}

class TestClient {
  ws: WebSocket
  inbox: Msg[] = []
  waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = []
  seat: Color | null = null
  token = ''
  code = ''

  constructor() {
    this.ws = new WebSocket(URL)
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Msg
      console.log(`[recv] ${msg.type}${msg.version !== undefined ? ` v${msg.version}` : ''}${msg.message ? ` (${msg.message})` : ''}`)
      // 先派发给等待者（先进先出），否则进收件箱
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.waiters[i].pred(msg)) {
          const [w] = this.waiters.splice(i, 1)
          w.resolve(msg)
          return
        }
      }
      this.inbox.push(msg)
    })
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve())
      this.ws.on('error', reject)
    })
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload))
  }

  /** 消费式等待：匹配到的消息从收件箱移除，不会污染后续等待 */
  wait(pred: (m: Msg) => boolean, timeoutMs = 5000): Promise<Msg> {
    const idx = this.inbox.findIndex(pred)
    if (idx >= 0) {
      const [msg] = this.inbox.splice(idx, 1)
      return Promise.resolve(msg)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待消息超时: ${pred.toString()}`)), timeoutMs)
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  close(): void {
    this.ws.close()
  }
}

const legalMoveOf = (sideToMove: Color): Move => generateLegalMoves({ board: initialPosition().board, sideToMove })[0]
const results: string[] = []
const step = (name: string): void => {
  console.log(`[step] ${name}`)
}
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) throw new Error(`断言失败: ${name}`)
}

async function main(): Promise<void> {
  const a = new TestClient()
  const b = new TestClient()
  await a.open()
  await b.open()

  // 1. 创建房间（房主执红）
  a.send({ type: 'create', color: 'red' })
  const created = await a.wait((m) => m.type === 'created')
  a.code = String(created.code)
  a.token = String(created.token)
  a.seat = 'red'
  check('创建房间返回房间码与凭证', a.code.length === 6 && a.token.length === 32, `code=${a.code}`)

  // 2. 加入房间（自动分黑）
  b.send({ type: 'join', code: a.code })
  const joined = await b.wait((m) => m.type === 'joined')
  b.token = String(joined.token)
  b.seat = String(joined.color) as Color
  check('加入房间分配黑方', b.seat === 'black')
  const stateB = await b.wait((m) => m.type === 'state')
  check('加入后收到权威局面', (stateB.position as { board: unknown }).board !== undefined && stateB.version === 0)

  // 3. 非轮次方走子被拒
  const redMove = legalMoveOf('red')
  b.send({ type: 'move', move: redMove, moveId: 'nope-1' })
  const err1 = await b.wait((m) => m.type === 'error')
  check('黑方抢走被拒绝', String(err1.message).includes('轮到你'))

  // 4. 房主走子 → 双方收到 moved，版本递增
  a.send({ type: 'move', move: redMove, moveId: 'm-1' })
  const movedA = await a.wait((m) => m.type === 'moved')
  const movedB = await b.wait((m) => m.type === 'moved')
  check('走子广播给双方且版本为 1', movedA.version === 1 && movedB.version === 1)
  check('广播携带走子方', movedA.by === 'red')

  // 5. 重复消息去重（同一 moveId 重发不产生新版本）
  a.send({ type: 'move', move: redMove, moveId: 'm-1' })
  const dup = await a.wait((m) => m.type === 'moved')
  check('重复 moveId 幂等（版本不变）', dup.version === 1)

  // 6. 非法走法被拒
  b.send({ type: 'move', move: { from: { row: 0, col: 4 }, to: { row: 5, col: 5 } }, moveId: 'bad-1' })
  const err2 = await b.wait((m) => m.type === 'error')
  check('非法走法被拒绝', String(err2.message).includes('非法'))

  // 7. 黑方合法走子 → 版本 2
  const posAfterRed = applyMove(initialPosition(), redMove)
  const blackMove = generateLegalMoves(posAfterRed)[0]
  b.send({ type: 'move', move: blackMove, moveId: 'm-2' })
  const moved2 = await a.wait((m) => m.type === 'moved' && m.version === 2)
  check('黑方走子版本为 2', moved2.by === 'black')

  // 8. 断线提示
  a.close()
  const peers = await b.wait((m) => m.type === 'peers' && m.peers !== undefined && (m.peers as { redConnected: boolean }).redConnected === false)
  check('对手断线通知', Boolean(peers))

  // 9. 重连恢复座位并同步局面
  const a2 = new TestClient()
  await a2.open()
  a2.send({ type: 'join', code: a.code, token: a.token })
  const resumed = await a2.wait((m) => m.type === 'joined')
  check('token 重连恢复座位', resumed.resumed === true)
  const sync = await a2.wait((m) => m.type === 'state')
  check('重连同步到版本 2', sync.version === 2)
  const peers2 = await b.wait((m) => m.type === 'peers' && (m.peers as { redConnected: boolean }).redConnected === true)
  check('对手上线通知', Boolean(peers2))

  // 10. 房主重开 → 双方收到新局（版本 3）
  a2.send({ type: 'restart' })
  const restartedA = await a2.wait((m) => m.type === 'restarted')
  const restartedB = await b.wait((m) => m.type === 'restarted')
  check('重开广播且版本为 3', restartedA.version === 3 && restartedB.version === 3)

  // 11. 离开通知
  b.send({ type: 'leave' })
  const left = await a2.wait((m) => m.type === 'opponent-left')
  check('对手离开通知', left.color === 'black')

  a2.close()
  b.close()

  console.log(results.join('\n'))
  console.log(`\n共 ${results.length} 项，全部通过`)
  process.exit(0)
}

// 全局看门狗：任何一步卡住也能退出并留下日志
setTimeout(() => {
  console.error('[watchdog] 20 秒未完成，强制退出')
  console.error(results.join('\n'))
  process.exit(3)
}, 20_000)

main().catch((e) => {
  console.error(results.join('\n'))
  console.error(`\n冒烟测试失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
