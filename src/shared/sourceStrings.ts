import { parseExpression, type ParserOptions } from "@babel/parser";
import ts from "typescript";

export type SourceStringSpan = { after: number; closed: boolean };
export type SourceStringCache = Map<number, Map<number, SourceStringSpan>>;

const scriptOptions: ParserOptions = {
  plugins: ["typescript"], attachComment: false, errorRecovery: true,
  sourceType: "script", strictMode: false,
  allowYieldOutsideFunction: true,
  allowNewTargetOutsideFunction: true, allowSuperOutsideMethod: true,
};

// These diagnostics need an enclosing module/class to resolve; neither repairs
// token structure. All syntax/recovery diagnostics still reject the boundary.
const enclosingContextDiagnostics = new Set(["InvalidPrivateFieldResolution", "ImportMetaOutsideModule"]);

function validatedTemplate(input: string, jsx: boolean) {
  // A snippet can come from a script where await is an identifier or from an
  // async/module expression where it is an operator. Try only those two contexts
  // against the same candidate prefix, without changing the boundary or tokens.
  for (const allowAwaitOutsideFunction of [false, true]) {
    try {
      const expression = parseExpression(input, { ...scriptOptions, allowAwaitOutsideFunction,
        plugins: jsx ? ["typescript", "jsx"] : ["typescript"] });
      if (expression.type !== "TemplateLiteral" || expression.start !== 0 || expression.end !== input.length) continue;
      if (expression.errors?.some(error => !enclosingContextDiagnostics.has(error.reasonCode))) continue;
      return expression;
    } catch (error) {
      if (error instanceof RangeError) throw error;
    }
  }
  return undefined;
}

