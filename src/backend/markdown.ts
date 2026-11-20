// Markdown: the subset the board renders, ported from the GPUI
// board. Pure functions: parsing inline markup and blocks,
// measuring text height, and rendering HTML for notes.

import type { Block, Segment } from "bowerbird-plugin-api";

// --- Markdown (same subset as the GPUI board) ---------------------------


export function parseInline(s: string): Segment[] {
  const out: Segment[] = [];
  let i = 0, buf = "";
  const flush = (extra: Partial<Segment> = {}) => {
    if (buf) { out.push({ text: buf, ...extra }); buf = ""; }
  };
  // Deliberately flat: markers stay literal when unclosed, and
  // "2 * 3 * 4" is not emphasis. Backslash escapes one character.
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
    const rest = s.slice(i);
    const tryMark = (mark: string, extra: Partial<Segment>): boolean => {
      if (!rest.startsWith(mark)) return false;
      const end = s.indexOf(mark, i + mark.length);
      if (end === -1) return false;
      const inner = s.slice(i + mark.length, end);
      if (!inner || inner.includes("\n")) return false;
      flush(); out.push({ text: inner, ...extra }); i = end + mark.length; return true;
    };
    if (tryMark("**", { bold: true })) continue;
    if (tryMark("~~", { strike: true })) continue;
    if (tryMark("`", { code: true })) continue;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
    if (link) { flush(); out.push({ text: link[1], link: true }); i += link[0].length; continue; }
    if (c === "*" && rest.length > 1) {
      const end = s.indexOf("*", i + 1);
      if (end !== -1 && end > i + 1) {
        const inner = s.slice(i + 1, end);
        if (!inner.includes(" ") || inner.trim().length > 0) {
          // Only treat a lone *...* as italic when it is not part of
          // an arithmetic-looking expression: require the char before
          // and after to not both be digits/spaces in "a * b" form.
          const before = i === 0 ? " " : s[i - 1];
          const after = end + 1 >= s.length ? " " : s[end + 1];
          if (!(before.trim() !== "" && after.trim() !== "" && /\d/.test(before) && /\d/.test(after))) {
            flush(); out.push({ text: inner, italic: true }); i = end + 1; continue;
          }
        }
      }
    }
    buf += c; i++;
  }
  flush();
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      blocks.push({ Code: { lines: codeLines } });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ Heading: { level: heading[1].length, segments: parseInline(heading[2]) } }); i++; continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { blocks.push({ Bullet: { segments: parseInline(bullet[1]) } }); i++; continue; }
    const ordered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) { blocks.push({ Ordered: { n: parseInt(ordered[1], 10), segments: parseInline(ordered[2]) } }); i++; continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { blocks.push({ Quote: { segments: parseInline(quote[1]) } }); i++; continue; }
    blocks.push({ Paragraph: { segments: parseInline(line) } });
    i++;
  }
  return blocks;
}

// The height reserved at a card's bottom for its bottom
// row (checklist progress): the row itself is 24 tall,
// plus 12 of padding between the row and the card's
// contents, so the progress never sits on the text.
export const CARD_DECORATIONS_H = 36;

