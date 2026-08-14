/** Injects the dsh-remote stylesheet exactly once. */
import css from './styles.css'

const KEY = 'dsh-remote:chrome'

/** Install the owned `<style>` tag; idempotent under re-evaluation. */
export function installStyles(): void {
  if (document.querySelector(`style[data-dsh-remote="${KEY}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.dshRemote = KEY
  tag.textContent = css
  document.head.appendChild(tag)
}

/** Remove the style tag this plugin installed. */
export function removeStyles(): void {
  document.querySelectorAll('style[data-dsh-remote]').forEach(tag => tag.remove())
}
