/**
 * dsh-latex —— 让 harness 直接调用本机 LaTeX，并把公式编译成可展示的产物。
 *
 * 宿主侧只做两件事：
 * 1) 注册 `latex` 工具：公式 → SVG/PNG/PDF，整篇文档 → PDF；
 * 2) 注册一段 system prompt：告诉模型在回复里怎么写 LaTeX（聊天界面用 KaTeX 渲染）。
 *
 * 没有 client 部分：助手消息的 markdown 已经内置 KaTeX 渲染，
 * 编译产物通过工作区相对路径写进 markdown（图片/链接）即可展示。
 */
import path from 'node:path'

import { compileDocument, compileMath, TexError } from './lib/tex.js'

export const inject = ['tools', 'systemPrompt']

/** prompt 段落名称与排序（与其它内建段落不冲突）。 */
const SECTION_NAME = 'latex'
const SECTION_ORDER = 118

const PROMPT_TEXT = `## LaTeX

Math in your replies is rendered by the chat as compiled formula blocks (KaTeX). Write it directly, never as a code block:
- inline: \`$E = mc^2$\`
- display: \`$$\\int_0^1 f(x)\\,dx = \\frac{1}{3}$$\`
- \`\\(...\\)\` and \`\\[...\\]\` work too; text outside the delimiters is untouched.
Use a code block for LaTeX only when the user asks for the raw source.

Use the \`latex\` tool when you need the real TeX engine rather than the chat renderer:
- \`mode:"math"\` typesets one formula and writes an SVG (default), PNG or PDF file into the workspace.
- \`mode:"document"\` compiles a full document to PDF; pass either a complete .tex file or just the body, and xelatex is picked automatically when the source contains CJK text.
- Put packages a formula needs in \`preamble\` (e.g. \`\\usepackage{bm}\`), not inside \`source\`.
- A failed compile returns the LaTeX log excerpt; fix the reported line and compile again.`

const FORMAT_HINT = 'svg (vector, default), png (300 dpi raster), pdf'

/** 工具入参 schema。 */
const parameters = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      description:
        'LaTeX source. mode:"math": just the formula body, e.g. "\\\\frac{a}{b} = \\\\sum_{i=0}^{n} x_i" (outer $$ or \\\\[ \\\\] are stripped). mode:"document": a full file starting with \\\\documentclass, or just the body text.',
    },
    mode: {
      type: 'string',
      enum: ['math', 'document'],
      description: 'Compile one formula into an image (default), or a whole document into a PDF.',
    },
    format: {
      type: 'string',
      enum: ['svg', 'png', 'pdf'],
      description: `math only. Output format: ${FORMAT_HINT}.`,
    },
    engine: {
      type: 'string',
      enum: ['pdflatex', 'xelatex', 'lualatex'],
      description:
        'document only. Defaults to xelatex when the source contains CJK text, otherwise pdflatex.',
    },
    preamble: {
      type: 'string',
      description:
        'Extra preamble lines inserted before \\\\begin{document}, e.g. "\\\\usepackage{bm}". Packages needed by the formula belong here, not in `source`.',
    },
    displayMode: {
      type: 'boolean',
      description:
        'math only. Display style (default true) uses large operators and limits under/over; false matches inline text style.',
    },
    output: {
      type: 'string',
      description:
        'Output path, absolute or relative to the session working directory. Defaults to <cwd>/.dsh-latex/<slug>-<hash>.<ext> for math, <cwd>/latex-out/<name>-<hash>.pdf for documents.',
    },
    dpi: {
      type: 'number',
      description: 'math PNG only. Raster resolution, 96-1200 (default 300).',
    },
    documentClass: {
      type: 'string',
      description:
        'document only. Class used when wrapping a bare body; default "article", or "ctexart" when CJK text is detected.',
    },
    classOptions: {
      type: 'string',
      description: 'document only. Options for \\documentclass, default "11pt,a4paper".',
    },
    color: {
      type: 'string',
      description:
        'math only. Ink color, e.g. "#1f2937" or "blue" (default black). Pass a light color when the image will sit on a dark background.',
    },
    maxPasses: {
      type: 'number',
      description:
        'document only. Compile passes, 1-5 (default 3). Extra passes run only when the log asks for a rerun.',
    },
    force: {
      type: 'boolean',
      description: 'math only. Recompile even when an identical build is already cached.',
    },
  },
  required: ['source'],
  additionalProperties: false,
}

