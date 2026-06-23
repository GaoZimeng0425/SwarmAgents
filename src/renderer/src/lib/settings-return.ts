// Tracks the location the user was on before entering the /settings group, so
// the Settings "Done" button can jump straight back there instead of relying on
// history.back() — which only unwinds one step and breaks once the user has
// navigated between settings sub-pages.
let returnHref = '/'

export function setSettingsReturnHref(href: string): void {
  returnHref = href
}

export function getSettingsReturnHref(): string {
  return returnHref
}