function templateCandidate(input: string, jsx: boolean): number | undefined {
  const source = ts.createSourceFile("fragment.ts", input, ts.ScriptTarget.Latest, false,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const pending: ts.Node[] = source.statements.length ? [source.statements[0]] : [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.getStart(source) !== 0) continue;
    if (ts.isTemplateExpression(node)) {
      const tail = node.templateSpans.at(-1)?.literal;
      if (tail && ts.isTemplateTail(tail) && !tail.isUnterminated && tail.end === node.end
        && input[tail.getStart(source)] === "}" && input[node.end - 1] === "`") return node.end;
    }
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return undefined;
}

function scriptTemplateEnd(text: string, start: number, limit: number,
  spans: Map<number, SourceStringSpan>): SourceStringSpan {
  // Plain templates (including Markdown code spans) need no expression parser.
  let interpolation = false;
  for (let cursor = start + 1; cursor < limit; cursor++) {
    if (text[cursor] === "\\") { cursor++; continue; }
    if (text[cursor] === "`") {
      const result = { after: cursor + 1, closed: true };
      spans.set(start, result);
      return result;
    }
    if (text.startsWith("${", cursor)) { interpolation = true; break; }
  }
  const input = text.slice(start, limit);
  // Logs may contain arbitrary text after a complete template. A recovering
  // parser proposes its boundary; Babel independently proves only that prefix.
  // Geometric windows bound total scanned input instead of reparsing the whole
  // remaining document for each sibling template. Nested spans share a cache.
  let size = Math.min(256, input.length);
  parseTemplate: for (; interpolation;) {
    for (const jsx of [false, true]) {
      try {
        const after = templateCandidate(input.slice(0, size), jsx);
        if (after === undefined) continue;
        const expression = validatedTemplate(input.slice(0, after), jsx);
        if (!expression) continue;
        const pending: unknown[] = [expression];
        while (pending.length) {
          const value = pending.pop();
          if (Array.isArray(value)) {
            for (let index = value.length - 1; index >= 0; index--) pending.push(value[index]);
            continue;
          }
          if (!value || typeof value !== "object") continue;
          const node = value as Record<string, unknown>;
          if ((node.type === "TemplateLiteral" || node.type === "StringLiteral" || node.type === "DirectiveLiteral")
            && typeof node.start === "number" && typeof node.end === "number") {
            const from = start + node.start, after = start + node.end, quote = text[from];
            if (after <= limit && after > from && (quote === "`" || quote === '"' || quote === "'")
              && text[after - 1] === quote) spans.set(from, { after, closed: true });
          }
          for (const [key, child] of Object.entries(node)) {
            if (!["loc", "extra", "errors", "comments", "tokens"].includes(key)) pending.push(child);
          }
        }
        const result = spans.get(start);
        if (result) return result;
      } catch (error) {
        // A stack limit cannot be repaired by growing the same input.
        if (error instanceof RangeError) break parseTemplate;
        // Incomplete or unsupported source has no proven closing delimiter.
      }
    }
    if (size === input.length) break;
    size = Math.min(size * 2, input.length);
  }
  const incomplete = { after: limit, closed: false };
  spans.set(start, incomplete);
  // Failed nested expressions share the same unreadable suffix. Mark starts
  // once so subsequent credential/parameter probes cannot repeatedly parse it.
  for (let cursor = start; cursor < limit; cursor++) {
    if ((text[cursor] === "`" || text[cursor] === '"' || text[cursor] === "'") && !spans.has(cursor))
      spans.set(cursor, incomplete);
  }
  return spans.get(start)!;
}

// Swift interpolation owns balanced expressions, nested strings and comments.
// JavaScript/TypeScript templates delegate their expression grammar to Babel.
export function sourceStringEnd(text: string, start: number, limit = text.length,
  cache: SourceStringCache = new Map()): SourceStringSpan {
  const spans = cache.get(limit) ?? new Map<number, SourceStringSpan>();
  cache.set(limit, spans);
  const known = spans.get(start);
  if (known) return known;
  if (text[start] === "`") return scriptTemplateEnd(text, start, limit, spans);
  type Frame = { quote: string; start: number } | { close: string; expectValue: boolean; memberName?: boolean };
  const stack: Frame[] = [{ quote: text[start], start }];
  const identifier = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/uy;
  let cursor = start + 1;
  while (cursor < limit && stack.length) {
    const frame = stack.at(-1)!, character = text[cursor];
    if ("quote" in frame) {
      if (frame.quote === '"' && text.startsWith("\\(", cursor)) {
        stack.push({ close: ")", expectValue: true }); cursor += 2; continue;
      }
      if (character === "\\") { cursor += 2; continue; }
      if (character === frame.quote) {
        stack.pop();
        spans.set(frame.start, { after: cursor + 1, closed: true });
        const parent = stack.at(-1);
        if (parent && "expectValue" in parent) parent.expectValue = false;
      }
      cursor++;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      frame.memberName = false;
      const nested = spans.get(cursor) ?? (character === "`" ? scriptTemplateEnd(text, cursor, limit, spans) : undefined);
      if (nested) { cursor = nested.after; frame.expectValue = false; continue; }
      stack.push({ quote: character, start: cursor }); cursor++; continue;
    }
    if (text.startsWith("//", cursor)) {
      while (cursor < limit && text[cursor] !== "\n" && text[cursor] !== "\r") cursor++;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      let depth = 1; cursor += 2;
      while (cursor < limit && depth) {
        if (text.startsWith("/*", cursor)) { depth++; cursor += 2; }
        else if (text.startsWith("*/", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      continue;
    }
    if (character === "/" && frame.expectValue) {
      let characterClass = false; cursor++;
      while (cursor < limit) {
        const character = text[cursor++];
        if (character === "\\") { cursor++; continue; }
        if (character === "[") characterClass = true;
        else if (character === "]") characterClass = false;
        else if (character === "/" && !characterClass) break;
      }
      frame.expectValue = false;
      continue;
    }
    identifier.lastIndex = cursor;
    const name = identifier.exec(text);
    if (name) {
      cursor = Math.min(identifier.lastIndex, limit);
      frame.expectValue = !frame.memberName && /^(?:return|throw|try|await|in)$/.test(name[0]);
      frame.memberName = false;
      continue;
    }
    if (character === ".") {
      frame.memberName = true; frame.expectValue = false; cursor++; continue;
    }
    if (!/\s/.test(character)) frame.memberName = false;
    if ("([{".includes(character)) stack.push({ close: ")]}"["([{".indexOf(character)], expectValue: true });
    else if (character === frame.close) {
      stack.pop();
      const parent = stack.at(-1);
      if (parent && "expectValue" in parent) parent.expectValue = false;
    } else if (character === "!" && !frame.expectValue && text[cursor + 1] !== "=") {
      // Swift's force unwrap is postfix.
    } else if (!/\s/.test(character)) frame.expectValue = !/[\d.]/.test(character);
    cursor++;
  }
  const result = { after: Math.min(cursor, limit), closed: stack.length === 0 };
  for (const frame of stack) if ("quote" in frame) spans.set(frame.start, result);
  return result;
}
