// scripts/dashboard/public/shared/i18n.mjs — every word the page shows, in each UI language.
// The words are data: locales/strings.json (English, the source of truth) and one
// locales/strings.<lang>.json per other language, same keys. Status words in English are
// vocab.mjs labels; the other languages translate them as `status.<key>`.
// A string is a template: `{name}` a var; `{name?A|B}` A when the var is truthy, else B;
// `{name=value?A|B}` A when it equals value (plurals: `{n=1?session|sessions}`). A and B
// may nest templates; `|B` may be omitted. Pure: imports only shared data.

import { STATUS } from './vocab.mjs';
import en from './locales/strings.json' with { type: 'json' };
import zh from './locales/strings.zh.json' with { type: 'json' };

export const LANGS = ['en', 'zh'];

const TABLES = {
  en: { ...Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [`status.${k}`, v.label])), ...en },
  zh,
};

/** The language a Telegram user's `language_code` asks for: any zh* reads Chinese, else English. */
export const defaultLang = (code) => (/^zh/i.test(String(code ?? '')) ? 'zh' : 'en');

/** The index of the `}` closing the `{` at `open`, nesting counted. */
function closing(s, open) {
  for (let i = open, depth = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  throw new Error(`i18n: unclosed { in ${JSON.stringify(s)}`);
}

/** `s` split at its top-level `|` (one outside any nested `{}`). */
function branches(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === '|' && depth === 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  return [s, ''];
}

/** One `{...}` body against `vars`. */
function field(body, vars) {
  const m = /^(\w+)(?:=([^?]*))?\?([\s\S]*)$/.exec(body);
  if (!m) return String(vars[body] ?? '');
  const [, name, value, rest] = m;
  const [yes, no] = branches(rest);
  const hit = value === undefined ? Boolean(vars[name]) : String(vars[name]) === value;
  return render(hit ? yes : no, vars);
}

/** A template with its vars filled in. */
export function render(s, vars = {}) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') { out += s[i]; continue; }
    const end = closing(s, i);
    out += field(s.slice(i + 1, end), vars);
    i = end;
  }
  return out;
}

/** `key` in `lang`, English when that language lacks it, the key itself when nothing has it. */
export function t(key, lang = 'en', vars = {}) {
  const v = TABLES[lang]?.[key] ?? TABLES.en[key];
  return v === undefined ? key : render(v, vars);
}

/** Every key the table defines (for the tests: each has every language). */
export const i18nKeys = () => Object.keys(TABLES.en);
