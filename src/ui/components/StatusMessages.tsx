import type { AnalysisMessage } from '../../domain/types'
import { copies, localizedMessage } from '../i18n'
import type { Locale } from '../i18n'

export function StatusMessages({
  messages,
  locale = 'ja',
}: {
  messages: AnalysisMessage[]
  locale?: Locale
}) {
  if (messages.length === 0) return null
  const copy = copies[locale]
  return (
    <div className="message-stack" aria-live="polite">
      {messages.map((message, index) => (
        <div className={`message message-${message.severity}`} key={`${message.code}-${index}`}>
          <strong>
            {message.severity === 'error'
              ? copy.error
              : message.severity === 'warning'
                ? copy.warning
                : copy.info}
          </strong>
          <span>{localizedMessage(message, locale)}</span>
          <code>{message.code}</code>
        </div>
      ))}
    </div>
  )
}
