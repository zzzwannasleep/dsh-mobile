/**
 * Third-party client modules stay out of the dedicated mobile frontend.
 *
 * Community plugins are written against the desktop layout: sidebars, toolbars
 * and dialogs assume pointer input and wide viewports, and on the phone they
 * were the reason the dedicated shell still looked like the desktop page. DSH's
 * own client modules keep loading; only optional third-party application
 * modules are removed from the mobile boot graph.
 */

/** Modules owned by DSH or by this plugin, which always load on mobile. */
export function isFirstPartyClientModuleId(id: string): boolean {
  return id.startsWith('@deepseek-ai/')
    || id === 'dsh-mobile'
    || id === 'dsh-mobile-question-fixes'
    || id.startsWith('dsh-mobile/')
}

/**
 * Resolve the mobile exclusion list under clean-frontend mode.
 *
 * Candidates are optional, non-first-party application modules. A candidate
 * that any remaining module depends on must stay loaded, and keeping it keeps
 * its own third-party dependencies, so the rule settles as a fixpoint. The
 * explicit preference list (device override, computer default or plugin
 * configuration) is always honored on top.
 */
export function cleanFrontendExclusions(
  entries: readonly { readonly id: string; readonly required: boolean; readonly dependencies: readonly string[] }[],
  explicit: readonly string[],
): readonly string[] {
  const candidates = new Set(entries
    .filter(entry => !entry.required && !isFirstPartyClientModuleId(entry.id))
    .map(entry => entry.id))
  const staying = new Set(entries.filter(entry => !candidates.has(entry.id)).map(entry => entry.id))
  let changed = true
  while (changed) {
    changed = false
    for (const entry of entries) {
      if (!staying.has(entry.id)) continue
      for (const dependency of entry.dependencies) {
        if (candidates.has(dependency)) {
          candidates.delete(dependency)
          staying.add(dependency)
          changed = true
        }
      }
    }
  }
  return Object.freeze([...new Set([...explicit, ...candidates])].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
}
