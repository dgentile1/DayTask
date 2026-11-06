// Daily (repeating) tasks. Stored on the task as `repeat`:
//   { days: 'all' | 'work', doneOn: 'YYYY-MM-DD' | null, subsOn: 'YYYY-MM-DD' | null }
// A daily task is never "completed": checking it off records today's date, so it's
// unchecked again tomorrow. Its subtasks also start fresh each day.
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    days: r.days === 'work' ? 'work' : 'all',
    doneOn: YMD.test(r.doneOn ?? '') ? r.doneOn : null,
    subsOn: YMD.test(r.subsOn ?? '') ? r.subsOn : null,
  };
}

export const isDaily = (t) => !!t?.repeat;

/** Shows today: every day, or only on work days. */
export const dailyShowsToday = (t, state) => isDaily(t) && (t.repeat.days === 'all' || state.isWorkday);

export const dailyDoneToday = (t, today) => isDaily(t) && t.repeat.doneOn === today;

/** Today's view of a daily task's subtasks: ticks from an earlier day don't count. */
export function dailySubtasks(t, today) {
  const subs = t.subtasks || [];
  if (!isDaily(t) || t.repeat.subsOn === today) return subs;
  return subs.map((s) => (s.done ? { ...s, done: false } : s));
}

/** Default repeat for a new daily task in a list: Work repeats on work days, Home every day. */
export const defaultRepeat = (context) => ({ days: context === 'work' ? 'work' : 'all', doneOn: null, subsOn: null });
