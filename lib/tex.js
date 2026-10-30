/**
 * LaTeX 引擎发现 + 编译管线。
 *
 * 设计要点：
 * - 不依赖宿主进程的 PATH（桌面端 Electron 进程经常拿不到 /Library/TeX/texbin），
 *   自己扫描 TeX Live 安装目录后再拼一份最小可用的环境变量传给子进程。
 * - 每次编译都在 `$TMPDIR/dsh-latex-cache/<sha256>/` 这个"作业目录"里跑，
 *   同一份源码第二次编译直接复用产物（除非 force）。
 * - 失败时把 .log 里的 `! ...` 诊断块抽出来，而不是把几千行日志丢给模型。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 需要发现的全部可执行文件。 */
const TOOLS = [
  'latex',
  'pdftex',
  'pdfcrop',
  'pdflatex',
  'xelatex',
  'lualatex',
  'dvisvgm',
  'dvipng',
  'dvipdfmx',
  'bibtex',
  'biber',
  'kpsewhich',
]

/** macOS 上 TeX 的常规落点（TeX Live / MacTeX 的 /Library/TeX/texbin 软链）。 */
const FALLBACK_DIRS = [
  '/Library/TeX/texbin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
]

/** 单个子进程输出上限，防止畸形日志撑爆内存。 */
const OUTPUT_LIMIT = 64 * 1024

const FORMATS = new Set(['svg', 'png', 'pdf'])
const ENGINES = new Set(['pdflatex', 'xelatex', 'lualatex'])
const CJK_PATTERN = /[\u2E80-\u2FFF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

/** 已经是"块级公式"的写法，不需要再包一层 \[ \]。 */
const BLOCK_MATH_ENV =
  /\\(?:begin)\{(?:equation|align|gather|multline|flalign|alignat|eqnarray|displaymath)\*?\}/

/** 会让 TeX 要求再跑一遍的日志信号。 */
const RERUN_PATTERN =
  /(Rerun to get|Label\(s\) may have changed|There were undefined references|Package rerunfilecheck Warning|Citation \S+ undefined)/

export class TexError extends Error {
  constructor(message, { log = '', tex = '', file = '' } = {}) {
    super(message)
    this.name = 'TexError'
    this.log = log
    this.tex = tex
    this.file = file
  }
}

// ---------------------------------------------------------------------------
// 可执行文件发现
// ---------------------------------------------------------------------------

let discovery = null

/** 扫描 /usr/local/texlive/<year>/bin/<arch> 这类真实安装目录。 */
function texliveBinDirs() {
  const dirs = []
  for (const root of ['/usr/local/texlive', '/opt/texlive', '/Library/TeX/texlive']) {
    let years
    try {
      years = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const year of years.filter((entry) => /^\d{4}$/.test(entry)).sort().reverse()) {
      const bin = path.join(root, year, 'bin')
      let archs
      try {
        archs = fs.readdirSync(bin)
      } catch {
        continue
      }
      for (const arch of archs) dirs.push(path.join(bin, arch))
    }
  }
  return dirs
}

/**
 * 找到这台机器上的 TeX 可执行文件。
 * @param {{ refresh?: boolean }} [input] refresh 为真时丢弃缓存重新扫描。
 * @returns {{ dirs: string[], found: Record<string, string> }}
 */
export function discoverBinaries({ refresh = false } = {}) {
  if (discovery && !refresh) return discovery

  const dirs = []
  const seen = new Set()
  const add = (dir) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    dirs.push(dir)
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) add(dir)
  for (const dir of texliveBinDirs()) add(dir)
  for (const dir of FALLBACK_DIRS) add(dir)

  const found = {}
  for (const name of TOOLS) {
    for (const dir of dirs) {
      const file = path.join(dir, name)
      try {
        fs.accessSync(file, fs.constants.X_OK)
        found[name] = file
        break
      } catch {
        // 继续找下一个目录
      }
    }
  }

  discovery = { dirs, found }
  return discovery
}

