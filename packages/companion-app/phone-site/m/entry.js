(() => {
  const root = document.documentElement
  const $ = (id) => document.getElementById(id)
  const HOST_ID = /^[a-z0-9]{6,32}$/
  const MACS_KEY = 'satura-remote-desktops'
  const HOME = '/h/all/'
  const RESUME_MS = 1500
  const CODE = /^[a-z0-9]{6,32}:[0-9a-f]{16,64}(:[0-9a-f]{32})?$/
  const DECODER = '/m/vendor/jsqr-1.4.0.min.js'
  const CONFIG = '/phone-config.json'
  const CONFIG_MS = 8000
  const DB_NAME = 'satura-account'
  const DB_STORE = 'ticket'
  const TICKET_KEY = 'ticket'
  const TICKET = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
  const PAIR_STASH_KEY = 'satura-remote-pair-stash'
  const PAIR_STASH_MS = 10 * 60_000
  const CLAIM_KEY = 'claim'
  const CLAIM_MS = 10 * 60_000
  const CLAIM_POLL_MS = 3000
  const SIGNED_IN_KEY = 'satura-remote-signed-in-at'
  const TEXT = {
    colon: "That code doesn't look right. It should have a colon in the middle.",
    crypto: "This page isn't on a secure (HTTPS) connection, so it can't encrypt the link to your desktop.",
    shape: "That code doesn't look right. Check it against the code on your desktop.",
    foreign: "That QR code isn't from Satura.",
    insecure: "This browser can't use the camera on this page. Type the code instead.",
    blocked: 'The browser blocked the camera for this site. Allow it in the site settings, or type the code instead.',
    none: 'This device has no camera Satura can use.',
    failed: "The camera didn't start. Type the code instead.",
    decoder: "The code reader didn't load. Check the connection and try again."
  }
  const LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>'
  const ICON = {
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14.5V3.5M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18" cy="12" r="1.9"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5.5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="18.5" r="1.9"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 7h15M4.5 12h15M4.5 17h15"/></svg>',
    add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
    install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M12 7.5v7M9.2 11.8 12 14.6l2.8-2.8"/></svg>'
  }
  const back = ticketReturn()
  const params = new URLSearchParams(location.search)
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const android = /Android/i.test(ua)
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const column = (() => {
    try {
      return window.parent !== window && window.parent.location.origin === location.origin && window.parent.document.documentElement.dataset.frame === 'top' ? window.parent : null
    } catch {
      return null
    }
  })()
  let installEvent = null
  let installReturn = null
  const video = $('video')
  const scanIcon = $('scan-icon').outerHTML
  let stream = null
  let scanning = false
  let pending = false
  let frame = 0
  let decoder = null
  let canvas = null
  let config = null
  let ticket = null
  let claim = null
  let claimBusy = false
  let claimTimer = 0

  function ticketReturn() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''))
    if (!h.has('ticket')) return null
    const out = { ticket: h.get('ticket') || '', next: h.get('next') || '' }
    history.replaceState(null, '', location.pathname + location.search)
    return out
  }

  function parseTicket(raw) {
    if (typeof raw !== 'string' || raw.length > 4096 || !TICKET.test(raw)) return null
    try {
      const b = raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const bin = atob(b + '==='.slice((b.length + 3) % 4))
      const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
      if (!claims || claims.aud !== 'satura-remote' || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null
      return { raw, email: typeof claims.email === 'string' ? claims.email.slice(0, 200) : '' }
    } catch {
      return null
    }
  }

  function ticketStore(mode, fn) {
    return new Promise((ok, fail) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE)
      }
      req.onerror = () => fail(req.error || new Error("IndexedDB didn't open"))
      req.onblocked = () => fail(new Error('IndexedDB is blocked'))
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(DB_STORE, mode)
        const r = fn(tx.objectStore(DB_STORE))
        tx.oncomplete = () => {
          db.close()
          ok(r ? r.result : undefined)
        }
        tx.onerror = tx.onabort = () => {
          db.close()
          fail(tx.error || new Error('IndexedDB failed'))
        }
      }
    })
  }

  function loadConfig() {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), CONFIG_MS)
    return fetch(CONFIG, { cache: 'no-store', credentials: 'omit', signal: ctl.signal, headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`it answered ${r.status}`))))
      .then((c) => {
        const relay = new URL(c.relay)
        if (!/^wss?:$/.test(relay.protocol)) throw new Error('its relay is not a WebSocket address')
        const account = c.account === null ? null : new URL(c.account)
        if (account && !/^https?:$/.test(account.protocol)) throw new Error('its account site is not a web address')
        return { relay: relay.href, account: account ? account.origin : null }
      })
      .catch((e) => {
        console.warn(`[m] couldn't read ${CONFIG}: ${e && e.message}`)
        return null
      })
      .finally(() => clearTimeout(timer))
  }

  function relayHttp(path) {
    const u = new URL(config.relay)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    return new URL(path, u).href
  }

  function safeNext(next) {
    if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null
    try {
      const u = new URL(next, location.origin)
      return u.origin === location.origin && /^\/(m|h)\//.test(u.pathname) ? u.pathname + u.search : null
    } catch {
      return null
    }
  }

  function stashPair(code) {
    try {
      sessionStorage.setItem(PAIR_STASH_KEY, JSON.stringify({ code, at: Date.now() }))
    } catch {
    }
  }

  function takePair() {
    try {
      const s = JSON.parse(sessionStorage.getItem(PAIR_STASH_KEY) || 'null')
      sessionStorage.removeItem(PAIR_STASH_KEY)
      return s && typeof s.code === 'string' && Date.now() - Number(s.at) < PAIR_STASH_MS ? s.code : null
    } catch {
      return null
    }
  }

  function goTo(dest) {
    const u = new URL(dest, location.origin)
    if (u.pathname !== location.pathname || u.search !== location.search) return location.replace(dest)
    history.replaceState(null, '', dest)
    location.reload()
  }

  function afterSignIn(next) {
    const code = takePair()
    if (code) return `/m/#pair=${encodeURIComponent(code).replace(/%3A/gi, ':')}`
    return safeNext(next) || (readPairing() ? HOME : '/m/')
  }

  function signInNext() {
    const asked = safeNext(params.get('next'))
    const rest = new URLSearchParams(location.search)
    rest.delete('out')
    rest.delete('next')
    return asked || location.pathname + (rest.toString() ? `?${rest}` : '')
  }

  function connectUrl(next, withClaim) {
    return `${config.account}/remote/connect?next=${encodeURIComponent(next)}${withClaim ? `&claim=${withClaim}` : ''}`
  }

  function showSignIn(problem) {
    const code = hashCode(location.hash)
    if (code) stashPair(code)
    const out = params.has('out')
    const next = signInNext()
    if (out || params.has('next')) history.replaceState(null, '', location.pathname)
    root.classList.toggle('signed-out', out)
    $('signin-go').href = connectUrl(next)
    $('signout-all').href = `${config.account}/remote`
    $('signin-problem').textContent = problem || ''
    root.dataset.screen = 'signin'
    console.info(`[m] not signed in on this phone${standalone ? ' (Home Screen app)' : ''}${out ? ', just signed out' : ''}${code ? ', keeping the pairing code for after sign-in' : ''}`)
  }

  function newClaim() {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function readClaim(raw) {
    return raw && typeof raw.claim === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw.claim) && Number(raw.at) > 0 ? { claim: raw.claim, next: String(raw.next || ''), at: Number(raw.at) } : null
  }

  function dropClaim(why) {
    if (claim) console.info(`[m] dropping the sign-in claim: ${why}`)
    claim = null
    clearInterval(claimTimer)
    claimTimer = 0
    return ticketStore('readwrite', (s) => s.delete(CLAIM_KEY)).catch(() => {})
  }

  function showClaim() {
    $('claim-open').href = connectUrl(claim.next, claim.claim)
    $('claim-problem').textContent = ''
    root.dataset.screen = 'claim'
    clearInterval(claimTimer)
    claimTimer = setInterval(() => pollClaim('every 3 s'), CLAIM_POLL_MS)
    pollClaim('the waiting screen showed')
  }

  async function startClaim(next) {
    claim = { claim: newClaim(), next, at: Date.now() }
    await ticketStore('readwrite', (s) => s.put(claim, CLAIM_KEY))
    console.info('[m] Home Screen app: signing in with a claim, this page waits for the ticket')
    showClaim()
    topWindow().location.assign(connectUrl(next, claim.claim))
  }

  function claimExpired() {
    void dropClaim('it is older than 10 minutes')
    showSignIn("Signing in took more than 10 minutes. Try again.")
  }

  function pollClaim(why) {
    if (!claim || claimBusy || document.visibilityState !== 'visible') return
    if (Date.now() - claim.at >= CLAIM_MS) return claimExpired()
    const mine = claim
    claimBusy = true
    fetch(`${config.account}/api/remote/ticket/claim`, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim: mine.claim }) })
      .then((r) => {
        if (r.status === 404) return null
        if (!r.ok) throw new Error(`it answered ${r.status}`)
        return r.json().then((body) => {
          const t = parseTicket(body && body.ticket)
          if (!t) throw new Error('it sent no valid ticket')
          return t
        })
      })
      .then(async (t) => {
        $('claim-problem').textContent = ''
        if (!t || claim !== mine) return
        await ticketStore('readwrite', (s) => s.put(t.raw, TICKET_KEY))
        await dropClaim('the ticket came through it')
        const dest = afterSignIn(mine.next)
        console.info(`[m] signed in through the claim (${why})${t.email ? ` as ${t.email}` : ''}, opening ${dest.replace(/#.*/, '')}`)
        goTo(dest)
      })
      .catch((e) => {
        console.warn(`[m] couldn't check the sign-in claim (${why}): ${e && e.message}`)
        if (claim === mine) $('claim-problem').textContent = "Can't reach your account right now. This page keeps trying."
      })
      .finally(() => {
        claimBusy = false
      })
  }

  function topWindow() {
    return column || window
  }

  function noteSignedIn() {
    try {
      const at = Number(sessionStorage.getItem(SIGNED_IN_KEY) || 0)
      root.classList.toggle('app-hint', !standalone && Date.now() - at < CLAIM_MS)
    } catch {
    }
  }

  function readMacs() {
    try {
      const r = JSON.parse(localStorage.getItem(MACS_KEY) || 'null')
      const macs = Object.values(r?.desktops ?? {}).filter((m) => m && HOST_ID.test(m.hostId))
      if (macs.length) return { macs, last: r.last === 'all' || HOST_ID.test(r.last ?? '') ? r.last : null }
    } catch {
    }
    return { macs: [], last: null }
  }

  function readPairing() {
    const { macs, last } = readMacs()
    const live = macs.filter((m) => !m.removed)
    const pick = live.find((m) => m.hostId === last) ?? live[0] ?? null
    return pick ? { hostId: pick.hostId, hostName: pick.alias || pick.name || '', count: macs.length, last } : null
  }

  function resume(paired) {
    const last = paired.last && paired.last !== 'all' ? paired.last : null
    if (!last || last !== paired.hostId) {
      console.info(`[m] opening your desktops (${paired.count} on this phone)`)
      location.replace(HOME)
      return
    }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), RESUME_MS)
    fetch(relayHttp(`presence?h=${last}`), { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctl.signal, headers: ticket ? { authorization: `Bearer ${ticket.raw}` } : {} })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => {
        clearTimeout(timer)
        const p = body?.hosts?.[last]
        const ok = p?.state === 'up' && (p?.fit === 'ok' || p?.fit == null)
        console.info(`[m] last desktop ${last} is ${p ? `${p.state}${p.fit ? `, ${p.fit}` : ''}` : 'unknown'}, ${ok ? 'resuming it' : 'opening your desktops'}`)
        location.replace(ok ? `/h/${last}/` : HOME)
      })
  }

  function hashCode(hash) {
    return new URLSearchParams(String(hash || '').replace(/^#/, '')).get('pair')
  }

  function setProblem(text) {
    $('problem').textContent = text || ''
  }

  function render() {
    $('finder').classList.toggle('scanning', scanning)
    const btn = $('scan')
    btn.classList.toggle('pending', pending)
    btn.disabled = pending
    btn.innerHTML = (pending ? LINK_ICON : scanIcon) + `<span>${pending ? 'Pairing with your desktop' : scanning ? 'Point at the code' : 'Scan code'}</span>`
    $('manual').disabled = pending
  }

  function extract(text) {
    const t = String(text ?? '').trim()
    if (/^satura-remote:/i.test(t)) {
      try {
        const code = new URL(t).searchParams.get('code')
        return code ? { code } : null
      } catch {
        return null
      }
    }
    if (/^https?:\/\//i.test(t)) {
      try {
        const u = new URL(t)
        const code = hashCode(u.hash)
        return code ? { code, origin: u.origin } : null
      } catch {
        return null
      }
    }
    if (t.indexOf(':') > 0 && !t.includes('/')) return { code: t }
    return null
  }

  function target(raw) {
    const code = String(raw ?? '').replace(/\s+/g, '').toLowerCase()
    const i = code.indexOf(':')
    if (i < 0) return { error: TEXT.colon }
    const hostId = code.slice(0, i)
    if (!HOST_ID.test(hostId) || !CODE.test(code)) return { error: TEXT.shape }
    return { code, url: `/h/${hostId}/#pair=${encodeURIComponent(code).replace(/%3A/gi, ':')}` }
  }

  function go(code, origin) {
    if (origin && origin !== location.origin) {
      pending = true
      render()
      location.replace(`${origin}/m/#pair=${encodeURIComponent(code).replace(/%3A/gi, ':')}`)
      return true
    }
    const t = target(code)
    if (t.error) {
      setProblem(t.error)
      return false
    }
    if (!window.isSecureContext || !window.crypto?.subtle) {
      setProblem(TEXT.crypto)
      return false
    }
    setProblem('')
    pending = true
    render()
    location.replace(t.url)
    return true
  }

  function stopTracks(s) {
    for (const track of s?.getTracks() ?? []) track.stop()
  }

  function stopScan() {
    scanning = false
    cancelAnimationFrame(frame)
    stopTracks(stream)
    stream = null
    video.srcObject = null
    render()
  }

  function loadDecoder() {
    if (window.jsQR) return Promise.resolve(window.jsQR)
    decoder ??= new Promise((ok, fail) => {
      const s = document.createElement('script')
      s.src = DECODER
      s.onload = () => (window.jsQR ? ok(window.jsQR) : fail(Object.assign(new Error('decoder'), { decoder: true })))
      s.onerror = () => {
        decoder = null
        s.remove()
        fail(Object.assign(new Error('decoder'), { decoder: true }))
      }
      document.head.appendChild(s)
    })
    return decoder
  }

  function cameraError(e) {
    if (e?.decoder) return TEXT.decoder
    const name = e?.name ?? ''
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return TEXT.blocked
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return TEXT.none
    return TEXT.failed
  }

  function onScanned(text) {
    const hit = extract(text)
    if (!hit) {
      setProblem(TEXT.foreign)
      return
    }
    go(hit.code, hit.origin)
  }

  function decodeLoop(qr) {
    canvas ??= document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let last = 0
    const step = (now) => {
      if (!scanning) return
      frame = requestAnimationFrame(step)
      if (now - last < 120 || video.readyState < 2 || !video.videoWidth) return
      last = now
      const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight))
      const w = Math.round(video.videoWidth * k)
      const h = Math.round(video.videoHeight * k)
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      ctx.drawImage(video, 0, 0, w, h)
      const hit = qr(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })
      if (!hit?.data) return
      stopScan()
      onScanned(hit.data)
    }
    frame = requestAnimationFrame(step)
  }

  function startScan() {
    setProblem('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem(TEXT.insecure)
      return
    }
    scanning = true
    render()
    const reader = loadDecoder()
    reader.catch(() => {})
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (!scanning) return stopTracks(s)
        stream = s
        video.srcObject = s
        video.play().catch(() => {})
        return reader.then((qr) => {
          if (scanning) decodeLoop(qr)
        })
      })
      .catch((e) => {
        stopScan()
        setProblem(cameraError(e))
      })
  }

  function setKeyboardGap() {
    const vv = window.visualViewport
    const gap = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    root.style.setProperty('--kb', `${Math.round(gap)}px`)
  }

  function showSheet(id) {
    if (scanning) stopScan()
    root.classList.add('sheet-open')
    $(id).classList.add('open')
  }

  function openSheet() {
    if (pending) return
    $('code').value = ''
    $('sheet-go').disabled = true
    $('sheet-problem').textContent = ''
    showSheet('sheet')
    $('code').focus()
  }

  function closeSheet() {
    $('code').blur()
    root.classList.remove('sheet-open')
    $('sheet').classList.remove('open')
    if ($('install-sheet').classList.contains('open')) {
      $('install-sheet').classList.remove('open')
      if (installReturn) location.replace(installReturn)
    }
  }

  function browserOf() {
    if (ios) {
      if (/CriOS/.test(ua)) return 'ios-chrome'
      if (/FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|YaBrowser|GSA\//.test(ua)) return 'ios-other'
      const v = /Version\/(\d+)/.exec(ua)
      return v && Number(v[1]) >= 26 ? 'ios-safari26' : 'ios-safari'
    }
    if (android) {
      if (/SamsungBrowser/.test(ua)) return 'android-samsung'
      if (/Firefox/.test(ua)) return 'android-firefox'
      if (/EdgA|OPR|YaBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser/.test(ua)) return 'android-other'
      if (/Chrome/.test(ua)) return 'android-chrome'
      return 'android-other'
    }
    return 'desktop'
  }

  function installSteps(browser) {
    const chip = (icon) => `<span class="chip">${icon}</span>`
    const row = (label, icon) => `<div class="mock"><span>${label}</span>${icon}</div>`
    const addRow = row('Add to Home Screen', ICON.add)
    switch (browser) {
      case 'ios-safari26':
        return [[`Tap ${chip(ICON.more)} next to the address bar, then Share ${chip(ICON.share)}.`], ['Scroll down and tap Add to Home Screen.', addRow], ['Leave Open as Web App on, then tap Add.', '<div class="mock"><span>Open as Web App</span><span class="toggle"></span></div>']]
      case 'ios-safari':
        return [[`Tap Share ${chip(ICON.share)} in the toolbar.`], ['Scroll down and tap Add to Home Screen.', addRow], ['Tap Add.']]
      case 'ios-chrome':
        return [[`Tap Share ${chip(ICON.share)} in the address bar.`], ['Tap Add to Home Screen.', addRow], ['Tap Add. If you see Open as Web App, leave it on.']]
      case 'ios-other':
        return [["Open the browser's Share menu."], ['Tap Add to Home Screen.', addRow], ['Tap Add. If you see Open as Web App, leave it on.']]
      case 'android-chrome':
        return [[`Tap ${chip(ICON.dots)} in the top right corner.`], ['Tap Install app or Add to Home screen.', row('Install app', ICON.install)]]
      case 'android-samsung':
        return [[`Tap ${chip(ICON.menu)} in the bottom bar.`], ['Tap Add page to, then Home screen.']]
      case 'android-firefox':
        return [[`Tap ${chip(ICON.dots)} next to the address bar.`], ['Tap Install or Add to Home screen.']]
      default:
        return [['Open the browser menu.'], ['Tap Install app or Add to Home screen.']]
    }
  }

  function renderInstall() {
    const browser = browserOf()
    const body = $('install-body')
    body.dataset.browser = standalone ? 'standalone' : installEvent ? 'prompt' : browser
    if (standalone) {
      body.innerHTML = `<p class="ione">You're already using Satura Remote from your Home Screen.</p>`
      return
    }
    if (installEvent) {
      body.innerHTML = `<button class="btn" id="install-now">${ICON.install}Install Satura Remote</button>`
      $('install-now').addEventListener('click', promptInstall)
      return
    }
    if (browser === 'desktop') {
      body.innerHTML = '<p class="ione">Satura Remote is made for your phone. Open this page on your phone to add it to the Home Screen.</p>'
      return
    }
    const steps = installSteps(browser)
    const note = ios ? '<p class="inote">Then open Satura Remote from your Home Screen, sign in and pair there. It has its own storage, so nothing you do in this tab carries over.</p>' : ''
    body.innerHTML = `<ol class="isteps">${steps.map(([text, mock], i) => `<li><b>${i + 1}</b><span>${text}</span>${mock ?? ''}</li>`).join('')}</ol>${note}`
  }

  function promptInstall() {
    const e = installEvent
    if (!e) return false
    installEvent = null
    console.info('[m] install prompt shown')
    e.prompt()
    e.userChoice
      .then((choice) => {
        console.info(`[m] install prompt ${choice?.outcome ?? 'closed'}`)
        if (choice?.outcome === 'accepted') root.classList.remove('can-install')
      })
      .catch(() => {})
    if ($('install-sheet').classList.contains('open')) closeSheet()
    return true
  }

  function openInstall() {
    if (promptInstall()) return
    renderInstall()
    showSheet('install-sheet')
  }

  function setupInstall() {
    root.classList.toggle('can-install', (ios || android) && !standalone)
    root.classList.toggle('install-first', ios && !standalone)
    if (ios && !standalone) $('signin-go').textContent = 'Sign in here instead'
    for (const el of document.querySelectorAll('[data-install]')) el.addEventListener('click', openInstall)
    $('install-done').addEventListener('click', closeSheet)
    window.addEventListener('beforeinstallprompt', (e) => {
      if (!android || standalone) return
      e.preventDefault()
      installEvent = e
      console.info('[m] install prompt ready')
      if ($('install-sheet').classList.contains('open')) renderInstall()
    })
    window.addEventListener('appinstalled', () => {
      installEvent = null
      root.classList.remove('can-install')
      console.info('[m] installed')
    })
  }

  function wirePairing(paired) {
    if (paired) {
      root.classList.add('paired')
      $('close').href = HOME
      $('pair-title').textContent = 'Pair another desktop'
      $('pair-lead').textContent = 'Scan the code from Satura on the desktop you want to add. Your other desktops stay paired.'
    }
    $('scan').addEventListener('click', () => (scanning ? stopScan() : startScan()))
    $('manual').addEventListener('click', openSheet)
    $('sheet-cancel').addEventListener('click', closeSheet)
    $('code').addEventListener('input', () => {
      $('sheet-go').disabled = !$('code').value.includes(':')
      $('sheet-problem').textContent = ''
    })
    $('sheet').addEventListener('submit', (e) => {
      e.preventDefault()
      const t = target($('code').value)
      if (t.error) {
        $('sheet-problem').textContent = t.error
        return
      }
      closeSheet()
      go(t.code)
    })
    window.visualViewport?.addEventListener('resize', setKeyboardGap)
    window.visualViewport?.addEventListener('scroll', setKeyboardGap)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && scanning) stopScan()
    })
    window.addEventListener('pagehide', () => scanning && stopScan())
    render()
  }

  function showHost() {
    const p = readPairing()
    const name = p?.hostName
    if (typeof name !== 'string' || !name) return
    for (const el of document.querySelectorAll('.notice .host')) {
      const b = document.createElement('b')
      b.textContent = name.slice(0, 80)
      if (p.count > 1) el.replaceChildren('Paired with ', b, ` and ${p.count - 1} more desktop${p.count > 2 ? 's' : ''}`)
      else el.replaceChildren('Paired with ', b)
    }
  }

  function mirrorUrl() {
    if (!column) return
    try {
      column.history.replaceState(null, '', location.pathname + location.search + location.hash)
      column.document.title = document.title
    } catch {
    }
  }

  window.addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload()
  })
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null
    if (!a || e.defaultPrevented || a.target === '_blank' || a.origin !== location.origin) return
    e.preventDefault()
    if (a.href === location.href) return
    a.classList.add('pending')
    a.setAttribute('aria-busy', 'true')
    const top = column && !/^\/(m|h)\//.test(a.pathname) ? column : null
    console.info(`[m] link to ${a.pathname}${a.search} replaces ${top ? 'the whole tab' : 'this page'}`)
    ;(top ?? window).location.replace(a.href)
  })
  window.addEventListener('hashchange', () => {
    mirrorUrl()
    const code = hashCode(location.hash)
    if (!code || pending || root.dataset.screen !== 'pair') return
    go((extract(code) ?? { code }).code)
  })

  async function start() {
    config = await loadConfig()
    if (!config) {
      root.dataset.screen = 'error'
      return false
    }
    let problem = ''
    if (back) {
      const t = config.account ? parseTicket(back.ticket) : null
      if (t) {
        try {
          await ticketStore('readwrite', (s) => s.put(t.raw, TICKET_KEY))
          await dropClaim('the ticket came in the link')
          if (!standalone) {
            try {
              sessionStorage.setItem(SIGNED_IN_KEY, String(Date.now()))
            } catch {
            }
          }
          const dest = afterSignIn(back.next)
          console.info(`[m] signed in${t.email ? ` as ${t.email}` : ''}, opening ${dest.replace(/#.*/, '')}`)
          goTo(dest)
          return false
        } catch (e) {
          console.warn(`[m] couldn't keep the ticket: ${e && e.message}`)
          problem = "This browser couldn't keep your sign-in. Private browsing can do that."
        }
      } else {
        console.warn('[m] the sign-in came back without a valid ticket')
        problem = "Signing in didn't finish. Try again."
      }
    }
    if (config.account) {
      ticket = parseTicket(await ticketStore('readonly', (s) => s.get(TICKET_KEY)).catch(() => null))
      if (ticket) await dropClaim('this phone already has a ticket')
      else if (!problem) {
        claim = readClaim(await ticketStore('readonly', (s) => s.get(CLAIM_KEY)).catch(() => null))
        if (claim && Date.now() - claim.at < CLAIM_MS) {
          console.info(`[m] a sign-in claim from ${Math.round((Date.now() - claim.at) / 1000)} s ago is still open, waiting for its ticket`)
          showClaim()
          return false
        }
        if (claim) await dropClaim('it is older than 10 minutes')
      }
      if (!ticket || problem) {
        showSignIn(problem)
        return true
      }
    }
    const wantsInstall = params.has('install')
    const paired = readPairing()
    const code = hashCode(location.hash)
    if (params.has('pair')) history.replaceState(null, '', location.pathname)
    if (code) {
      root.dataset.screen = 'pair'
      wirePairing(paired)
      go((extract(code) ?? { code }).code)
      return false
    }
    if (paired && !params.has('add') && !wantsInstall) {
      resume(paired)
      return false
    }
    if (paired && wantsInstall && !params.has('add')) installReturn = paired.count > 1 ? HOME : `/h/${paired.hostId}/`
    root.dataset.screen = 'pair'
    noteSignedIn()
    wirePairing(paired)
    return true
  }

  mirrorUrl()
  showHost()
  $('retry').addEventListener('click', () => location.reload())
  $('signin-go').addEventListener('click', (e) => {
    const a = e.currentTarget
    if (!config?.account || a.getAttribute('aria-busy') === 'true') return e.preventDefault()
    a.classList.add('pending')
    a.setAttribute('aria-busy', 'true')
    if (!standalone) return console.info(`[m] opening sign-in at ${config.account}`)
    e.preventDefault()
    startClaim(signInNext()).catch((err) => {
      a.classList.remove('pending')
      a.removeAttribute('aria-busy')
      console.warn(`[m] couldn't start the sign-in claim: ${err && err.message}`)
      $('signin-problem').textContent = "This app couldn't keep your sign-in. Try again."
    })
  })
  $('claim-open').addEventListener('click', () => console.info('[m] opening sign-in again for the open claim'))
  $('claim-cancel').addEventListener('click', () => {
    void dropClaim('Cancel on the waiting screen')
    $('signin-go').classList.remove('pending')
    $('signin-go').removeAttribute('aria-busy')
    showSignIn('')
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollClaim('the app is visible again')
  })
  $('sheet-back').addEventListener('click', closeSheet)
  setupInstall()
  start().then((shown) => {
    if (!shown || !params.has('install')) return
    renderInstall()
    showSheet('install-sheet')
  })
})()
