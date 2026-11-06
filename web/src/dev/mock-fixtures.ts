// Dev-only fixtures for the contacts mock (./mock-contacts): three members,
// four companies, twelve contacts with their cards (two duplicate pairs, two
// private contacts, one draft, two registered automatically), three tags, one
// read card waiting for review, and the cards the fake OCR "reads" off uploads
// (single cards in turn, a sheet's cards one person each). Seeded card images
// are SVG drawings of the card, so the gallery shows something legible without
// binary fixtures.
import type { OcrFields } from '../api/contacts'

export type MemberKey = 'yamada' | 'sato' | 'suzuki'
export type CompanyKey = 'sample' | 'tokyoTech' | 'mirai' | 'hokkaido'

export const MEMBERS: Record<MemberKey, { subject: string; displayName: string; email: string; directoryPersonId: string | null }> = {
  yamada: { subject: 'sub-yamada', displayName: '山田 太郎', email: 'yamada@example.com', directoryPersonId: 'p-yamada' },
  sato: { subject: 'sub-sato', displayName: '佐藤 花子', email: 'sato@example.com', directoryPersonId: 'p-sato' },
  // Not in Directory: encounters render without a profile link (C6).
  suzuki: { subject: 'sub-suzuki', displayName: '鈴木 一郎', email: 'suzuki@example.com', directoryPersonId: null },
}

export const COMPANIES: Record<CompanyKey, { name: string; domain: string; address: string; url: string }> = {
  sample: { name: '株式会社サンプル商事', domain: 'sample-shoji.co.jp', address: '東京都千代田区丸の内1-1-1', url: 'https://sample-shoji.co.jp' },
  tokyoTech: { name: '東京テック株式会社', domain: 'tokyo-tech.jp', address: '東京都渋谷区道玄坂2-3-4', url: 'https://tokyo-tech.jp' },
  mirai: { name: '合同会社みらいデザイン', domain: 'mirai-design.jp', address: '大阪府大阪市北区梅田3-1-1', url: 'https://mirai-design.jp' },
  hokkaido: { name: '北海道物産株式会社', domain: 'hokkaido-bussan.co.jp', address: '北海道札幌市中央区北1条西2-1', url: 'https://hokkaido-bussan.co.jp' },
}

export type SeedContact = {
  key: string
  fullName: string
  kana: string | null
  company: CompanyKey | null
  department: string | null
  title: string | null
  emails: string[]
  phones: string[]
  visibility: 'shared' | 'private'
  state: 'draft' | 'active'
  createdBy: MemberKey
  /** [owner, days after T0, place]; one card each. */
  cards: [MemberKey, number, string | null][]
  tags: TagKey[]
  /** Registered automatically from its (single) card: `registeredBy: auto`, the card's decision `AutoCreated`. */
  auto?: true
}

export type TagKey = 'prospect' | 'expo' | 'followUp'

/** `owner` null = a shared tag. */
export const TAGS: Record<TagKey, { name: string; owner: MemberKey | null }> = {
  prospect: { name: '見込み客', owner: null },
  expo: { name: '展示会2026', owner: null },
  followUp: { name: '要フォロー', owner: 'yamada' },
}

