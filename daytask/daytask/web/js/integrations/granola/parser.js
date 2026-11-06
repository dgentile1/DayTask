// Granola enhanced-notes parser. Pure: text in, action items out.
// Every import source (manual paste today, any future adapter) feeds this.
//
// Handles the shapes Granola notes commonly take once copied out:
//   ### Action Items                  (or Next Steps / To-dos / Follow-ups, with or without #)
//   - Derrick: Send quote by Friday   inline "Name:" owner
//   - Derrick to update the AGS doc   "Name to / will / should ..."
//   - Review harness (Derrick)        trailing owner
//   - [Derrick] Call vendor           bracketed owner
//   **Derrick**  /  Derrick:          owner label, items below it
//   - Derrick                         owner bullet with indented items
//     - Order parts
//       - ask about lead time         deeper bullets become the task's note
//   - [ ] open / [x] done checkboxes; #work / #home tags set the list
import { addDays, onOrAfterWeekday, weekdayOf, ymdFromParts } from '../../core/dates.js';

const SECTION_RE = /^(action items?|action points?|next steps?|to-?dos?|todo list|tasks|follow[- ]?ups?|follow[- ]?up items?|my action items)$/i;
const OTHER_SECTION_RE = /^(summary|overview|notes|key (points|takeaways|decisions)|decisions?|discussion( points)?|takeaways|attendees|participants|agenda|open questions|questions|risks|context|background|updates?|highlights)$/i;
const BULLET_RE = /^(\s*)(?:[-*+•▪◦‣–]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const NAME = "[A-Z][\\w.'’-]*(?:\\s+[A-Z][\\w.'’-]*)?";
const NAMES = `${NAME}(?:\\s*(?:,|&|and|\\/)\\s*${NAME})*`;
const NOT_OWNERS = new Set(['note', 'notes', 'follow', 'follow-up', 'followup', 'todo', 'to-do', 'action',
  'next', 'next steps', 'update', 're', 'fyi', 'question', 'decision', 'task', 'priority', 'due',
  'owner', 'status', 'blocker', 'idea', 'reminder', 'important', 'context', 'everyone', 'team', 'all']);

function cleanInline(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function asHeading(line) {
  const h = line.match(HEADING_RE);
  if (h) return { level: h[1].length, text: cleanInline(h[2]).replace(/:$/, ''), markdown: true };
  if (BULLET_RE.test(line)) return null;
  const raw = line.trim();
  if (!raw || raw.length > 60) return null;
  const text = cleanInline(raw).replace(/:$/, '');
  const looksLikeLabel = /^\*\*.+\*\*:?$/.test(raw) || raw.endsWith(':') ||
    SECTION_RE.test(text) || OTHER_SECTION_RE.test(text);
  return looksLikeLabel ? { level: 7, text, markdown: false } : null;
}

function isOwnerLabel(text) {
  const t = text.replace(/:$/, '').trim();
  if (!t || NOT_OWNERS.has(t.toLowerCase())) return false;
  if (SECTION_RE.test(t) || OTHER_SECTION_RE.test(t)) return false;
  return new RegExp(`^@?${NAMES}$`).test(t) && t.split(/\s+/).length <= 4;
}

function stripCheckbox(text) {
  let m = text.match(/^\[( |x|X)\]\s*(.*)$/);
  if (m) return { checkbox: true, done: m[1] !== ' ', text: m[2] };
  m = text.match(/^([☐□])\s*(.*)$/);
  if (m) return { checkbox: true, done: false, text: m[2] };
  m = text.match(/^([☑✅✔✓])\s*(.*)$/);
  if (m) return { checkbox: true, done: true, text: m[2] };
  return { checkbox: false, done: false, text };
}

const indentOf = (ws) => ws.replace(/\t/g, '    ').length;

function nextNonBlank(lines, k) {
  for (let i = k + 1; i < lines.length; i++) if (lines[i].trim()) return lines[i];
  return null;
}

function findActionSections(lines) {
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const h = asHeading(lines[i]);
    if (!h || !SECTION_RE.test(h.text)) continue;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const h2 = asHeading(lines[j]);
      if (!h2) continue;
      if (h2.markdown && h2.level <= h.level) break;
      if (SECTION_RE.test(h2.text) || OTHER_SECTION_RE.test(h2.text)) break;
    }
    sections.push({ start: i + 1, end: j });
    i = j - 1;
  }
  return sections;
}

