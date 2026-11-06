// Turns parsed Granola items into tasks. Storage is injected so this stays
// independent of Supabase and of where the notes came from.
import { parseGranolaNotes } from './parser.js';

/**
 * @param {{text: string, meetingTitle?: string, meetingDate?: string, force?: string[]}} input
 *   force: fingerprints the user chose to add even though they aren't assigned to them
 * @param {{aliases: string[], today: string,
 *          existingFingerprints: (fps: string[]) => Promise<Set<string>>,
 *          addTask: (task: object) => Promise<object>,
 *          logImport: (fingerprint: string, taskId: string) => Promise<void>}} deps
 */
export async function runGranolaImport(input, deps) {
  const parsed = parseGranolaNotes(input.text, {
    ownerAliases: deps.aliases,
    referenceDate: input.meetingDate || deps.today,
    meetingTitle: input.meetingTitle,
    meetingDate: input.meetingDate,
  });
  const force = new Set(input.force || []);
  const seen = await deps.existingFingerprints(parsed.items.map((i) => i.fingerprint));
  const added = [];
  const skipped = [];

  for (const item of parsed.items) {
    let reason = null;
    if (seen.has(item.fingerprint)) reason = 'duplicate';
    else if (item.done) reason = 'done';
    else if (!item.isMine && !force.has(item.fingerprint)) reason = item.owner ? 'other' : 'unassigned';
    if (reason) { skipped.push({ item, reason }); continue; }

    const task = await deps.addTask({
      title: item.title,
      note: item.note,
      dueDate: item.dueDate, // a deadline only if the notes gave one
      priority: item.priority,
      context: item.context, // null => lands in "Needs sorting" and asks work or home
      source: 'granola',
      sourceRef: item.fingerprint,
    });
    await deps.logImport(item.fingerprint, task.id);
    seen.add(item.fingerprint);
    added.push(task);
  }
  return { meetingTitle: parsed.meetingTitle, foundSection: parsed.foundSection, added, skipped };
}
