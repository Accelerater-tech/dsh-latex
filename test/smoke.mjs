/**
 * 冒烟测试：不经过 harness，直接验证 TeX 管线。
 *   node test/smoke.mjs
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { binaryReport, compileDocument, compileMath } from '../lib/tex.js'

const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-latex-smoke-'))
console.log('cwd:', cwd)

console.log('\n[binaries]', binaryReport())

const svg = await compileMath({
  source: '\\int_0^1 \\frac{x^2}{1+x}\\,dx = \\ln 2 - \\frac{1}{2}',
  cwd,
})
console.log('\n[math svg]', svg.files[0])
const svgText = await readFile(svg.files[0].path, 'utf8')
console.log('  svg head:', svgText.slice(0, 180).replace(/\n/g, ' '))

const png = await compileMath({
  source: '$$\\sum_{k=1}^{\\infty}\\frac{1}{k^2}=\\frac{\\pi^2}{6}$$',
  format: 'png',
  dpi: 300,
  cwd,
})
console.log('\n[math png]', png.files[0])

const cached = await compileMath({
  source: '\\int_0^1 \\frac{x^2}{1+x}\\,dx = \\ln 2 - \\frac{1}{2}',
  cwd,
})
console.log('\n[math svg cached]', { cached: cached.cached, path: cached.files[0].path })

const doc = await compileDocument({
  source: '\\section{结论}\n给定 $x>0$，有 $\\sqrt{x^2}=x$。\n\\begin{equation}\ne^{i\\pi}+1=0\n\\end{equation}',
  cwd,
})
console.log('\n[document]', { engine: doc.engine, cjk: doc.cjk, files: doc.files })

try {
  await compileMath({ source: '\\frac{1}{', cwd })
} catch (error) {
  console.log('\n[expected failure]', error.message.split('\n').slice(0, 4).join(' | '))
}

const pdfMath = await compileMath({
  source: 'E = mc^2 + \\oint \\mathbf{B}\\cdot d\\mathbf{l}',
  format: 'pdf',
  cwd,
})
console.log('\n[math pdf]', pdfMath.files[0])

const alignPng = await compileMath({
  source: '\\begin{align} a &= b + c \\\\ d &= e \\end{align}',
  format: 'png',
  cwd,
})
console.log('\n[align png]', alignPng.files[0])

const inline = await compileMath({ source: '$\\alpha+\\beta$', displayMode: false, format: 'svg', cwd })
console.log('\n[inline svg]', inline.files[0])
