import { useEffect, useRef } from 'react'
import { copies } from '../i18n'
import type { Locale } from '../i18n'

export function ManualDialog({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const copy = copies[locale]
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="manual-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        aria-labelledby="manual-title"
        aria-modal="true"
        className="manual-dialog"
        role="dialog"
      >
        <header className="manual-header">
          <div>
            <p className="eyebrow">GUIDE</p>
            <h2 id="manual-title">{copy.manualTitle}</h2>
          </div>
          <button
            aria-label={copy.close}
            className="button button-ghost manual-close"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </header>
        <p className="manual-intro">{copy.manualIntro}</p>
        <div className="manual-steps">
          {[
            [copy.manualStep1Title, copy.manualStep1Body],
            [copy.manualStep2Title, copy.manualStep2Body],
            [copy.manualStep3Title, copy.manualStep3Body],
            [copy.manualStep4Title, copy.manualStep4Body],
          ].map(([title, body]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
        <aside className="manual-caution">
          <strong>{copy.manualSafetyTitle}</strong>
          <p>{copy.manualSafetyBody}</p>
        </aside>
        <footer className="manual-footer">
          <button className="button button-primary" onClick={onClose} type="button">
            {copy.close}
          </button>
        </footer>
      </section>
    </div>
  )
}
