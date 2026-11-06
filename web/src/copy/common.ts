// Shell, navigation, feedback and error wording shared by every screen.
import { defineDashboardMessages } from '@appthrust/platform-dashboard-i18n'

export const commonMessages = defineDashboardMessages({
  'contacts.product': { defaultMessage: 'Contacts', translations: { ja: '名刺' } },
  'contacts.productMark': { defaultMessage: 'C', translations: { ja: '名' } },
  'contacts.language.ja': { defaultMessage: '日本語', translations: { ja: '日本語' } },
  'contacts.language.en': { defaultMessage: 'English', translations: { ja: 'English' } },
  'contacts.nav.label': { defaultMessage: 'Contacts sections', translations: { ja: '名刺のメニュー' } },
  'contacts.nav.scan': { defaultMessage: 'Scan', translations: { ja: '取り込む' } },
  'contacts.nav.contacts': { defaultMessage: 'All contacts', translations: { ja: '連絡先' } },
  'contacts.nav.companies': { defaultMessage: 'Companies', translations: { ja: '会社' } },
  'contacts.nav.duplicates': { defaultMessage: 'Duplicates', translations: { ja: '重複' } },
  'contacts.nav.settings': { defaultMessage: 'Settings', translations: { ja: '設定' } },
  'contacts.nav.you': { defaultMessage: 'You', translations: { ja: 'あなた' } },
  'contacts.nav.language': { defaultMessage: 'Display language', translations: { ja: '表示言語' } },
  'contacts.nav.skipToMain': { defaultMessage: 'Skip to main content', translations: { ja: '本文へ移動' } },
  'contacts.common.loading': { defaultMessage: 'Loading…', translations: { ja: '読み込んでいます…' } },
  'contacts.common.loadFailed': { defaultMessage: "Couldn't load this page", translations: { ja: '読み込めませんでした' } },
  'contacts.common.retry': { defaultMessage: 'Try again', translations: { ja: 'もう一度読み込む' } },
  'contacts.common.loadMore': { defaultMessage: 'Load more', translations: { ja: 'もっと見る' } },
  'contacts.common.accessDenied': {
    defaultMessage: 'This account cannot use Contacts. Sign in again or ask an administrator.',
    translations: { ja: 'このアカウントでは名刺を使えません。サインインし直すか、管理者に確認してください。' },
  },
  'contacts.common.actionFailed': { defaultMessage: "Couldn't complete the action", translations: { ja: '操作を完了できませんでした' } },
  'contacts.common.close': { defaultMessage: 'Close', translations: { ja: '閉じる' } },
  'contacts.common.cancel': { defaultMessage: 'Cancel', translations: { ja: 'キャンセル' } },
  'contacts.common.save': { defaultMessage: 'Save', translations: { ja: '保存' } },
  'contacts.common.edit': { defaultMessage: 'Edit', translations: { ja: '編集' } },
  'contacts.common.search': { defaultMessage: 'Search', translations: { ja: '検索' } },
  'contacts.common.required': { defaultMessage: 'Required', translations: { ja: '必須' } },
  'contacts.common.breadcrumbs': { defaultMessage: 'Breadcrumbs', translations: { ja: 'パンくずリスト' } },
  'contacts.common.end': { defaultMessage: "That's everything.", translations: { ja: 'これですべてです。' } },
  'contacts.common.unknownMember': { defaultMessage: 'Unknown member', translations: { ja: '不明なメンバー' } },
  'contacts.errors.transient': {
    defaultMessage: 'Contacts is temporarily unavailable. Try again in a moment.',
    translations: { ja: '名刺に一時的につながりません。少し待ってからもう一度お試しください。' },
  },
  'contacts.errors.storeUnavailable': {
    defaultMessage: "Contacts' database is temporarily unavailable. Try again in a moment.",
    translations: { ja: '名刺のデータベースに一時的につながりません。少し待ってからもう一度お試しください。' },
  },
  'contacts.errors.identityUnavailable': {
    defaultMessage: 'Sign-in could not be checked right now. Try again in a moment.',
    translations: { ja: 'サインインを確認できませんでした。少し待ってからもう一度お試しください。' },
  },
  'contacts.errors.forbidden': { defaultMessage: "You don't have permission for this action.", translations: { ja: 'この操作をする権限がありません。' } },
  'contacts.errors.notFound': {
    defaultMessage: 'This item no longer exists. It may have been deleted or merged.',
    translations: { ja: 'この項目はもうありません。削除または統合された可能性があります。' },
  },
  'contacts.errors.invalid': { defaultMessage: 'Check the entered values.', translations: { ja: '入力内容を確認してください。' } },
  'contacts.errors.versionConflict': {
    defaultMessage: 'Someone else changed this contact in the meantime.',
    translations: { ja: 'その間にほかの人がこの連絡先を変更しました。' },
  },
  'contacts.errors.ocrUnavailable': {
    defaultMessage: 'Card reading is not set up for this Project.',
    translations: { ja: 'この Project では名刺の読み取りが設定されていません。' },
  },
  'contacts.errors.imageTooLarge': { defaultMessage: 'The image is larger than 5 MB.', translations: { ja: '画像が 5 MB を超えています。' } },
  'contacts.errors.unsupportedImage': {
    defaultMessage: 'Use a JPEG, PNG, WebP or HEIC image.',
    translations: { ja: 'JPEG・PNG・WebP・HEIC の画像を使ってください。' },
  },
  'contacts.notFound.title': { defaultMessage: 'Page not found', translations: { ja: 'ページが見つかりません' } },
  'contacts.notFound.body': {
    defaultMessage: 'The contact or company may have been removed, or the address may be wrong.',
    translations: { ja: 'この連絡先や会社は削除されたか、アドレスが間違っている可能性があります。' },
  },
  'contacts.notFound.home': { defaultMessage: 'Back to scanning', translations: { ja: '取り込みへ戻る' } },
})
