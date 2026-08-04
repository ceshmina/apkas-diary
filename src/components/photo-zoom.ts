/**
 * 日別ページの本文中の写真を、その場で拡大して見るための仕掛け。
 *
 * このサイトで唯一、閲覧のために動くスクリプトである。動かなかったときにページが
 * 今までと同じ姿であることを保つため、押せる見た目も含めてすべてをここで組み立てる。
 * 生成された HTML には拡大のための要素も class も現れない。押しても何も起きない
 * ボタンが残るくらいなら、押せる手がかりごと無かったことにする。
 *
 * 拡大表示は `<dialog>` の top layer に置く。本文の写真は `td` や `figure` の中に
 * あり、その場で広げると祖先の overflow や stacking context に見た目が縛られる。
 * top layer はページの stacking から外れた層なので、本文の構造によらず同じになる。
 *
 * 中には画面ぶんのセルを3つ持ち、前・現在・次の写真を入れておく。横のドラッグに
 * 追従して隣が実際に見えている必要があるためで、隣の写真は同じページの本文で既に
 * 読み込まれているから、3つ持っても通信は増えない。
 */

/** 開閉と移動にかける時間 (ms)。 */
const DURATION = 260

const EASING = 'cubic-bezier(0.2, 0, 0, 1)'

/** セルどうしの間隔 (px)。ドラッグ中に隣の写真と地続きに見えないようにする。 */
const CELL_GAP = 32

/** 縦のジェスチャか横のジェスチャかを決めるまでの移動量 (px)。 */
const AXIS_LOCK = 12

/**
 * 閉じる・移るを確定する移動量。画面の高さ・幅に対する割合。
 *
 * 縦を深くしているのは、閉じるほうが取り返しの手数が多いため。写真を移るのは
 * 隣に動くだけだが、閉じると開き直すことになる。
 */
const CLOSE_RATIO = 0.18
const MOVE_RATIO = 0.14

/** 距離が足りなくても確定する速さ (px/ms)。弾くように動かしたとき。 */
const FLICK = 0.5

/** 端でさらに進めようとしたときに、実際に動く割合。 */
const EDGE_RESIST = 0.35

/** ホイールで閉じるまでの累積量 (px) と、続きの動作とみなす間隔 (ms)。 */
const WHEEL_CLOSE = 80
const WHEEL_GAP = 400

interface Photo {
  /** 本文中の `img`。拡大の始点と終点になる。 */
  img: HTMLImageElement
  /** スクリプトが巻いたボタン。閉じたときにフォーカスを戻す先。 */
  button: HTMLButtonElement
  /** その1枚に添えられた説明。無ければ空文字。 */
  caption: string
}

interface Cell {
  root: HTMLElement
  img: HTMLImageElement
  caption: HTMLElement
}

interface Drag {
  id: number
  x: number
  y: number
  time: number
  /** 決まるまでは null。決まったあと、もう一方の向きの成分は見ない。 */
  axis: 'x' | 'y' | null
  dx: number
  dy: number
}