function parseSection(lines, checkboxOnly) {
  const items = [];
  let groupOwner = null;
  let groupIndent = -1; // -1: group came from a label line and lasts until the next label
  let current = null;
  let itemIndent = null;

  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (!line.trim()) continue;
    const bullet = line.match(BULLET_RE);

    if (!bullet) {
      const h = asHeading(line);
      const label = h ? h.text : cleanInline(line).replace(/:$/, '');
      if (h || (isOwnerLabel(label) && !checkboxOnly)) {
        if (isOwnerLabel(label)) { groupOwner = label.replace(/^@/, ''); groupIndent = -1; }
        current = null; itemIndent = null;
        continue;
      }
      const cb = stripCheckbox(cleanInline(line));
      if (checkboxOnly && !cb.checkbox) continue;
      current = { raw: cb.text, groupOwner, done: cb.done, noteLines: [] };
      itemIndent = 0;
      items.push(current);
      continue;
    }

    const indent = indentOf(bullet[1]);
    const cb = stripCheckbox(bullet[2].trim());
    const cleaned = cleanInline(cb.text);

    if (groupIndent >= 0 && indent <= groupIndent) { groupOwner = null; groupIndent = -1; }

    if (current && itemIndent !== null && indent > itemIndent) {
      if (cleaned) current.noteLines.push(cleaned);
      continue;
    }

    const next = nextNonBlank(lines, k);
    const nextBullet = next && next.match(BULLET_RE);
    if (!cb.checkbox && isOwnerLabel(cleaned) && nextBullet && indentOf(nextBullet[1]) > indent) {
      groupOwner = cleaned.replace(/:$/, '').replace(/^@/, '');
      groupIndent = indent;
      current = null; itemIndent = null;
      continue;
    }

    if (checkboxOnly && !cb.checkbox) { current = null; itemIndent = null; continue; }
    current = { raw: cleaned, groupOwner, done: cb.done, noteLines: [] };
    itemIndent = indent;
    items.push(current);
  }
  return items.filter((i) => i.raw);
}

function detectTitle(lines) {
  for (const line of lines) {
    const h = line.match(HEADING_RE);
    if (h) {
      const t = cleanInline(h[2]);
      if (!SECTION_RE.test(t) && !OTHER_SECTION_RE.test(t)) return t;
    }
  }
  for (const line of lines) {
    const t = cleanInline(line).replace(/:$/, '');
    if (t && !BULLET_RE.test(line) && t.length <= 120 && !SECTION_RE.test(t) && !OTHER_SECTION_RE.test(t)) return t;
  }
  return 'Granola meeting';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function resolveMonthDay(month, day, year, ref) {
  let y = year ? (year < 100 ? 2000 + year : year) : Number(ref.slice(0, 4));
  let d = ymdFromParts(y, month, day);
  if (!year && d < addDays(ref, -30)) d = ymdFromParts(y + 1, month, day);
  return d;
}

/** Pull a due phrase out of the text. Returns { text, dueDate|null }. */
export function extractDue(text, ref) {
  const rules = [
    [/\s*\b(?:by|due|before|on)\s+(?:the\s+)?(?:end of (?:the )?day|eod|cob|today|tonight)\b\.?/i, () => ref],
    [/\s*\b(?:by|due|before)?\s*tomorrow\b\.?/i, () => addDays(ref, 1)],
    [/\s*\b(?:by|due|before)\s+(?:the\s+)?(?:end of (?:the )?week|eow)\b\.?/i, () => onOrAfterWeekday(ref, 5)],
    [/\s*\b(?:by|due|before|on)\s+(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b\.?/i, (m) => {
      const target = onOrAfterWeekday(ref, WEEKDAYS[m[2].toLowerCase()]);
      return target === ref && m[1] ? addDays(ref, 7) : target;
    }],
    [/\s*\b(?:by|due|before|on)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b\.?/i,
      (m) => resolveMonthDay(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null, ref)],
    [/\s*\b(?:by|due|before|on)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b\.?/i,
      (m) => resolveMonthDay(MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2]), null, ref)],
    [/\s*\b(?:by\s+|due\s+)?next week\b\.?/i, () => addDays(ref, ((8 - weekdayOf(ref)) % 7) || 7)],
  ];
  for (const [re, fn] of rules) {
    const m = text.match(re);
    if (m) {
      const due = fn(m);
      if (/^\d{4}-\d{2}-\d{2}$/.test(due) && !Number.isNaN(Date.parse(due))) {
        return { text: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(), dueDate: due };
      }
    }
  }
  return { text, dueDate: null };
}