export const CONTACTS: readonly SeedContact[] = [
  {
    key: 'takahashi',
    fullName: '高橋 健一',
    kana: 'タカハシ ケンイチ',
    company: 'sample',
    department: '営業部',
    title: '部長',
    emails: ['takahashi@sample-shoji.co.jp'],
    phones: ['03-1111-2222'],
    visibility: 'shared',
    state: 'active',
    createdBy: 'yamada',
    cards: [
      ['yamada', 2, '本社での打ち合わせ'],
      ['sato', 20, '展示会 東京ビッグサイト'],
    ],
    tags: ['prospect'],
  },
  {
    // Same name and company as 高橋 above: a `name_company` duplicate.
    key: 'takahashi2',
    fullName: '高橋　健一',
    kana: null,
    company: 'sample',
    department: '営業部',
    title: null,
    emails: [],
    phones: ['090-3333-4444'],
    visibility: 'shared',
    state: 'active',
    createdBy: 'suzuki',
    cards: [['suzuki', 25, null]],
    tags: [],
  },
  {
    key: 'ito',
    fullName: '伊藤 さくら',
    kana: 'イトウ サクラ',
    company: 'tokyoTech',
    department: '開発本部',
    title: 'マネージャー',
    emails: ['ito@tokyo-tech.jp'],
    phones: ['03-5555-6666'],
    visibility: 'shared',
    state: 'active',
    createdBy: 'yamada',
    cards: [['yamada', 5, '勉強会']],
    tags: ['expo'],
  },
  {
    key: 'watanabe',
    fullName: '渡辺 誠',
    kana: 'ワタナベ マコト',
    company: 'tokyoTech',
    department: '情報システム部',
    title: '課長',
    emails: ['watanabe@tokyo-tech.jp'],
    phones: [],
    visibility: 'shared',
    state: 'active',
    createdBy: 'sato',
    cards: [['sato', 7, null]],
    tags: [],
  },
  {
    key: 'nakamura',
    fullName: '中村 優子',
    kana: 'ナカムラ ユウコ',
    company: 'mirai',
    department: null,
    title: '代表',
    emails: ['nakamura@mirai-design.jp'],
    phones: ['06-1234-0000'],
    visibility: 'shared',
    state: 'active',
    createdBy: 'yamada',
    cards: [
      ['yamada', 9, '大阪出張'],
      ['suzuki', 30, null],
    ],
    tags: ['prospect', 'followUp'],
  },
  {
    key: 'kobayashi',
    fullName: '小林 大輔',
    kana: 'コバヤシ ダイスケ',
    company: 'hokkaido',
    department: '営業課',
    title: '主任',
    emails: ['kobayashi@hokkaido-bussan.co.jp'],
    phones: ['011-222-3333'],
    visibility: 'shared',
    state: 'active',
    createdBy: 'sato',
    cards: [['sato', 11, '札幌商談会']],
    tags: [],
    auto: true,
  },
  {
    key: 'clark',
    fullName: 'Emily Clark',
    kana: null,
    company: 'tokyoTech',
    department: 'Partnerships',
    title: 'Director',
    emails: ['emily.clark@tokyo-tech.jp'],
    phones: ['+81-3-5555-7777'],
    visibility: 'shared',
    state: 'active',
    createdBy: 'yamada',
    cards: [['yamada', 13, 'Tech Summit']],
    tags: ['expo'],
    auto: true,
  },
  {
    // Same name and email domain as Emily Clark above, no company: a `name_domain` duplicate.
    key: 'clark2',
    fullName: 'emily clark',
    kana: null,
    company: null,
    department: null,
    title: null,
    emails: ['e.clark@tokyo-tech.jp'],
    phones: [],
    visibility: 'shared',
    state: 'active',
    createdBy: 'sato',
    cards: [['sato', 28, null]],
    tags: [],
  },
  {
    key: 'yamamoto',
    fullName: '山本 翔太',
    kana: 'ヤマモト ショウタ',
    company: 'sample',
    department: '経理部',
    title: null,
    emails: ['yamamoto@sample-shoji.co.jp'],
    phones: [],
    visibility: 'shared',
    state: 'active',
    createdBy: 'suzuki',
    cards: [['suzuki', 15, null]],
    tags: [],
  },
  {
    // Private to 山田 (creator and only card owner).
    key: 'matsumoto',
    fullName: '松本 美穂',
    kana: 'マツモト ミホ',
    company: 'mirai',
    department: 'デザイン部',
    title: 'ディレクター',
    emails: ['matsumoto@mirai-design.jp'],
    phones: [],
    visibility: 'private',
    state: 'active',
    createdBy: 'yamada',
    cards: [['yamada', 17, null]],
    tags: [],
  },
  {
    // Private to 佐藤; 山田 sees it only as an admin, 鈴木 never.
    key: 'inoue',
    fullName: '井上 隆',
    kana: 'イノウエ タカシ',
    company: 'hokkaido',
    department: null,
    title: '代表取締役',
    emails: ['inoue@hokkaido-bussan.co.jp'],
    phones: [],
    visibility: 'private',
    state: 'active',
    createdBy: 'sato',
    cards: [['sato', 19, null]],
    tags: [],
  },
  {
    key: 'kimura',
    fullName: '木村 亜美',
    kana: 'キムラ アミ',
    company: null,
    department: null,
    title: 'フリーランス編集者',
    emails: ['ami.kimura@example.net'],
    phones: [],
    visibility: 'shared',
    state: 'draft',
    createdBy: 'suzuki',
    cards: [['suzuki', 22, null]],
    tags: [],
  },
]

/**
 * What the fake OCR reads off uploads, in turn, and what the default policy
 * makes of it: a new person read confidently (AutoCreated), a person already
 * in contacts by email (伊藤 さくら: AutoLinked), and a low-confidence read
 * (NeedsReview `low_confidence`).
 */