/** 子进程环境：把 TeX 目录顶到 PATH 前面，保证 latex 调用的子程序也能被解析。 */
function texEnvironment() {
  const { dirs } = discoverBinaries()
  const prefix = dirs.filter(
    (dir) => dir === '/Library/TeX/texbin' || /texlive|TeX/i.test(dir) || dir === '/usr/bin',
  )
  const rest = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  return { ...process.env, PATH: [...new Set([...prefix, ...rest])].join(path.delimiter) }
}

/** 取某个可执行文件的绝对路径，找不到就抛 TexError。 */
export function requireBinary(name) {
  const { found } = discoverBinaries()
  const file = found[name]
  if (!file) {
    throw new TexError(
      `找不到 \`${name}\`。这台机器上没有可用的 TeX Live：macOS 请安装 MacTeX / TeX Live` +
        `（安装后会在 /Library/TeX/texbin 暴露 latex、dvisvgm 等命令）。`,
    )
  }
  return file
}

/** 当前环境里可用的 TeX 工具清单，供调试/自检使用。 */
export function binaryReport() {
  const { found } = discoverBinaries({ refresh: true })
  return Object.fromEntries(TOOLS.map((name) => [name, found[name] ?? null]))
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

function appendChunk(buffer, chunk) {
  const next = buffer + chunk.toString('utf8')
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next
}

/**
 * 跑一个命令，永不 reject（失败信息放在返回值里，便于统一格式化日志）。
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function run(file, args, { cwd, timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd,
        env: env ?? texEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            try {
              child.kill('SIGKILL')
            } catch {
              // 进程可能已经退出
            }
          }, timeoutMs)
        : null

    child.stdout?.on('data', (chunk) => {
      stdout = appendChunk(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = appendChunk(stderr, chunk)
    })
    child.on('error', (error) => {
      stderr = appendChunk(stderr, `\n${String(error?.message ?? error)}`)
      finish(-1)
    })
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1))
  })
}

// ---------------------------------------------------------------------------
// 源码构造
// ---------------------------------------------------------------------------

/** 剥掉整段包裹的外层定界符（$$ / \[ \] / \( \) / displaymath）。 */
export function stripMathDelimiters(raw) {
  let math = String(raw ?? '').trim()
  const pairs = [
    ['$$', '$$'],
    ['\\[', '\\]'],
    ['\\(', '\\)'],
    ['\\begin{displaymath}', '\\end{displaymath}'],
  ]
  for (const [open, close] of pairs) {
    if (math.length > open.length + close.length && math.startsWith(open) && math.endsWith(close)) {
      math = math.slice(open.length, math.length - close.length).trim()
      break
    }
  }
  if (math.length > 2 && !math.startsWith('$$') && math.startsWith('$') && math.endsWith('$')) {
    math = math.slice(1, -1).trim()
  }
  return math
}

/** `#rrggbb` / 颜色名 → xcolor 的 \color 参数。 */
function latexColor(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const full = /^#([0-9a-fA-F]{6})$/.exec(raw)
  if (full) return `[HTML]{${full[1]}}`
  const short = /^#([0-9a-fA-F]{3})$/.exec(raw)
  if (short) return `[HTML]{${short[1].split('').map((c) => c + c).join('')}}`
  return `{${raw}}`
}

/** 公式 → 一份最小 LaTeX 文档（产物由编译后端裁掉空白）。 */
export function buildMathDocument({ math, displayMode = true, preamble = '', color = '' }) {
  const body = BLOCK_MATH_ENV.test(math) ? math : displayMode ? `\\[${math}\\]` : `$${math}$`
  // 不用 standalone 类：它在 DVI 模式下把正文塞进 \hbox，display math 会报
  // "Missing $ inserted"。改用普通 article + 空页眉，靠 dvisvgm --bbox=min /
  // dvipng -T tight / pdfcrop 把空白裁掉，display math 与 align 都能正常排版。
  const lines = [
    '\\documentclass{article}',
    '\\usepackage{amsmath}',
    '\\usepackage{amssymb}',
    '\\usepackage{amsfonts}',
    '\\usepackage{xcolor}',
  ]
  const extra = String(preamble ?? '').trim()
  if (extra) lines.push(extra)
  lines.push('\\pagestyle{empty}', '\\begin{document}')
  const ink = latexColor(color)
  if (ink) lines.push(`\\color${ink}`)
  lines.push(body, '\\end{document}', '')
  return lines.join('\n')
}

/** 文档正文 → 完整文档（已经带 \documentclass 的原样放行）。 */
export function buildDocument({ source, preamble = '', documentClass, classOptions = '11pt,a4paper' }) {
  const raw = String(source ?? '').replace(/\r\n/g, '\n')
  const cjk = CJK_PATTERN.test(raw)
  if (/\\documentclass/.test(raw)) return { tex: raw, wrapped: false, cjk }

  const docClass = documentClass || (cjk ? 'ctexart' : 'article')
  const lines = [
    `\\documentclass[${classOptions}]{${docClass}}`,
    '\\usepackage{amsmath}',
    '\\usepackage{amssymb}',
    '\\usepackage{graphicx}',
    '\\usepackage{geometry}',
  ]
  const extra = String(preamble ?? '').trim()
  if (extra) lines.push(extra)
  lines.push('\\begin{document}', raw, '\\end{document}', '')
  return { tex: lines.join('\n'), wrapped: true, cjk }
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

/** TeX 的报错行：`! ...`、`l.12 ...`、以及 -file-line-error 的 `main.tex:12: ...`。 */
const ERROR_LINE = /^(?:!|l\.\d+|.+:\d+:\s)/

/**
 * 从完整日志里抽出诊断块，避免把整份 .log 塞给模型。
 * 抽不到就退回最后若干行非空内容。
 */
export function summarizeLog(text, limit = 24) {
  const lines = String(text ?? '').split(/\r?\n/)
  const picked = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!ERROR_LINE.test(lines[index])) continue
    picked.push(lines[index])
    for (let follow = index + 1; follow < Math.min(index + 4, lines.length); follow += 1) {
      if (lines[follow].trim()) picked.push(lines[follow])
    }
    if (picked.length >= limit) break
  }
  if (picked.length === 0) {
    picked.push(...lines.filter((line) => line.trim()).slice(-limit))
  }
  return picked.join('\n').trim()
}

