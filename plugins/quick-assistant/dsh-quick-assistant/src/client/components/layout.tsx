/**
 * Layout and type roles shared by the Quick Assistant settings sections.
 *
 * Every color resolves through a `--dsw-alias-*` theme token, so light and dark
 * themes come from the shell rather than from this plugin.
 */

import type { ReactNode } from 'react'

/** Style objects reused across the page; only layout, type, and surface roles. */
export const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
    paddingTop: '4px',
    paddingBottom: '8px',
    font: 'var(--dsw-font-s-14)',
    color: 'var(--dsw-alias-label-primary)',
  },
  header: { display: 'flex', flexDirection: 'column', gap: '6px' },
  title: { margin: 0, font: 'var(--dsw-font-base-strong-16)', color: 'var(--dsw-alias-label-primary)' },
  description: { margin: 0, font: 'var(--dsw-font-s-14)', color: 'var(--dsw-alias-label-secondary)' },
  section: { display: 'flex', flexDirection: 'column', gap: '12px' },
  sectionHeading: { display: 'flex', flexDirection: 'column', gap: '4px' },
  sectionTitle: { margin: 0, font: 'var(--dsw-font-s-strong-14)', color: 'var(--dsw-alias-label-primary)' },
  sectionHint: { margin: 0, font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-label-secondary)' },
  cardStack: { display: 'flex', flexDirection: 'column', gap: '10px' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px 14px',
    border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
    borderRadius: 'var(--dsw-radius-xl)',
    background: 'var(--dsw-alias-settings-card-fill)',
  },
  cardHeading: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
  cardText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  cardTitle: { margin: 0, font: 'var(--dsw-font-s-strong-14)', color: 'var(--dsw-alias-label-primary)' },
  cardHint: { margin: 0, font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-label-secondary)' },
  switchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flex: '0 0 auto',
    font: 'var(--dsw-font-xs-13)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  fieldRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
  field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
  fieldLabel: { font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-label-secondary)' },
  fieldPlaceholder: {
    display: 'flex',
    alignItems: 'center',
    height: '32px',
    padding: '0 10px',
    border: '0.5px dashed var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-md)',
    font: 'var(--dsw-font-xs-13)',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  notice: { margin: 0, font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-label-secondary)' },
  warning: { margin: 0, font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-state-warn-primary)' },
  error: { margin: 0, font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-state-error-primary)' },
  success: { margin: 0, font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-state-success-primary)' },
  banner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    padding: '8px 10px',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  bannerText: { margin: 0, font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-label-secondary)' },
  inlineRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  keycap: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '28px',
    padding: '0 10px',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-sm)',
    background: 'var(--dsw-alias-bg-layer-2)',
    fontFamily: 'var(--dsw-font-family)',
    fontSize: '13px',
    letterSpacing: '0.02em',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
  },
  keycapRecording: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '28px',
    padding: '0 10px',
    border: '1px solid var(--dsw-alias-state-business-primary)',
    borderRadius: 'var(--dsw-radius-sm)',
    background: 'var(--dsw-alias-bg-layer-2)',
    fontFamily: 'var(--dsw-font-family)',
    fontSize: '13px',
    color: 'var(--dsw-alias-state-business-primary)',
    cursor: 'pointer',
  },
  textarea: {
    width: '100%',
    minHeight: '72px',
    padding: '8px 10px',
    boxSizing: 'border-box',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", monospace',
    fontSize: '12px',
    lineHeight: '1.6',
    resize: 'vertical',
  },
  promptHeading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
  footer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    paddingTop: '14px',
    borderTop: '0.5px solid var(--dsw-alias-border-l2)',
  },
  helperStatus: { display: 'flex', flexDirection: 'column', gap: '8px' },
  footerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  footerStatus: { margin: 0, font: 'var(--dsw-font-xs-13)', color: 'var(--dsw-alias-label-secondary)' },
  footerActions: { display: 'flex', alignItems: 'center', gap: '8px' },
  errorBlock: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '10px' },
} as const

/** One page section: a heading plus its controls. */
export function Section({ title, description, children }: {
  title: string
  description?: string | undefined
  children: ReactNode
}) {
  return (
    <section style={styles.section}>
      <div style={styles.sectionHeading}>
        <h3 style={styles.sectionTitle}>{title}</h3>
        {description !== undefined && <p style={styles.sectionHint}>{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** One elevated surface grouping the controls of a section. */
export function Card({ children }: { children: ReactNode }) {
  return <div style={styles.card}>{children}</div>
}

/** One labelled control cell. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      {children}
    </div>
  )
}
