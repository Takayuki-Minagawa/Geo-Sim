import type { AnalysisMessage } from '../../domain/types'

export function StatusMessages({ messages }: { messages: AnalysisMessage[] }) {
  if (messages.length === 0) return null
  return (
    <div className="message-stack" aria-live="polite">
      {messages.map((message, index) => (
        <div className={`message message-${message.severity}`} key={`${message.code}-${index}`}>
          <strong>{message.severity === 'error' ? 'エラー' : message.severity === 'warning' ? '警告' : '情報'}</strong>
          <span>{message.message}</span>
          <code>{message.code}</code>
        </div>
      ))}
    </div>
  )
}