export function estimateTextHeight(text: string, fontSize: number, width: number): number {
  const blocks = parseMarkdown(text);
  // Blank lines are vertical space, in the editor and in the
  // render alike: the textarea shows them, and the renderer
  // turns each one into an empty paragraph. Count them here,
  // or pressing Enter never grows the note.
  const blankLines = text.split("\n").filter((l) => l.trim() === "").length;
  if (blocks.length === 0 && blankLines === 0) return 48;
  // The note body's content width: the card width less its
  // 14px padding on each side.
  const charsFit = Math.max(20, (width - 28) / (fontSize * 0.55));
  const lineH = fontSize * 1.55;
  // The note body's top padding (14); the card reserves the
  // checklist row (36) separately, on top of this. Every
  // block is a paragraph, heading, code block or quote with
  // a 6px bottom margin, so each one adds its lines plus 6.
  // These must match the note-body CSS exactly — the old
  // 1.62 line-height and 4px gap overestimated by a little
  // per line, so the empty space at a note's bottom grew
  // with every line typed.
  let h = 14;
  blocks.forEach((block) => {
    if ("Heading" in block) {
      const len = block.Heading.segments.reduce((a, s) => a + s.text.length, 0);
      const lines = Math.max(1, Math.ceil(len / charsFit));
      const factor = block.Heading.level === 1 ? 1.5 : block.Heading.level === 2 ? 1.25 : 1.1;
      h += lines * fontSize * factor * 1.3 + 6;
    } else if ("Code" in block) {
      h += Math.max(1, block.Code.lines.length) * fontSize * 0.9 * 1.55 + 16 + 6;
    } else {
      const segs = ("Bullet" in block ? block.Bullet.segments : "Ordered" in block ? block.Ordered.segments : "Quote" in block ? block.Quote.segments : block.Paragraph.segments);
      const len = segs.reduce((a, s) => a + s.text.length, 0);
      h += Math.max(1, Math.ceil(len / charsFit)) * lineH + 6;
    }
  });
  h += blankLines * (lineH + 6);
  return Math.max(48, h);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Notes render with link URLs intact: parseInline drops URLs (it is
// only used for height estimation, where text length is what matters),
// so rendering walks the raw lines with a link-aware pass instead.
export function renderMarkdownHtml(text: string, _baseSize: number): string {
  return renderNoteHtml(text);
}

// Syntax highlighting for fenced code blocks in text cards.
// A small built-in tokenizer, no dependency: a handful of
// languages, everything else gets strings, comments and
// numbers. Colours are the app's own palette, kept muted.
interface CodeLang {
  keywords: string[];
  lineComments: string[];
  blockComments: [string, string][];
  strings: string[];
  tripleStrings?: string[];
  tagNames?: boolean;
  cssProps?: boolean;
}
const JS_KEYWORDS = ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "new", "typeof", "import", "from", "export", "default", "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break", "continue", "this", "super", "null", "undefined", "true", "false", "of", "in", "instanceof", "void", "delete", "yield", "static", "get", "set"];
const CODE_LANGS: Record<string, CodeLang> = {
  js: { keywords: JS_KEYWORDS, lineComments: ["//"], blockComments: [["/*", "*/"]], strings: ["\"", "'", "`"] },
  ts: { keywords: [...JS_KEYWORDS, "interface", "type", "enum", "namespace", "implements", "readonly", "private", "public", "protected", "abstract", "declare"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: ["\"", "'", "`"] },
  python: { keywords: ["def", "return", "if", "elif", "else", "for", "while", "class", "import", "from", "as", "pass", "None", "True", "False", "and", "or", "not", "in", "is", "lambda", "with", "try", "except", "finally", "raise", "global", "nonlocal", "assert", "del", "yield", "async", "await"], lineComments: ["#"], blockComments: [], strings: ["\"", "'"], tripleStrings: ["\"\"\"", "'''"] },
  json: { keywords: ["true", "false", "null"], lineComments: [], blockComments: [], strings: ["\""] },
  sh: { keywords: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "in", "echo", "cd", "export", "local", "read", "exit"], lineComments: ["#"], blockComments: [], strings: ["\"", "'"] },
  css: { keywords: [], lineComments: [], blockComments: [["/*", "*/"]], strings: ["\"", "'"], cssProps: true },
  html: { keywords: [], lineComments: [], blockComments: [["<!--", "-->"]], strings: ["\"", "'"], tagNames: true },
};
const CODE_LANG_ALIASES: Record<string, string> = {
  javascript: "js", typescript: "ts", py: "python", bash: "sh", shell: "sh", xml: "html",
};
function highlightCode(code: string, langRaw: string): string {
  const key = CODE_LANG_ALIASES[langRaw.toLowerCase()] ?? langRaw.toLowerCase();
  const lang: CodeLang = CODE_LANGS[key] ?? { keywords: [], lineComments: ["//", "#"], blockComments: [["/*", "*/"]], strings: ["\"", "'"] };
  const span = (cls: string, s: string): string => `<span class="tok-${cls}">${escapeHtml(s)}</span>`;
  let out = "", i = 0;
  const n = code.length;
  while (i < n) {
    if (lang.tripleStrings) {
      const t = lang.tripleStrings.find((q) => code.startsWith(q, i));
      if (t) { const end = code.indexOf(t, i + 3); const j = end === -1 ? n : end + 3; out += span("str", code.slice(i, j)); i = j; continue; }
    }
    const bc = lang.blockComments.find(([o]) => code.startsWith(o, i));
    if (bc) { const end = code.indexOf(bc[1], i + bc[0].length); const j = end === -1 ? n : end + bc[1].length; out += span("com", code.slice(i, j)); i = j; continue; }
    const lc = lang.lineComments.find((c) => code.startsWith(c, i));
    if (lc) { let j = code.indexOf("\n", i); if (j === -1) j = n; out += span("com", code.slice(i, j)); i = j; continue; }
    const q = lang.strings.find((qq) => code[i] === qq);
    if (q) {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === q) { j++; break; }
        if (code[j] === "\n" && q !== "`") break;
        j++;
      }
      out += span("str", code.slice(i, j)); i = j; continue;
    }
    if (lang.tagNames && code[i] === "<") {
      const m = /^<\/?([a-zA-Z][\w-]*)/.exec(code.slice(i));
      if (m) { out += escapeHtml(code.slice(i, i + m[0].length - m[1].length)) + span("kw", m[1]); i += m[0].length; continue; }
    }
    const hex = /^0x[0-9a-fA-F]+/.exec(code.slice(i));
    if (hex && (i === 0 || !/[\w$]/.test(code[i - 1]))) { out += span("num", hex[0]); i += hex[0].length; continue; }
    const num = /^\d+(?:\.\d+)?/.exec(code.slice(i));
    if (num && (i === 0 || !/[\w$]/.test(code[i - 1]))) { out += span("num", num[0]); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][\w$-]*/.exec(code.slice(i));
    if (id) {
      const word = id[0];
      if (lang.keywords.includes(word)) out += span("kw", word);
      else if (lang.cssProps && code[i + word.length] === ":") out += span("kw", word);
      else if (code[i + word.length] === "(") out += span("fn", word);
      else out += escapeHtml(word);
      i += word.length; continue;
    }
    out += escapeHtml(code[i]); i++;
  }
  return out;
}