function extractOwner(text) {
  const tries = [
    [new RegExp(`^\\[(${NAMES})\\]\\s*[:\\-–—]?\\s*(.+)$`), 1, 2],
    [new RegExp(`^@(${NAMES})\\s*[:\\-–—]?\\s+(.+)$`), 1, 2],
    [new RegExp(`^(${NAMES})\\s*(?::|\\s[-–—])\\s+(.+)$`), 1, 2],
    [new RegExp(`^(${NAMES})\\s+(?:to|will|should|needs? to|is going to|has to|must)\\s+(.+)$`), 1, 2],
    [new RegExp(`^(.+?)\\s*[([]\\s*(?:[Oo]wner:\\s*)?@?(${NAMES})\\s*[)\\]]\\s*\\.?$`), 2, 1],
    [new RegExp(`^(.+?)\\s+[-–—]\\s+(?:[Oo]wner:\\s*)?@(${NAMES})\\s*\\.?$`), 2, 1],
    [new RegExp(`^(.+?)[,;]?\\s+[Oo]wner:\\s*(${NAMES})\\s*\\.?$`), 2, 1],
  ];
  for (const [re, ownerIdx, textIdx] of tries) {
    const m = text.match(re);
    if (m && !NOT_OWNERS.has(m[ownerIdx].toLowerCase())) return { owner: m[ownerIdx].trim(), text: m[textIdx].trim() };
  }
  const at = text.match(/(?:^|\s)@([A-Z][\w'’-]*)/);
  if (at) return { owner: at[1], text: text.replace(/(^|\s)@([A-Z][\w'’-]*)/, '$1$2').trim() };
  return { owner: null, text };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function ownerMatches(owner, aliases) {
  if (!owner) return false;
  return aliases.some((a) => new RegExp(`(^|[^\\w])${escapeRe(a)}($|[^\\w])`, 'i').test(owner));
}

// cyrb53: small, well-distributed 53-bit hash; plenty for de-duplicating one person's imports.
function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const normalizeForHash = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * @param {string} raw  pasted enhanced notes
 * @param {{ownerAliases?: string[], referenceDate: string, meetingTitle?: string, meetingDate?: string}} opts
 */
export function parseGranolaNotes(raw, opts) {
  const aliases = (opts.ownerAliases?.length ? opts.ownerAliases : ['Derrick']).map((a) => a.trim()).filter(Boolean);
  const ref = opts.referenceDate;
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const meetingTitle = (opts.meetingTitle || '').trim() || detectTitle(lines);

  let sections = findActionSections(lines);
  const foundSection = sections.length > 0;
  if (!foundSection) sections = [{ start: 0, end: lines.length, checkboxOnly: true }];

  const items = [];
  for (const sec of sections) {
    for (const it of parseSection(lines.slice(sec.start, sec.end), !!sec.checkboxOnly)) {
      let text = it.raw;
      let context = null;
      text = text.replace(/(^|\s)#(work|home)\b/gi, (_, sp, tag) => { context = tag.toLowerCase(); return sp; }).trim();
      const priority = /\b(urgent|asap|high priority|critical)\b|!high\b/i.test(text) ? 'high' : 'normal';
      text = text.replace(/\s*!high\b/i, '').trim();

      const found = extractOwner(text);
      const owner = found.owner || it.groupOwner || null;
      const due = extractDue(found.text, ref);
      let title = due.text.replace(/[\s.;,:]+$/, '').trim() || it.raw;
      title = title.charAt(0).toUpperCase() + title.slice(1);

      const isMine = ownerMatches(owner, aliases);
      const sharedWithOthers = isMine && owner && !aliases.some((a) => a.toLowerCase() === owner.toLowerCase());
      const noteParts = [`From Granola: ${meetingTitle}${opts.meetingDate ? ` (${opts.meetingDate})` : ''}`];
      if (sharedWithOthers) noteParts.push(`Assigned: ${owner}`);
      for (const n of it.noteLines) noteParts.push(`• ${n}`);

      items.push({
        title,
        note: noteParts.join('\n'),
        owner,
        isMine,
        done: it.done,
        dueDate: due.dueDate,
        priority,
        context,
        fingerprint: 'g_' + cyrb53(`${normalizeForHash(meetingTitle)}|${normalizeForHash(title)}`),
      });
    }
  }
  return { meetingTitle, foundSection, items };
}
