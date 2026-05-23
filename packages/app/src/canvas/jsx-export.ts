const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ATTR_RENAME: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  crossorigin: "crossOrigin",
  contenteditable: "contentEditable",
  enterkeyhint: "enterKeyHint",
  inputmode: "inputMode",
  spellcheck: "spellCheck",
  usemap: "useMap",
  ismap: "isMap",
  formaction: "formAction",
  formenctype: "formEnctype",
  formmethod: "formMethod",
  formnovalidate: "formNoValidate",
  formtarget: "formTarget",
  autocomplete: "autoComplete",
  autocapitalize: "autoCapitalize",
  autofocus: "autoFocus",
  rowspan: "rowSpan",
  colspan: "colSpan",
  frameborder: "frameBorder",
  allowfullscreen: "allowFullScreen",
  srcset: "srcSet",
  srcdoc: "srcDoc",
  hreflang: "hrefLang",
  referrerpolicy: "referrerPolicy",
  acceptcharset: "acceptCharset",
  cellpadding: "cellPadding",
  cellspacing: "cellSpacing",
  httpequiv: "httpEquiv",
  novalidate: "noValidate",
  datetime: "dateTime",
};

const BOOLEAN_ATTRS = new Set([
  "checked",
  "disabled",
  "selected",
  "readonly",
  "autofocus",
  "autoplay",
  "controls",
  "loop",
  "muted",
  "multiple",
  "required",
  "reversed",
  "hidden",
  "open",
  "novalidate",
  "default",
  "ismap",
  "playsinline",
  "allowfullscreen",
  "async",
  "defer",
]);

/**
 * CSS properties that have a standard Tailwind utility expression.
 * In tailwind mode these are stripped from inline style because the
 * className is assumed to carry the equivalent utility.
 */
const TAILWIND_MAPPABLE = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "color",
  "background-color",
  "width",
  "height",
  "display",
  "flex-direction",
]);

export type JsxMode = "tailwind" | "inline";

/**
 * GrapesJS strips `style=""` attributes when ingesting HTML and stores those
 * declarations in its CSS rule store keyed by the component's auto-assigned id.
 * For JSX export we need the styles back on the elements as inline `style="..."`,
 * so we parse `editor.getCss()` output, pluck per-id rules, and merge them into
 * the HTML before handing it to the JSX walker.
 *
 * Limitations: only simple `#id { ... }` selectors at the top level are
 * inlined. Compound selectors (`#id:hover`, descendant selectors) and any
 * rules nested inside at-rules (`@media`, `@supports`, `@container`,
 * `@layer`, etc.) are intentionally ignored — they have no unconditional
 * inline-style equivalent.
 */
export function mergeStylesIntoHtml(html: string, css: string): string {
  if (!css.trim()) return html;
  const idStyles = new Map<string, string>();
  // Walk top-level rules with explicit brace depth. A regex-only pass would
  // happily match a `#id { ... }` block sitting inside an `@media (...) { ... }`
  // wrapper and inline media-conditional styles at every viewport — see
  // QA-1 in docs/qa-followups.md.
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i]!)) i++;
    if (i >= css.length) break;
    const selStart = i;
    while (i < css.length && css[i] !== "{" && css[i] !== "}") i++;
    if (i >= css.length || css[i] === "}") break;
    const selector = css.slice(selStart, i).trim();
    i++; // consume opening {
    const bodyStart = i;
    let depth = 1;
    while (i < css.length && depth > 0) {
      const ch = css[i]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth > 0) i++;
    }
    const body = css.slice(bodyStart, i);
    i++; // consume closing }
    if (selector.startsWith("@")) continue;
    const decls = body.trim();
    if (!decls) continue;
    const idMatch = /^#([\w-]+)$/.exec(selector);
    if (!idMatch) continue;
    const id = idMatch[1]!;
    const existing = idStyles.get(id);
    idStyles.set(id, existing ? `${existing}; ${decls}` : decls);
  }
  if (idStyles.size === 0) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const [id, decls] of idStyles) {
    const el = doc.getElementById(id);
    if (!el) continue;
    const existing = el.getAttribute("style");
    el.setAttribute("style", existing ? `${existing}; ${decls}` : decls);
  }
  return doc.body.innerHTML;
}

