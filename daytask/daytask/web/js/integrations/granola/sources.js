// Registry of ways Granola notes can reach DayTask.
//
// Every source delivers the same payload — { text, meetingTitle?, meetingDate? } —
// to runGranolaImport(). Adding a real integration later means adding a source
// that produces that payload; the parser, de-duplication and task creation
// don't change.
//
// Status as built: no officially supported Granola integration is wired up.
// See README "Granola integration" for what was checked and the candidates.
export const GRANOLA_SOURCES = [
  {
    id: 'manual-paste',
    label: 'Manual import',
    automatic: false,
    description: 'Paste enhanced notes copied from Granola (desktop or phone).',
  },
  {
    id: 'desktop-host',
    label: 'Desktop app hand-off',
    automatic: true,
    description: 'Reserved: the Windows shell can post {type:"granolaNotes", text, title, date}. ' +
      'Nothing in the shell sends it yet.',
  },
];