function motionOk(): boolean {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 動きを減らす設定では時間を 0 にする。手順は変えず、あいだが無くなるだけにする。
 */
function timing(): KeyframeAnimationOptions {
  return { duration: motionOk() ? DURATION : 0, easing: EASING }
}

function settled(animation: Animation): Promise<void> {
  return animation.finished.then(
    () => undefined,
    () => undefined,
  )
}

/**
 * `to` の位置にある要素を、`from` の位置に見せるための transform。
 *
 * これを当ててから外すと、`from` から `to` へ動いたように見える（FLIP）。
 * レイアウトを起こさない transform と opacity だけで開閉を作るための道具。
 */
function invert(from: DOMRect, to: DOMRect): string {
  if (to.width === 0 || to.height === 0) return 'none'
  const scale = from.width / to.width
  const dx = from.left + from.width / 2 - (to.left + to.width / 2)
  const dy = from.top + from.height / 2 - (to.top + to.height / 2)
  return `translate(${dx}px, ${dy}px) scale(${scale})`
}

/** 画像に添えられた説明。`figure` の中の1枚に付いたものだけを読む。 */
function captionOf(img: HTMLImageElement): string {
  const caption = img.closest('figure')?.querySelector('figcaption')
  return caption?.textContent?.trim() ?? ''
}

interface Parts {
  dialog: HTMLDialogElement
  scrim: HTMLElement
  track: HTMLElement
  /** 前・現在・次の3つ。役割はこの並びで持ち、DOM の側は動かさない。 */
  cells: Cell[]
  /** 本文に現れる順の写真。これがそのまま移動の並びになる。 */
  photos: Photo[]
}

function setup(dialog: HTMLDialogElement, body: Element): void {
  const scrim = dialog.querySelector<HTMLElement>('.photo-zoom-scrim')
  const track = dialog.querySelector<HTMLElement>('.photo-zoom-track')
  const cells = [...dialog.querySelectorAll<HTMLElement>('.photo-zoom-cell')].flatMap<Cell>(
    (root) => {
      const img = root.querySelector('img')
      const caption = root.querySelector<HTMLElement>('.photo-zoom-caption')
      return img && caption ? [{ root, img, caption }] : []
    },
  )
  if (!scrim || !track || cells.length !== 3) return

  const photos = wrap(body)
  if (photos.length === 0) {
    dialog.remove()
    return
  }

  mount({ dialog, scrim, track, cells, photos })
}

function mount({ dialog, scrim, track, cells, photos }: Parts): void {
  dialog.style.setProperty('--photo-zoom-gap', `${CELL_GAP}px`)

  /** 今見ている写真。閉じているあいだは -1。 */
  let index = -1
  /** 開閉・移動のあいだは操作を受けない。 */
  let busy = false
  let drag: Drag | null = null
  let wheelTotal = 0
  let wheelAt = 0
  /** large の差し替えを捨てるための印。移動・閉鎖のたびに進める。 */
  let swapToken = 0

  /** 現在のセルは常に真ん中。役割は配列の並びで持ち、DOM は動かさない。 */
  function current(): Cell | undefined {
    return cells[1]
  }

  function place(cell: Cell | undefined, role: string): void {
    if (!cell) return
    cell.root.classList.remove('is-prev', 'is-current', 'is-next')
    cell.root.classList.add(role)
    cell.root.style.transform = ''
    cell.caption.style.opacity = ''
  }

  function fill(cell: Cell | undefined, photo: Photo | undefined): void {
    if (!cell) return
    if (!photo) {
      cell.root.hidden = true
      cell.caption.textContent = ''
      return
    }
    cell.root.hidden = false
    // 同じ写真なら触らない。入れ直すとデコードからやり直しになる。
    if (cell.img.src !== photo.img.src) cell.img.src = photo.img.src
    cell.img.alt = photo.img.alt
    cell.caption.textContent = photo.caption
  }

  /** 3つのセルに前・現在・次を入れ、役割を割り当て直す。 */
  function layout(): void {
    fill(cells[0], photos[index - 1])
    fill(cells[1], photos[index])
    fill(cells[2], photos[index + 1])
    place(cells[0], 'is-prev')
    place(cells[1], 'is-current')
    place(cells[2], 'is-next')
    dialog.setAttribute('aria-label', photos[index]?.caption || '写真')
  }

  /**
   * 見えている写真を high resolution 版に差し替える。
   *
   * 開き切ったあとに始める。遷移の最中に大きな画像のデコードが挟まるとコマが落ちる。
   * 矩形は確定しているので、差し替えても位置と大きさは動かない。
   *
   * 失敗しても何もしない。読み込み中であることも示さない。待つ必要のないものを
   * 待たされているように見えるため。
   */
  function swapLarge(): void {
    const cell = current()
    if (!cell) return
    const src = cell.img.src
    if (!src.includes('/medium/')) return
    const large = src.replace('/medium/', '/large/')
    const token = ++swapToken
    const loader = new Image()
    loader.src = large
    loader
      .decode()
      .then(() => {
        if (token === swapToken && dialog.open && cell.img.src === src) cell.img.src = large
      })
      .catch(() => undefined)
  }

  async function open(at: number): Promise<void> {
    const photo = photos[at]
    const cell = cells[1]
    if (!photo || !cell || dialog.open || busy) return
    busy = true
    index = at
    layout()

    // 同じ URL は本文で読み込み済みなので、実際には待ちが生じない。読めなかった
    // 場合も開く。位置と大きさは要素から取れる。
    await cell.img.decode().catch(() => undefined)

    const from = photo.img.getBoundingClientRect()
    dialog.showModal()
    dialog.focus()
    photo.img.style.visibility = 'hidden'
    wheelTotal = 0

    const to = cell.img.getBoundingClientRect()
    scrim.style.opacity = '1'
    scrim.animate([{ opacity: '0' }, { opacity: '1' }], timing())
    await settled(
      cell.img.animate([{ transform: invert(from, to) }, { transform: 'none' }], timing()),
    )

    busy = false
    swapLarge()
  }

  /** 本文中の写真が画面の外にあれば、画面に入るところまでページを送る。 */
  function bringIntoView(img: HTMLImageElement): void {
    const rect = img.getBoundingClientRect()
    if (rect.bottom > 0 && rect.top < innerHeight) return
    img.scrollIntoView({ block: 'center' })
  }

  async function close(): Promise<void> {
    const photo = photos[index]
    const cell = current()
    if (!dialog.open || busy || !photo || !cell) return
    busy = true
    swapToken++

    // 拡大したまま何枚も先へ移っていることがある。本文の側を、今見ている写真に合わせる。
    bringIntoView(photo.img)
    const to = photo.img.getBoundingClientRect()

    // 縦のドラッグの途中で閉じることがある。そのときセルが持っている動きを、
    // 見た目を変えないまま img 側へ移し替えてから、本文の位置へ向ける。
    // 説明はここで消す。写真が本文へ帰るなら、その文も本文にある。
    const visual = cell.img.getBoundingClientRect()
    cell.caption.style.opacity = '0'
    cell.root.style.transform = ''
    const base = cell.img.getBoundingClientRect()

    const end = invert(to, base)
    cell.img.style.transform = end
    scrim.animate([{ opacity: scrim.style.opacity || '1' }, { opacity: '0' }], timing())
    scrim.style.opacity = '0'
    await settled(
      cell.img.animate([{ transform: invert(visual, base) }, { transform: end }], timing()),
    )

    dialog.close()
    photo.img.style.visibility = ''
    photo.button.focus({ preventScroll: true })
    cell.img.style.transform = ''
    cell.caption.style.opacity = ''
    track.style.transform = ''
    index = -1
    busy = false
  }

  /** 動かした量を戻して、拡大表示のままに帰る。 */
  async function springBack(): Promise<void> {
    const cell = current()
    if (busy) return
    busy = true
    const trackFrom = track.style.transform || 'none'
    const cellFrom = cell?.root.style.transform || 'none'
    track.style.transform = ''
    if (cell) cell.root.style.transform = ''
    scrim.animate([{ opacity: scrim.style.opacity || '1' }, { opacity: '1' }], timing())
    scrim.style.opacity = '1'
    await Promise.all([
      settled(track.animate([{ transform: trackFrom }, { transform: 'none' }], timing())),
      cell
        ? settled(cell.root.animate([{ transform: cellFrom }, { transform: 'none' }], timing()))
        : Promise.resolve(),
    ])
    busy = false
  }

  /**
   * 隣の写真へ移る。`delta` が +1 で並びの先、-1 で手前。
   *
   * トラックを1セルぶん動かしたあと、セルの役割を1つずらして、トラックを戻す。
   * 見えているものは変わらないまま、真ん中が次の写真になる。動かした先の端の
   * セルにだけ新しい隣を入れるので、見えている写真を入れ直すことはない。
   */
  async function move(delta: number): Promise<void> {
    const from = photos[index]
    const to = photos[index + delta]
    if (!dialog.open || busy || !from) return
    if (!to) {
      await springBack()
      return
    }
    busy = true
    swapToken++

    const step = (dialog.clientWidth + CELL_GAP) * -delta
    const shifted = `translateX(${step}px)`
    const before = track.style.transform || 'none'
    track.style.transform = shifted
    await settled(track.animate([{ transform: before }, { transform: shifted }], timing()))

    from.img.style.visibility = ''
    index += delta
    to.img.style.visibility = 'hidden'
    if (delta > 0) {
      const head = cells.shift()
      if (head) cells.push(head)
    } else {
      const tail = cells.pop()
      if (tail) cells.unshift(tail)
    }
    layout()
    track.style.transform = ''

    busy = false
    swapLarge()
  }

  function applyDragX(dx: number): void {
    // 動かした先に写真が無ければ、動きに抵抗をかけて端であることを手応えにする。
    const blocked = !photos[dx < 0 ? index + 1 : index - 1]
    track.style.transform = `translateX(${blocked ? dx * EDGE_RESIST : dx}px)`
  }

  function applyDragY(dy: number): void {
    const cell = current()
    if (!cell) return
    const progress = Math.min(Math.abs(dy) / (dialog.clientHeight * CLOSE_RATIO), 1)
    cell.root.style.transform = `translateY(${dy}px) scale(${1 - progress * 0.15})`
    scrim.style.opacity = `${1 - progress * 0.55}`
  }

  dialog.addEventListener('pointerdown', (event) => {
    if (!dialog.open || busy || !event.isPrimary) return
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      axis: null,
      dx: 0,
      dy: 0,
    }
    dialog.setPointerCapture(event.pointerId)
  })

  dialog.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return
    drag.dx = event.clientX - drag.x
    drag.dy = event.clientY - drag.y
    if (!drag.axis) {
      // 指はまっすぐには動かない。どちらの操作なのかを先に決めて、以後もう一方の
      // 成分は見ない。両方に追従させると、何をしているのかが表示から読めなくなる。
      if (Math.hypot(drag.dx, drag.dy) < AXIS_LOCK) return
      drag.axis = Math.abs(drag.dx) > Math.abs(drag.dy) ? 'x' : 'y'
    }
    if (drag.axis === 'x') applyDragX(drag.dx)
    else applyDragY(drag.dy)
  })

  function endDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.id) return
    const { axis, dx, dy, time } = drag
    drag = null

    // ほとんど動かなかったならクリックとして扱う。写真の上でも外側でも閉じる。
    if (!axis) {
      void close()
      return
    }

    const elapsed = Math.max(event.timeStamp - time, 1)
    if (axis === 'x') {
      const enough =
        Math.abs(dx) > dialog.clientWidth * MOVE_RATIO || Math.abs(dx) / elapsed > FLICK
      if (enough) void move(dx < 0 ? 1 : -1)
      else void springBack()
    } else {
      const enough =
        Math.abs(dy) > dialog.clientHeight * CLOSE_RATIO || Math.abs(dy) / elapsed > FLICK
      if (enough) void close()
      else void springBack()
    }
  }

  dialog.addEventListener('pointerup', endDrag)
  dialog.addEventListener('pointercancel', endDrag)

  // ホイールは1操作あたりの量が端末で大きく違い、指の動きのように連続した量として
  // 扱えない。追従はさせず、たまった量で閉じる。向きは上下どちらでもよい。
  //
  // 間が空いたら数え直す。少し動かして止めたものが、しばらく後の少しと足されて
  // 閉じるのは、続きの動作として繋がっていない。
  dialog.addEventListener(
    'wheel',
    (event) => {
      if (!dialog.open || busy) return
      event.preventDefault()
      if (event.timeStamp - wheelAt > WHEEL_GAP) wheelTotal = 0
      wheelAt = event.timeStamp
      wheelTotal += Math.abs(event.deltaY)
      if (wheelTotal < WHEEL_CLOSE) return
      wheelTotal = 0
      void close()
    },
    { passive: false },
  )

  // `←` が並びの手前、`→` が先。ドラッグでしか移れないと、キーボードで開いた
  // 読み手には並びが無いのと同じになる。
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    void move(event.key === 'ArrowLeft' ? -1 : 1)
  })

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    void close()
  })

  for (const [at, photo] of photos.entries()) {
    photo.button.addEventListener('click', () => void open(at))
  }
}