export const FAKE_OCR: readonly OcrFields[] = [
  {
    fullName: '森 由紀子',
    kana: 'モリ ユキコ',
    company: '株式会社ひかり物流',
    department: '営業企画部',
    title: '課長',
    emails: ['mori@hikari-logi.co.jp'],
    phones: ['03-1234-5678', '090-8765-4321'],
    address: '東京都港区芝浦1-2-3',
    url: 'https://hikari-logi.co.jp',
    confidence: 0.92,
  },
  {
    fullName: '伊藤 さくら',
    kana: 'イトウ サクラ',
    company: '東京テック株式会社',
    department: '開発本部',
    title: 'マネージャー',
    emails: ['ito@tokyo-tech.jp'],
    phones: ['03-5555-6666'],
    address: '東京都渋谷区道玄坂2-3-4',
    url: 'https://tokyo-tech.jp',
    confidence: 0.88,
  },
  {
    fullName: '佐々木 亮',
    kana: null,
    company: '合同会社みらいデザイン',
    department: 'デザイン部',
    title: 'アートディレクター',
    emails: ['sasaki@mirai-design.jp'],
    phones: [],
    address: null,
    url: null,
    confidence: 0.45,
  },
]

/**
 * What the fake splitter "finds" on an uploaded sheet (a file named `*sheet*`),
 * one person per card in this order: six people nobody has met yet, read
 * confidently except 小林 (0.48, waits for review) and 吉田 (no kana).
 */
export const SHEET_OCR: readonly OcrFields[] = [
  {
    fullName: '石井 美咲',
    kana: 'イシイ ミサキ',
    company: '株式会社あおば製作所',
    department: '購買部',
    title: '主任',
    emails: ['ishii@aoba-mfg.co.jp'],
    phones: ['045-111-2222'],
    address: '神奈川県横浜市西区みなとみらい2-2-1',
    url: 'https://aoba-mfg.co.jp',
    confidence: 0.93,
  },
  {
    fullName: '岡田 大輔',
    kana: 'オカダ ダイスケ',
    company: '株式会社ソラ通信',
    department: '法人営業部',
    title: '部長',
    emails: ['okada@sora-tsushin.jp'],
    phones: ['03-2222-3333'],
    address: null,
    url: 'https://sora-tsushin.jp',
    confidence: 0.9,
  },
  {
    fullName: '小林 直樹',
    kana: 'コバヤシ ナオキ',
    company: '小林会計事務所',
    department: null,
    title: '税理士',
    emails: [],
    phones: ['06-3333-4444'],
    address: null,
    url: null,
    confidence: 0.48,
  },
  {
    fullName: 'Lucas Martin',
    kana: null,
    company: 'Northwind Trading',
    department: 'Partnerships',
    title: 'Director',
    emails: ['lucas.martin@northwind.example'],
    phones: ['+1 206 555 0147'],
    address: null,
    url: 'https://northwind.example',
    confidence: 0.91,
  },
  {
    fullName: '吉田 恵',
    kana: null,
    company: '株式会社みどり不動産',
    department: '賃貸管理課',
    title: null,
    emails: ['yoshida@midori-re.co.jp'],
    phones: ['011-444-5555'],
    address: '北海道札幌市中央区大通西4-1',
    url: null,
    confidence: 0.87,
  },
  {
    fullName: '藤井 翔太',
    kana: 'フジイ ショウタ',
    company: '株式会社ハルカ食品',
    department: 'マーケティング部',
    title: 'マネージャー',
    emails: ['fujii@haruka-foods.jp'],
    phones: ['052-555-6666'],
    address: null,
    url: 'https://haruka-foods.jp',
    confidence: 0.89,
  },
]

/**
 * A card 山田 scanned that automatic registration read with low confidence
 * (misread kana, no email), so it waits in the review queue
 * (`NeedsReview` / `low_confidence`).
 */
export const REVIEW_CARD: { owner: MemberKey; day: number; place: string | null; fields: OcrFields } = {
  owner: 'yamada',
  day: 30,
  place: '展示会 東京ビッグサイト',
  fields: {
    fullName: '前田 智也',
    kana: 'マエグ トモヤ',
    company: '株式会社ノース建設',
    department: '工事部',
    title: null,
    emails: [],
    phones: ['03-9876-5432'],
    address: null,
    url: null,
    confidence: 0.52,
  },
}

const escapeXml = (text: string) => text.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`)

/** A 910×550 (91 mm × 55 mm) drawing of a business card, as SVG bytes. */
export function cardSvg(lines: { company: string; fullName: string; title: string; email: string }): Uint8Array<ArrayBuffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="910" height="550" viewBox="0 0 910 550">
<rect width="910" height="550" rx="16" fill="#fdfcf9"/>
<rect x="0" y="0" width="16" height="550" fill="#4b55a8"/>
<text x="70" y="110" font-family="sans-serif" font-size="34" fill="#57534e">${escapeXml(lines.company)}</text>
<text x="70" y="200" font-family="sans-serif" font-size="30" fill="#78716c">${escapeXml(lines.title)}</text>
<text x="70" y="300" font-family="sans-serif" font-size="72" font-weight="bold" fill="#1c1917">${escapeXml(lines.fullName)}</text>
<text x="70" y="470" font-family="monospace" font-size="28" fill="#57534e">${escapeXml(lines.email)}</text>
</svg>`
  return new TextEncoder().encode(svg)
}