// A checklist line: a bullet or dash, then [ ] or [x].
// The state lives in the markdown text itself, so a toggle
// or a progress change is a text edit and one undo step.
// One shape, used by toggleTaskLine, checklistProgress and
// setChecklistDone, so the count always agrees with what
// a click toggles.
const TASK_LINE = /^([-*]\s+)\[([ xX])\](\s+.*|)$/;

// Flip one checklist line ([ ] <-> [x]); the state lives in
// the markdown text itself, so a toggle is a text edit and
// one undo step. Returns the new line, or null when the
// line is not a task.
export function toggleTaskLine(line: string): string | null {
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  return `${m[1]}[${m[2] === " " ? "x" : " "}]${m[3]}`;
}

// The checklist progress of a note's text: how many task
// lines are done over how many there are. Null when the
// text holds no task lines. The core renders it under the
// card, and plugins read and set it through api.cards.
export function checklistProgress(text: string): { done: number; total: number } | null {
  let total = 0;
  let done = 0;
  for (const line of text.split("\n")) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    total += 1;
    if (m[2] !== " ") done += 1;
  }
  return total === 0 ? null : { done, total };
}

// Set the progress of a note's text: the first `done`
// task lines are checked, the rest unchecked. Returns the
// new text, or null when the text holds no task lines.
// `done` is clamped to the number of task lines.
export function setChecklistDone(text: string, done: number): string | null {
  const lines = text.split("\n");
  const taskCount = lines.filter((line) => TASK_LINE.test(line)).length;
  if (taskCount === 0) return null;
  const want = Math.max(0, Math.min(done, taskCount));
  let seen = 0;
  const next = lines.map((line) => {
    const m = TASK_LINE.exec(line);
    if (!m) return line;
    seen += 1;
    return `${m[1]}[${seen <= want ? "x" : " "}]${m[3]}`;
  });
  return next.join("\n");
}

function renderNoteHtml(text: string): string {
  // Render blocks, keeping link URLs: walk the raw lines and render
  // inline markup with a link-aware pass instead of parseInline's
  // text-only segments.
  const inlineHtml = (s: string): string => {
    let out = "", i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
      if (link) { out += `<a href="#" data-url="${escapeHtml(link[2])}">${escapeHtml(link[1])}</a>`; i += link[0].length; continue; }
      const bold = /^\*\*([^*]+)\*\*/.exec(rest);
      if (bold) { out += `<strong>${escapeHtml(bold[1])}</strong>`; i += bold[0].length; continue; }
      const code = /^`([^`]+)`/.exec(rest);
      if (code) { out += `<code>${escapeHtml(code[1])}</code>`; i += code[0].length; continue; }
      const strike = /^~~([^~]+)~~/.exec(rest);
      if (strike) { out += `<s>${escapeHtml(strike[1])}</s>`; i += strike[0].length; continue; }
      const ital = /^\*([^*]+)\*/.exec(rest);
      if (ital) { out += `<em>${escapeHtml(ital[1])}</em>`; i += ital[0].length; continue; }
      if (s[i] === "\\" && i + 1 < s.length) { out += escapeHtml(s[i + 1]); i += 2; continue; }
      out += escapeHtml(s[i]); i++;
    }
    return out;
  };
  const lines = text.split("\n");
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // A blank line is vertical space, not nothing: the
    // textarea shows it and the height estimate counts it,
    // so the render must too, or the note's text would
    // overflow the card it was sized for. An empty
    // paragraph is one line-height plus the usual 6px
    // bottom margin, exactly what the estimate counts.
    if (line.trim() === "") { html += `<p>&nbsp;</p>`; i++; continue; }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      html += `<pre>${highlightCode(codeLines.join("\n"), lang)}</pre>`;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { const lvl = heading[1].length; html += `<h${lvl}>${inlineHtml(heading[2])}</h${lvl}>`; i++; continue; }
    const task = /^[-*]\s+\[([ xX])\](?:\s+(.*))?$/.exec(line);
    if (task) {
      const checked = task[1] !== " ";
      const label = task[2] === undefined ? "" : `<span>${inlineHtml(task[2])}</span>`;
      html += `<p class="task"><input type="checkbox" data-action="toggle-task" data-line="${i}"${checked ? " checked" : ""}>${label}</p>`;
      i++; continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { html += `<p>• ${inlineHtml(bullet[1])}</p>`; i++; continue; }
    const ordered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) { html += `<p>${ordered[1]}. ${inlineHtml(ordered[2])}</p>`; i++; continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { html += `<blockquote>${inlineHtml(quote[1])}</blockquote>`; i++; continue; }
    html += `<p>${inlineHtml(line)}</p>`; i++;
  }
  return html;
}