/**
 * 本文の写真をボタンで包み、並びとして返す。
 *
 * ボタンにするのは、フォーカス・Enter/Space・フォーカスリングをブラウザから
 * 受け取るため。`a` の中の画像は対象にしない。拡大よりリンク先へ移る意図が先にある。
 *
 * 包む箱の display は、包まれる画像に合わせる。本文には段落の中に置かれた画像が
 * あり、そこに block を差し込むと段落が2つに割れてしまう。
 */
function wrap(body: Element): Photo[] {
  const photos: Photo[] = []
  for (const img of body.querySelectorAll('img')) {
    if (img.closest('a')) continue
    const inline = getComputedStyle(img).display === 'inline'
    const caption = captionOf(img)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = inline ? 'photo-zoom-open is-inline' : 'photo-zoom-open'
    button.setAttribute('aria-label', caption === '' ? '写真を拡大' : `${caption}（写真を拡大）`)
    img.replaceWith(button)
    button.append(img)

    photos.push({ img, button, caption })
  }
  return photos
}

const dialog = document.querySelector<HTMLDialogElement>('.photo-zoom')
const body = document.querySelector('.body')

// top layer を持たないブラウザでは、ここで何もせずに終わる。ボタンも巻かれず、
// ページは拡大の仕掛けが無かったときと同じ姿になる。
if (dialog && body && typeof dialog.showModal === 'function') setup(dialog, body)
