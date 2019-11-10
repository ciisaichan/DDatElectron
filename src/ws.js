/* eslint-disable no-unexpected-multiline */
/* eslint-disable func-call-spacing */
const { version: VERSION } = require('../package.json')
const WebSocket = require('ws')
const got = require('got')

console.log(`
${Array(80).fill('D').join('')}
Thank you for participating DD@Home,
Please read README.md for more information.
${Array(80).fill('D').join('')}
`)

const base = process.env.development ? 'ws://0.0.0.0:9013' : 'wss://cluster.vtbs.moe'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const parse = string => {
  if (string === 'wait') {
    return { empty: true }
  }
  try {
    return JSON.parse(string)
  } catch (_) {
    return undefined
  }
}

module.exports = async ({ state, db }) => {
  const PARALLEL = 32
  let INTERVAL = await db.get('INTERVAL').catch(() => 840)
  let nickname = await db.get('nickname').catch(() => undefined)
  let ws = {}
  const queryTable = new Map()

  const secureSend = data => {
    if (ws.readyState === 1) {
      ws.send(data)
      return true
    }
  }

  const ask = query => new Promise((resolve, reject) => {
    const key = String(Math.random())
    queryTable.set(key, resolve)
    secureSend(JSON.stringify({ key, query }))
    setTimeout(() => {
      if (queryTable.has(key)) {
        reject(new Error('timeout'))
      }
    }, 1000 * 5)
  })

  const connect = () => new Promise(resolve => {
    const url = new URL(base)
    url.searchParams.set('runtime', `electronv${process.versions.electron}`)
    url.searchParams.set('version', VERSION)
    url.searchParams.set('platform', process.platform)

    if (nickname) {
      url.searchParams.set('name', nickname)
    }

    state.log = `using: ${url}`
    console.log(`using: ${url}`)
    state.nickname = nickname
    state.url = url.href
    state.INTERVAL = INTERVAL

    ws = new WebSocket(url)

    const pending = []

    ws.on('message', async message => {
      const { key, data, empty } = parse(message)
      if (data) {
        const { type } = data
        if (type === 'http') {
          const { url } = data
          const resolve = pending.shift()
          if (resolve) {
            console.log('job received', url)
            resolve({ key, url })
          }
        } else if (type === 'query') {
          if (queryTable.has(key)) {
            const { result } = data
            queryTable.get(key)(result)
            queryTable.delete(key)
          }
        }
      } else if (empty) {
        const resolve = pending.shift()
        if (resolve) {
          resolve({ empty })
        }
      }
    })

    const processer = async () => {
      await wait(INTERVAL * PARALLEL * Math.random())
      while (true) {
        const now = Date.now()
        const { key, url, empty } = await new Promise(resolve => {
          pending.push(resolve)
          secureSend('DDDhttp')
        })
        if (!empty) {
          const time = Date.now()
          const { body } = await got(url).catch(e => ({ body: JSON.stringify({ code: e.statusCode }) }))
          const result = secureSend(JSON.stringify({
            key,
            data: body
          }))
          if (result) {
            state.delay = Math.round(process.uptime() * 1000 / state.completeNumNow)
            console.log(`job complete ${((Date.now() - time) / 1000).toFixed(2)}s`, state.delay, INTERVAL * PARALLEL - Date.now() + now)
            state.log = url
            state.completeNum++
            state.completeNumNow++
          }
        }
        await wait(INTERVAL * PARALLEL - Date.now() + now)
      }
    }

    ws.on('open', () => {
      state.log = 'DD@Home connected'
      console.log('DD@Home connected')
      Array(PARALLEL).fill().map(processer)
    })

    ws.on('error', e => {
      state.log = `error: ${e.message}`
      console.error(`error: ${e.message}`)
    })

    ws.on('close', (n, reason) => {
      state.log = `closed, ${n}, ${reason}`
      queryTable.clear()
      console.log('closed', n, reason)
      if (reason === 'User Reload') {
        resolve()
      } else {
        setTimeout(resolve, 1000)
      }
    })
  })

  ;

  (f => w => f(f, w()))
  (f => w => f(f, w()))
  (async () => {
    while (true) {
      await connect()
    }
  })
  (async () => {
    while (true) {
      const pause = wait(233)
      if (ws.readyState === 1) {
        state.pending = await ask('pending').catch(() => state.pending)
        state.pulls = await ask('pulls').catch(() => state.pulls)
      }
      await pause
    }
  })
  (async () => {
    while (true) {
      if (ws.readyState === 1) {
        const pause = wait(1000 * 5)
        state.homes = await ask('homes').catch(() => state.homes)
        state.online = await ask('online').catch(() => state.online)
        await pause
      } else {
        await wait(500)
      }
    }
  })

  const getWs = () => ws
  const updateInterval = interval => {
    db.put('INTERVAL', interval)
    INTERVAL = interval
  }
  const updateNickname = name => {
    db.put('nickname', name)
    nickname = name
  }

  return { getWs, updateInterval, updateNickname }
}
