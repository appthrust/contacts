// All contacts wording, as dashboard-i18n catalogs: the English source is the
// `defaultMessage`, Japanese (the audience's default) is `translations.ja`.
// Screens read it through `useText().t(id, values)` (src/i18n.tsx); no screen
// hardcodes user-facing text.
import type { DashboardMessageCatalog } from '@appthrust/platform-dashboard-i18n'
import { adminMessages } from './admin'
import { commonMessages } from './common'
import { contactMessages } from './contacts'
import { scanMessages } from './scan'

export const catalogs: readonly DashboardMessageCatalog[] = [commonMessages, scanMessages, contactMessages, adminMessages]

export type MessageId = keyof typeof commonMessages | keyof typeof scanMessages | keyof typeof contactMessages | keyof typeof adminMessages