export function htmlToJsx(html: string, mode: JsxMode = "tailwind"): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const children = Array.from(doc.body.childNodes).filter(
    (n) => !(n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() === ""),
  );

  const baseIndent = "    ";
  let inner: string;
  if (children.length === 0) {
    inner = `${baseIndent}<></>`;
  } else if (children.length === 1) {
    inner = renderNode(children[0]!, mode, baseIndent);
  } else {
    const childIndent = baseIndent + "  ";
    const parts = children
      .map((c) => renderNode(c, mode, childIndent))
      .filter((s) => s.length > 0);
    inner = `${baseIndent}<>\n${parts.join("\n")}\n${baseIndent}</>`;
  }

  return `export default function Component() {\n  return (\n${inner}\n  );\n}\n`;
}

function renderNode(node: Node, mode: JsxMode, indent: string): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").trim();
    if (!text) return "";
    return `${indent}${escapeJsxText(text)}`;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const attrs = renderAttributes(el, mode);

  if (VOID_ELEMENTS.has(tag)) {
    return `${indent}<${tag}${attrs} />`;
  }

  const childNodes = Array.from(el.childNodes).filter(
    (n) => !(n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() === ""),
  );

  if (childNodes.length === 0) {
    return `${indent}<${tag}${attrs}></${tag}>`;
  }

  // Text-only element → inline the text.
  if (childNodes.length === 1 && childNodes[0]!.nodeType === Node.TEXT_NODE) {
    const text = escapeJsxText((childNodes[0]!.textContent ?? "").trim());
    return `${indent}<${tag}${attrs}>${text}</${tag}>`;
  }

  const childIndent = indent + "  ";
  const rendered = childNodes
    .map((c) => renderNode(c, mode, childIndent))
    .filter((s) => s.length > 0)
    .join("\n");

  return `${indent}<${tag}${attrs}>\n${rendered}\n${indent}</${tag}>`;
}

function renderAttributes(el: Element, mode: JsxMode): string {
  const parts: string[] = [];

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    if (name === "style") continue; // handled below
    const renamed = ATTR_RENAME[name] ?? name;

    if (BOOLEAN_ATTRS.has(name)) {
      // For `checked=""`, `disabled=""`, etc., emit as bare JSX boolean.
      if (attr.value === "" || attr.value === name || attr.value === "true") {
        parts.push(renamed);
        continue;
      }
      // Non-trivial value: keep as string.
    }

    parts.push(`${renamed}="${escapeAttr(attr.value)}"`);
  }

  const rawStyle = el.getAttribute("style") ?? "";
  const entries = parseStyle(rawStyle);
  const kept = mode === "tailwind" ? entries.filter(([p]) => !TAILWIND_MAPPABLE.has(p)) : entries;

  if (kept.length > 0) {
    const body = kept
      .map(([prop, value]) => `${styleKey(prop)}: ${JSON.stringify(value)}`)
      .join(", ");
    parts.push(`style={{ ${body} }}`);
  }

  return parts.length === 0 ? "" : " " + parts.join(" ");
}

function parseStyle(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const decl of raw.split(";")) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const prop = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (!prop || !value) continue;
    out.push([prop, value]);
  }
  return out;
}

function styleKey(prop: string): string {
  if (prop.startsWith("--")) return JSON.stringify(prop);
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function escapeJsxText(text: string): string {
  // `{` and `}` start JSX expressions — escape into string literals.
  // `<` and `>` can appear in text but only if not forming a tag; safest to entity-encode.
  return text
    .replace(/[{}]/g, (c) => `{'${c}'}`)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
