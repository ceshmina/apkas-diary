/**
 * 日付ユーティリティ。
 *
 * 日記の所属日は JST の暦日を `YYYY-MM-DD` の文字列として扱う。
 * 比較・整列・グルーピングはすべて文字列として行い、`Date` 型を経由しない。
 * `Date` に変換すると実行環境のタイムゾーン設定によって前後の日にずれるため、
 * ビルドを実行するマシンによって結果が変わってしまう。
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_DAY_PATTERN = /^(\d{2})-(\d{2})$/

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0
  if (month === 2 && isLeapYear(year)) return 29
  return DAYS_IN_MONTH[month - 1] ?? 0
}

/** `YYYY-MM-DD` 形式で、かつ暦上実在する日付かどうか。 */
export function isValidDate(date: string): boolean {
  const m = DATE_PATTERN.exec(date)
  if (!m) return false

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])

  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

export function assertValidDate(date: string): void {
  if (!isValidDate(date)) {
    throw new Error(`日付が不正です: ${date}（YYYY-MM-DD 形式の実在する日付を指定してください）`)
  }
}

/** `2026-08-01` -> `2026` */
export function yearOf(date: string): string {
  return date.slice(0, 4)
}

/** `2026-08-01` -> `08` */
export function monthOf(date: string): string {
  return date.slice(5, 7)
}

/** `2026-08-01` -> `01` */
export function dayOf(date: string): string {
  return date.slice(8, 10)
}

/** `2026-08-01` -> `08-01`。「N年前の今日」のグルーピングに使う。 */
export function monthDayOf(date: string): string {
  return date.slice(5, 10)
}

/** `2026-08-01` -> `2026-08` */
export function yearMonthOf(date: string): string {
  return date.slice(0, 7)
}

export function isValidMonthDay(monthDay: string): boolean {
  const m = MONTH_DAY_PATTERN.exec(monthDay)
  if (!m) return false

  const month = Number(m[1])
  const day = Number(m[2])

  if (month < 1 || month > 12) return false
  // 2月29日は閏年にのみ存在するが、月日ページとしては常に用意する。
  return day >= 1 && day <= daysInMonth(2024, month)
}

/**
 * 閏日を含む366通りの月日をすべて列挙する。
 *
 * 静的サイトでは「今日」がビルド時刻に固定されてしまうため、
 * 月日ページはあらかじめ全通り生成し、訪問時刻の解決はクライアント側で行う。
 */
export function allMonthDays(): string[] {
  const result: string[] = []
  for (let month = 1; month <= 12; month++) {
    // 2024 は閏年。2月29日を含めるために使う。
    const last = daysInMonth(2024, month)
    for (let day = 1; day <= last; day++) {
      result.push(`${pad2(month)}-${pad2(day)}`)
    }
  }
  return result
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** UTC の ISO 8601。作成日時・更新日時の記録に使う。 */
export function nowUtcIso(): string {
  return new Date().toISOString()
}

/**
 * JST における今日の暦日。`YYYY-MM-DD`。
 *
 * エポックを 9 時間ずらしてから UTC の暦日として読む。実行環境のタイムゾーン
 * 設定に依存しないため、手元（JST）でも Lambda（UTC）でも同じ日を指す。
 * 深夜 0 時から 9 時のあいだに、Lambda が前日を返すという形の間違いを避ける。
 */
export function todayJst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const

/**
 * 曜日の番号（日曜が 0）。
 *
 * `Date.UTC` で明示的に UTC の暦日として組み立てるため、実行環境の
 * タイムゾーン設定に依存しない。
 */
function weekdayIndexOf(date: string): number {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** 曜日を返す。`2026-08-01` -> `土` */
export function weekdayOf(date: string): string {
  return WEEKDAYS[weekdayIndexOf(date)] ?? ''
}

/** `2026-08-01` -> `2026年8月1日（土）` */
export function formatDateJa(date: string): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  return `${year}年${month}月${day}日（${weekdayOf(date)}）`
}

/** `08-01` -> `8月1日` */
export function formatMonthDayJa(monthDay: string): string {
  return `${Number(monthDay.slice(0, 2))}月${Number(monthDay.slice(3, 5))}日`
}

/*
 * 英語の略記。公開サイトは日付と期間を英語の略記で見せる。
 *
 * **英語にするのは見た目だけで、読み上げには和文を渡す。** 日本語の読み上げ音声は
 * `Sep` や `Mon` をうまく読めない。見た目の英語と読み上げの和文（`formatDateJa`
 * など）は、同じ日付の文字列からこのモジュールの関数で作る。片方だけを手で書くと、
 * 見た目と読み上げが食い違う余地が生まれる。
 *
 * 略記は先頭だけを大文字にした形（Sep、Mon）で返す。小さな字でも語の形のまま
 * 読めるように、体裁の側で大文字に変えないこと。
 */
const MONTH_ABBRS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

const WEEKDAY_ABBRS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** 月の略記。`9` や `09` -> `Sep` */
export function monthAbbrOf(month: number | string): string {
  return MONTH_ABBRS[Number(month) - 1] ?? ''
}

/** 曜日の略記。`2026-09-20` -> `Sun` */
export function weekdayAbbrOf(date: string): string {
  return WEEKDAY_ABBRS[weekdayIndexOf(date)] ?? ''
}

export interface DatePartsEn {
  /** 日の数字。ゼロ埋めしない。`20` */
  day: string
  /** 月と年。`Sep 2026`。年を省くと `Sep` */
  monthYear: string
  /** 曜日。`Sun` */
  weekday: string
}

/**
 * 日付を、英語で見せる部分に分ける。日の数字を大きく置き、月・年と曜日を小さく
 * 添える形（一覧の行、日別ページの頭）に使う。
 *
 * `2026-09-20` -> `{ day: '20', monthYear: 'Sep 2026', weekday: 'Sun' }`
 *
 * 年の中の一覧では年を省く（`{ year: false }` で `monthYear` が `Sep`）。
 */
export function datePartsEn(date: string, { year = true }: { year?: boolean } = {}): DatePartsEn {
  const month = monthAbbrOf(monthOf(date))
  return {
    day: String(Number(dayOf(date))),
    monthYear: year ? `${month} ${yearOf(date)}` : month,
    weekday: weekdayAbbrOf(date),
  }
}

/** 日付を1行の英語で。前後の導線に使う。`2026-09-21` -> `Mon, Sep 21, 2026` */
export function formatDateEn(date: string): string {
  const { day, monthYear, weekday } = datePartsEn(date, { year: false })
  return `${weekday}, ${monthYear} ${day}, ${yearOf(date)}`
}