function failure(tool, result, tex) {
  const log = summarizeLog(`${result.stdout}\n${result.stderr}`)
  const reason = result.timedOut ? `${tool} 超时被终止` : `${tool} 退出码 ${result.code}`
  return new TexError(`LaTeX 编译失败（${reason}）\n\n${log || '(没有诊断输出)'}`, { log, tex })
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function digest(parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(String(part)).update('\0')
  return hash.digest('hex')
}

/** 文档的默认文件名：优先 `\title{...}`，否则取正文第一行非命令文本。 */
function documentName(tex) {
  const title = /\\title\s*\{([^}]*)\}/.exec(tex)
  if (title && title[1].trim()) return slugify(title[1], 'document')
  const body = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(tex)
  const firstLine = (body?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('\\'))
  return slugify(firstLine || '', 'document')
}

function slugify(text, fallback = 'formula') {
  const slug = String(text ?? '')
    .replace(/\\[a-zA-Z]+/g, (command) => command.slice(1))
    .replace(/[{}$&_^~#%]/g, ' ')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || fallback
}

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function readIfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/** 作业目录根：可用 DSH_LATEX_CACHE 覆盖。 */
export function cacheRoot() {
  return process.env.DSH_LATEX_CACHE || path.join(os.tmpdir(), 'dsh-latex-cache')
}

function normalizeFormat(format, fallback) {
  const value = String(format ?? '').toLowerCase()
  return FORMATS.has(value) ? value : fallback
}

function normalizeEngine(engine, cjk) {
  const value = String(engine ?? '').toLowerCase()
  if (ENGINES.has(value)) return value
  if (value === 'latex') return 'latex'
  // 含中文时只有 xelatex/lualatex 能直接排，pdflatex 会缺字形
  return cjk ? 'xelatex' : 'pdflatex'
}

// ---------------------------------------------------------------------------
// 公式编译
// ---------------------------------------------------------------------------

/**
 * 编译一条公式。
 * @returns {Promise<{ ok: true, mode: 'math', format: string, engine: string, tex: string,
 *   files: Array<{ path: string, format: string, bytes: number }>, cached: boolean, durationMs: number }>}
 */
export async function compileMath(input) {
  const bin = requireBinary('latex')
  const math = stripMathDelimiters(input.source)
  if (!math) throw new TexError('LaTeX 源码为空。')
  if (/\\documentclass/.test(math)) {
    throw new TexError('mode:"math" 只接受公式片段；整篇文档请改用 mode:"document"。')
  }

  const format = normalizeFormat(input.format, 'svg')
  const dpi = Number.isFinite(input.dpi) ? Math.min(Math.max(Math.trunc(input.dpi), 96), 1200) : 300
  const tex = buildMathDocument({
    math,
    displayMode: input.displayMode !== false,
    preamble: input.preamble,
    color: input.color,
  })

  const hash = digest(['math', format, dpi, tex])
  const jobDir = path.join(cacheRoot(), hash.slice(0, 24))
  const startedAt = Date.now()

  await fsp.mkdir(jobDir, { recursive: true })
  await fsp.writeFile(path.join(jobDir, 'main.tex'), tex, 'utf8')

  const artifact = path.join(jobDir, `main.${format}`)
  let cached = false
  if (!input.force && (await exists(artifact))) {
    cached = true
  } else {
    const timeoutMs = input.timeoutMs ?? 120_000
    const latex = await run(
      bin,
      ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'main.tex'],
      { cwd: jobDir, timeoutMs },
    )
    if (latex.code !== 0) throw failure('latex', latex, tex)

    if (format === 'svg') {
      const svg = await run(
        requireBinary('dvisvgm'),
        ['--no-fonts', '--exact-bbox', '--bbox=min', '--output=main.svg', 'main.dvi'],
        { cwd: jobDir, timeoutMs },
      )
      if (svg.code !== 0) throw failure('dvisvgm', svg, tex)
    } else if (format === 'png') {
      const png = await run(
        requireBinary('dvipng'),
        ['-D', String(dpi), '-T', 'tight', '--truecolor', '--png', '-o', 'main.png', 'main.dvi'],
        { cwd: jobDir, timeoutMs },
      )
      if (png.code !== 0) throw failure('dvipng', png, tex)
    } else {
      const pdf = await run(requireBinary('dvipdfmx'), ['-q', '-o', 'main-raw.pdf', 'main.dvi'], {
        cwd: jobDir,
        timeoutMs,
      })
      if (pdf.code !== 0) throw failure('dvipdfmx', pdf, tex)
      const crop = await run(
        requireBinary('pdfcrop'),
        ['--margins', '2 2 2 2', 'main-raw.pdf', 'main.pdf'],
        { cwd: jobDir, timeoutMs },
      )
      if (crop.code !== 0) throw failure('pdfcrop', crop, tex)
    }
  }

  const target = input.output
    ? path.resolve(input.cwd ?? process.cwd(), input.output)
    : path.join(
        input.cwd ?? process.cwd(),
        '.dsh-latex',
        `${slugify(math)}-${hash.slice(0, 8)}.${format}`,
      )

  if (path.resolve(target) !== path.resolve(artifact)) {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(artifact, target)
  }
  const stat = await fsp.stat(target)

  return {
    ok: true,
    mode: 'math',
    format,
    engine: 'latex',
    tex,
    files: [{ path: target, format, bytes: stat.size }],
    cached,
    durationMs: Date.now() - startedAt,
  }
}

// ---------------------------------------------------------------------------
// 文档编译
// ---------------------------------------------------------------------------

/** 需要时跑一遍文献工具（bibtex / biber）。 */
async function runBibliography({ tex, jobDir, timeoutMs }) {
  const { found } = discoverBinaries()
  if (/\\addbibresource\s*\{/.test(tex) && found.biber) {
    const result = await run(found.biber, ['main'], { cwd: jobDir, timeoutMs })
    return { tool: 'biber', code: result.code }
  }
  if (/\\bibliography\s*\{/.test(tex) && found.bibtex) {
    const result = await run(found.bibtex, ['main'], { cwd: jobDir, timeoutMs })
    return { tool: 'bibtex', code: result.code }
  }
  return null
}

/**
 * 编译一整篇文档到 PDF。
 * @returns {Promise<{ ok: true, mode: 'document', format: 'pdf', engine: string, tex: string,
 *   files: Array<{ path: string, format: string, bytes: number }>, passes: object, cjk: boolean,
 *   durationMs: number }>}
 */
export async function compileDocument(input) {
  const source = String(input.source ?? '')
  if (!source.trim()) throw new TexError('LaTeX 源码为空。')

  const { tex, cjk } = buildDocument({
    source,
    preamble: input.preamble,
    documentClass: input.documentClass,
    classOptions: input.classOptions,
  })
  const engine = normalizeEngine(input.engine, cjk)
  const bin = requireBinary(engine)

  const hash = digest(['document', engine, tex])
  const jobDir = path.join(cacheRoot(), hash.slice(0, 24))
  const startedAt = Date.now()
  await fsp.mkdir(jobDir, { recursive: true })
  await fsp.writeFile(path.join(jobDir, 'main.tex'), tex, 'utf8')

  const timeoutMs = input.timeoutMs ?? 240_000
  const maxPasses = Math.min(Math.max(Math.trunc(input.maxPasses ?? 3), 1), 5)
  const passes = []

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const result = await run(
      bin,
      ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'main.tex'],
      { cwd: jobDir, timeoutMs },
    )
    const log = await readIfExists(path.join(jobDir, 'main.log'))
    passes.push({ pass, engine, code: result.code })

    if (result.code !== 0) {
      throw new TexError(
        `LaTeX 编译失败（${engine} 第 ${pass} 遍，退出码 ${result.code}）\n\n` +
          summarizeLog(log || `${result.stdout}\n${result.stderr}`),
        { log, tex },
      )
    }
    if (pass === 1) {
      const bibliography = await runBibliography({ tex, jobDir, timeoutMs })
      if (bibliography) passes.at(-1).bibliography = bibliography
    }
    if (!RERUN_PATTERN.test(log)) break
  }

  const pdfPath = path.join(jobDir, 'main.pdf')
  if (!(await exists(pdfPath))) {
    throw new TexError(`引擎 ${engine} 没有产出 main.pdf。`, { tex })
  }

  const cwd = input.cwd ?? process.cwd()
  const target = input.output
    ? path.resolve(cwd, input.output)
    : path.join(cwd, 'latex-out', `${documentName(tex)}-${hash.slice(0, 8)}.pdf`)

  const files = []
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.copyFile(pdfPath, target)
  const pdfStat = await fsp.stat(target)
  files.push({ path: target, format: 'pdf', bytes: pdfStat.size })

  // 把源码也放在 PDF 旁边，方便用户继续改
  if (input.saveSource !== false) {
    const texTarget = target.replace(/\.pdf$/i, '.tex')
    await fsp.writeFile(texTarget, tex, 'utf8')
    const texStat = await fsp.stat(texTarget)
    files.push({ path: texTarget, format: 'tex', bytes: texStat.size })
  }

  return {
    ok: true,
    mode: 'document',
    format: 'pdf',
    engine,
    tex,
    files,
    passes,
    cjk,
    durationMs: Date.now() - startedAt,
  }
}