/** 工具返回值 schema。 */
const outputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    mode: { type: 'string' },
    format: { type: 'string' },
    engine: { type: 'string' },
    cwd: { type: 'string' },
    markdown: { type: 'string' },
    texSource: { type: 'string' },
    cached: { type: 'boolean' },
    cjk: { type: 'boolean' },
    durationMs: { type: 'number' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          relative: { type: 'string' },
          format: { type: 'string' },
          bytes: { type: 'number' },
        },
        required: ['path'],
      },
    },
  },
  required: ['ok', 'mode', 'files'],
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${bytes} B`
}

/** 把执行结果整理成对模型友好、对 UI 可展示的形状。 */
function decorate(result, cwd) {
  const relative = (file) => path.relative(cwd, file).split(path.sep).join('/')
  const files = result.files.map((file) => ({ ...file, relative: relative(file.path) }))
  const primary = files[0]
  const markdown = !primary
    ? ''
    : result.mode === 'math'
      ? `![](${primary.relative})`
      : `[${path.basename(primary.path)}](${primary.relative})`

  return {
    ok: true,
    mode: result.mode,
    format: result.format,
    engine: result.engine,
    files,
    cwd,
    markdown,
    texSource: result.tex,
    cached: result.cached,
    cjk: result.cjk,
    durationMs: result.durationMs,
  }
}

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/** Tool 的执行上下文里没有 cwd，用 workingDirectory 服务解析会话目录。 */
async function resolveCwd(ctx, exec, fallback) {
  const directories = safeGet(ctx, 'workingDirectory')
  if (directories?.ensure && exec?.agent) {
    try {
      const dir = await directories.ensure(exec.agent, exec.signal)
      if (typeof dir === 'string' && dir) return dir
    } catch {
      // 目录服务不可用时退回进程工作目录
    }
  }
  return fallback
}

/** TexError 里带了日志摘要，直接透传给模型即可。 */
function toToolError(error) {
  if (error instanceof TexError) {
    return new Error(error.message)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function readOptions(config) {
  const source = config && typeof config === 'object' ? config : {}
  const pick = (value, allowed, fallback) =>
    typeof value === 'string' && allowed.includes(value) ? value : fallback
  return {
    tool: source.tool !== false,
    promptSection: source.promptSection !== false,
    defaultFormat: pick(source.defaultFormat, ['svg', 'png', 'pdf'], 'svg'),
    defaultEngine: pick(source.defaultEngine, ['pdflatex', 'xelatex', 'lualatex'], undefined),
    dpi: Number.isFinite(source.dpi) ? source.dpi : 300,
    timeoutMs: Number.isFinite(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : undefined,
  }
}

export function apply(ctx, config = {}) {
  const options = readOptions(config)

  // 注意：不要把 register() 的 disposer 交给 ctx.effect —— loader 在 apply() 返回后
  // 立刻提交 entry fiber 并执行 disposer，会把刚注册的工具/段落静默注销。
  if (options.promptSection && ctx.systemPrompt?.section) {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: PROMPT_TEXT,
    })
  }

  if (!options.tool || !ctx.tools?.register) return

  ctx.tools.register({
    name: 'latex',
    description:
      'Compile real LaTeX with the local TeX Live installation.\n' +
      'mode:"math" (default) typesets one formula and writes a standalone image (SVG default, or PNG/PDF) ' +
      'into the workspace; the result carries the absolute path and a ready-to-paste Markdown reference.\n' +
      'mode:"document" compiles a whole document to PDF: pass either a complete .tex file or just the body, ' +
      'and the tool wraps it (article, or ctexart when CJK text is detected) and picks xelatex automatically for CJK, ' +
      'otherwise pdflatex. Runs extra passes and bibtex/biber only when the log asks for it.\n' +
      'Math images use black ink by default; pass `color` for dark backgrounds. ' +
      'Returns { ok, mode, format, files, texSource, markdown, durationMs }. On failure it raises an error ' +
      'carrying the LaTeX log excerpt.',
    parameters,
    timeoutMs: 300_000,
    presentCall(args) {
      const mode = args?.mode === 'document' ? 'document' : 'math'
      const snippet = String(args?.source ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      return {
        card: 'generic',
        title: `latex ${mode}: ${snippet || '(empty)'}`,
        kind: 'other',
        rawInput: snippet,
      }
    },
    output: {
      schema: outputSchema,
      render(_args, value) {
        const head = `latex ${value.mode}/${value.format} · ${value.engine}` +
          `${value.cached ? ' · cached' : ''} · ${value.durationMs} ms`
        const files = (value.files ?? []).map(
          (file) => `- ${file.path} (${formatBytes(file.bytes)})`,
        )
        const tail = value.markdown
          ? [
              '',
              value.mode === 'math'
                ? `Markdown image reference (renders in chat): \`${value.markdown}\``
                : `Markdown file link: \`${value.markdown}\``,
            ]
          : []
        return [{ type: 'text', text: [head, ...files, ...tail].join('\n') }]
      },
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const cwd = await resolveCwd(ctx, exec, process.cwd())
      const timeoutMs = options.timeoutMs

      try {
        if (input.mode === 'document') {
          const result = await compileDocument({
            source: input.source,
            preamble: input.preamble,
            documentClass: input.documentClass,
            classOptions: input.classOptions,
            engine: input.engine ?? options.defaultEngine,
            maxPasses: input.maxPasses,
            output: input.output,
            cwd,
            timeoutMs,
          })
          return decorate(result, cwd)
        }

        const result = await compileMath({
          source: input.source,
          preamble: input.preamble,
          displayMode: input.displayMode,
          color: input.color,
          format: input.format ?? options.defaultFormat,
          dpi: input.dpi ?? options.dpi,
          force: input.force === true,
          output: input.output,
          cwd,
          timeoutMs,
        })
        return decorate(result, cwd)
      } catch (error) {
        throw toToolError(error)
      }
    },
  })
}
