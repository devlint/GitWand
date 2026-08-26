import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Pulls "### question" / answer pairs out of the `## FAQ` section of a source
 * markdown file, so the FAQPage JSON-LD is generated from the same text the
 * reader sees. Returns [] when the page has no FAQ section.
 *
 * Answers are flattened to plain text: markdown links become their label,
 * emphasis and inline code markers are stripped, and only the prose paragraphs
 * are kept (schema.org answers must not carry markup or code blocks).
 */
export function extractFaq(filePath: string): { q: string; a: string }[] {
  let raw: string
  try {
    // The config is bundled to ESM, so `__dirname` does not exist here.
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    raw = fs.readFileSync(path.resolve(srcDir, filePath), 'utf-8')
  } catch {
    return []
  }

  const faqSection = raw.split(/^## (?:FAQ|Frequently asked questions)\s*$/mi)[1]
  if (!faqSection) return []
  // Stop at the next h2 (or the trailing `---` + CTA line the pages end on).
  const body = faqSection.split(/^## /m)[0].split(/^---\s*$/m)[0]

  const out: { q: string; a: string }[] = []
  for (const block of body.split(/^### /m).slice(1)) {
    const [question, ...rest] = block.split('\n')
    const answer = rest
      .join('\n')
      .replace(/```[\s\S]*?```/g, '')
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter((para) => para && !para.startsWith('|') && !para.startsWith('#'))
      .join(' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (question.trim() && answer) out.push({ q: question.trim(), a: answer })
  }
  return out
}
