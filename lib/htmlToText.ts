// lib/htmlToText.ts
import { convert } from 'html-to-text'
export const htmlToText = (html: string) =>
  convert(html, {
    wordwrap: 120,
    selectors: [{ selector: 'script,style,noscript', format: 'skip' }]
  }).slice(0, 15000)