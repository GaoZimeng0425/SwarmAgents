// Escapes everything, then linkifies bare URLs and preserves line breaks.
// Safe without a sanitizer dep because we escape <>&" before inserting our
// own <a>/<br> — there's no way for input to break out into markup or an
// attribute. Used for calendar event descriptions (Google returns plain text;
// this makes links clickable and keeps line breaks).
function toSafeHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return esc
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, '<br/>')
}

export function HtmlText({ children, className }: { children: string; className?: string }): React.JSX.Element {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: toSafeHtml escapes all <>&" before inserting our own <a>/<br>, so input cannot break out into markup or attributes — XSS-safe by construction.
  // biome-ignore lint/style/useNamingConvention: __html is React's required DOM property name.
  return <div className={className} dangerouslySetInnerHTML={{ __html: toSafeHtml(children) }} />
}
