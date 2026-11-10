# DayTask

A daily task list for one person, on a Windows desktop (with an always-on-top toggle) and a phone, kept in sync. Work and home lists follow your work hours, and action items from Granola meeting notes can be imported.

Everything here runs on free tiers and personal accounts only: no company servers, no company sign-in.

## Assumptions

1. Single user (you). No sharing or multi-user features.
2. Desktop is Windows 10/11 (WebView2 runtime is already present on both). Phone is iPhone or Android; the phone app is the web app added to the home screen.
3. The phone must work on its own (weekends, desktop off), so sync goes through a hosted backend, not your PC.
4. A due date is a **deadline** and is optional. A task is listed from the moment it's added until it's checked off, whatever its due date, and due dates never change on their own.
5. Work hours are a single same-day block (for example 08:00 to 17:00). Overnight shifts aren't supported.
6. After work hours the home list goes on top and the work list waits below it for the next work day (Friday evening means Monday). This replaces the first version's behaviour of rewriting work tasks' due dates.
7. Due-date reminders: tasks within the number of days set in Settings (default 3) are marked and listed in a banner at the top of Tasks. The banner can be hidden and shown again like the task note. Once hidden it stays hidden (through minimizing and restoring, switching away and back, or a new day) until you press Show or close and reopen the app. Settings, Due date reminders chooses whether it starts Shown (default) or Hidden until you press Show each time the app opens; the choice syncs to all devices and takes effect on the next open. The desktop app shows a Windows notification each time it is opened, and at no other time. The phone shows reminders when you open the app; it can't notify while closed (see limitations).
8. "Notes" are the note on each task, editable at any time. There are no free-standing notes.
9. Subtasks are a one-level checklist inside a task. Each has a title, an optional due date and High/Normal importance (they share the task's Work/Home list). A subtask's due date counts for reminders and the calendar. Checking the last one offers to finish the task rather than finishing it automatically.
10. Priority only affects where a new task is first placed (high goes ahead of same-day normal). After that, your drag order wins.
11. Changing a task's due date keeps its manual position; changing work/home places it in the other list by due date.
12. You're on Granola's free plan and there is no verified automated Granola hookup (see below), so import is manual for now.

## Stack and trade-offs

| Part | Choice | Why | Trade-off |
|---|---|---|---|
| UI | One static web app (vanilla JS modules, no build step) | Same code on desktop and phone; nothing to compile | Hand-rolled rendering instead of a framework |
| Sync and storage | Supabase free tier (Postgres + auth + realtime) | Always on, free, phone works with the PC off, live updates in about a second | External account; free projects pause after about 7 days with no activity (daily use avoids it; unpausing is one click). Works offline: changes queue on the device and sync when back online |
| Hosting | GitHub Pages or Cloudflare Pages (free) | Static files, HTTPS (needed for the phone home-screen app) | GitHub Pages on a free account needs a public repo; the code holds no secrets (the anon key is public by design and row-level security guards the data). Use Cloudflare Pages for a private repo |
| Desktop | WinForms + WebView2 shell (about 150 lines of C#) | `TopMost` is one property in WinForms; tiny install; your stack | Windows-only. Electron or Tauri would be cross-platform but add a 100+ MB runtime or a Rust toolchain for one window flag |
| Drag and drop | SortableJS | Works with touch on phones; native HTML drag and drop doesn't | One small CDN dependency |

**Always-on-top.** A browser tab can't float above other windows, which is why the desktop is a native shell around the web app rather than a bookmark. The shell stores the setting and window position in `%APPDATA%\DayTask\desktop-state.json`. Toggle it with the Keep on top button in the header or Ctrl+Shift+T.

**Phone sync.** Both devices read and write the same Supabase tables and subscribe to row changes. Writes are last-write-wins per field, which is fine for one person.

**Offline.** The app works fully offline on phone and desktop:
- A service worker (`web/sw.js`) keeps the app's files on the device, network-first so updates arrive whenever you're online, falling back to the stored copy offline or when the network takes over 3.5 seconds. Libraries and the font are bundled in `web/vendor/` and `web/fonts/`, so nothing loads from other sites.
- Your tasks and settings are kept on the device (`localStorage`), and every change (add, edit, check off, reorder, subtasks, settings, Granola imports) is saved there first and queued in an outbox (`web/js/core/outbox.js`, `web/js/data/sync.js`). The queue is sent to Supabase in order as soon as there's a connection, survives closing the app, and is retried every 15 seconds.
- Only changed fields are sent, so an offline edit to a task's title and a phone edit to its note both survive. Edits to one task are combined, adding then deleting a task offline sends nothing, and a task whose save reply was lost isn't duplicated (tasks get their ID on the device).
- The header shows a short status under the connection dot, level with the work-hours line, in a fixed spot so the header never changes height: "Offline · 3 saved" (point at it for the full explanation), or "Syncing 2" if sending takes longer than about a second. Quick syncs, like a normal check-off, show nothing.
- The first time on each device, and signing in, need a connection. Signing out with unsynced changes asks first, because they would be lost. The desktop app works offline once it has opened once online.

## Granola integration: what was checked

What I could verify while building this:

- Claude's connector directory search returned no Granola connector (that search covers only part of the directory).
- I had no web access while building, so I could not read Granola's current docs or pricing page.

What I believe is true as of mid-2026, **unverified and possibly out of date**:

- Granola has an MCP server for AI assistants and integrations such as Zapier, Slack, Notion and some CRMs. Most automation features appear to be on paid plans.
- I'm not aware of a documented public REST API or webhooks for personal use.
- Granola's desktop app keeps a local cache file. Reading it works today for some people, but it is undocumented, can change without notice, and only exists on the computer running Granola.

So the build ships a **clearly labelled manual import** and isolates it so a real integration can be added later:

- `web/js/integrations/granola/parser.js` turns pasted notes into action items (pure function, unit-tested).
- `importer.js` decides what to add (assigned to you, open, not already imported) and creates tasks through injected storage functions.
- `sources.js` lists how notes can arrive. Every source hands the same payload `{ text, meetingTitle, meetingDate }` to `runGranolaImport()`.
- The desktop shell bridge already accepts `{ type: "granolaNotes", text, title, date }`, so a future local-cache reader in the C# shell would need no web changes.

To check before building an automatic source:

1. In Granola's settings and help center, look for an API, webhooks, or a Zapier "new note" trigger available on your plan.
2. If a Zapier (or similar) trigger exists, add a Supabase Edge Function that receives it and calls the same parser; the parser is plain JavaScript and runs there unchanged.
3. If only the local cache is available, add a reader to the desktop shell that posts `granolaNotes` to the web view, and accept that it may break on Granola updates.

### How the import reads notes

It looks for an action-items heading (Action Items, Next Steps, To-dos, Follow-ups, with or without `#`) and reads bullets until the next section. Owners are recognised as `Derrick: …`, `Derrick to …`, `… (Derrick)`, `[Derrick] …`, `@Derrick`, a `**Derrick**` label, or a `- Derrick` bullet with items indented under it. Indented sub-bullets become the task's note, along with the meeting title. Checked-off items (`[x]`) are skipped. `by Friday`, `tomorrow`, `by 11/5`, `by Nov 5`, `EOD` and `next week` set the due date. `#work` or `#home` sets the list; otherwise the task lands in **Needs sorting** and asks Work or Home. Items for other people or with no owner are listed with an Add anyway button. Re-pasting the same notes doesn't create duplicates. If there's no action-items heading, only checkbox lines are read. The names that count as you are set in Settings.

## Project structure

```
daytask/
  README.md
  package.json                  test script (node --test)
  supabase/schema.sql           tables, row-level security, realtime
  web/                          the app (deploy this folder)
    index.html  styles.css  manifest.webmanifest  icon.svg
    config.js                   your Supabase URL and anon key
    sw.js                       service worker: app files on the device for offline use
    vendor/                     bundled supabase-js 2.45.4 and SortableJS 1.15.2
    fonts/                      bundled Atkinson Hyperlegible (SIL OFL)
    js/
      app.js                    UI: views, events, rendering
      host.js                   bridge to the desktop shell
      core/dates.js             date helpers (pure)
      core/schedule.js          work hours, due status, ordering (pure)
      core/subtasks.js          subtask checklist helpers (pure)
      core/colors.js            colour contrast for custom colours (pure)
      core/daily.js             daily (repeating) task rules (pure)
      core/timer.js             time tracking rules (pure)
      theme.js                  applies theme and colours to the page
      data/store.js             Supabase reads, writes, realtime
      data/sync.js              offline-first layer: device copy, outbox, sending
      core/outbox.js            outbox rules (pure)
      integrations/granola/
        parser.js               notes to action items (pure)
        importer.js             action items to tasks
        sources.js              import sources registry
  desktop/                      Windows always-on-top shell
    DayTask.Desktop.csproj  Program.cs  MainForm.cs  DesktopSettings.cs  desktop.json
  tests/
    schedule.test.js  granola.test.js     unit tests
    e2e/run.py  e2e/fake-supabase.js      browser test, two devices
```

## Setup

### 1. Supabase (free)
1. Create a project at supabase.com with a personal account.
2. SQL Editor, New query: paste code in file `supabase/schema.sql`, Run.
3. Authentication, Users, Add user: your email and a password (tick auto-confirm).
4. Authentication settings: turn off new sign-ups so no one else can register.
5. Project Settings, API: copy the Project URL and the anon public key.

**Upgrading an existing database:** run the files in `supabase/migrations/` you haven't run yet, in order, in the SQL Editor: `002_optional_due_date.sql` (optional due dates), `003_subtasks.sql` (subtasks), `004_start_date.sql` (start dates), `005_daily_tasks.sql` (daily tasks), `006_status.sql` (status), `007_time_tracking.sql` (time tracking: a new table), `008_subtask_timers.sql` (subtask timers) and `009_app_list.sql` (App list). Running the updated `schema.sql` again does the same thing.

### 2. Configure
Put both values in `web/config.js`.

### 3. Run locally
Requires Node 20 or newer.
```
npm test          # unit tests
npm run serve     # http://localhost:5173
```
Open it, sign in, add a task. (ES modules need a web server; opening `index.html` as a file won't work.)

### 4. Host it (free)
Pick one:
- **Cloudflare Pages** (works with a private repo): connect the repo, no build command, output directory `web`.
- **GitHub Pages** (public repo on a free account): Pages can only serve the repo root or `/docs`, so rename `web/` to `docs/`, then Settings, Pages, deploy from branch, folder `/docs`. Update the paths in `tests/e2e/run.py` if you rename.

Note the resulting `https://` URL.

### 5. Phone
Open the URL in Safari (iPhone) or Chrome (Android), sign in, then Share, Add to Home Screen (or the browser menu's Install app).

### 6. Desktop
Requires the .NET 10 SDK (or change `TargetFramework` to `net8.0-windows`).
1. Set `appUrl` in `desktop/desktop.json` to your hosted URL (or `http://localhost:5173/` while testing).
2. `cd desktop` then `dotnet run`, or `dotnet publish -c Release -r win-x64 --self-contained false` and pin `DayTask.exe` to the taskbar or Startup folder.
3. Sign in once; the session is kept in `%LOCALAPPDATA%\DayTask\WebView2`.

## How the scheduling rules work

All rules live in `web/js/core/schedule.js`:

- **Pinned header:** the header (date, work hours, timer, sync status) and the tab bar stay at the top while the page scrolls. Jumping to a task or a field lands below them, and on phones that draw under the status bar that strip is filled with the header colour.
- **Mode:** work during work hours on work days, home otherwise. The header band is blue in work mode and green in home mode; the matching list is shown first, the other below it.
- **What's listed:** every open task, from when it's added until it's checked off. Due dates are never changed automatically.
- **Due status:** overdue, due today, due within the reminder window (Settings, 0 to 30 days), or later. The first three appear in the banner and, on desktop, in a Windows notification each time the app is opened.
- **App list:** a third list next to Work and Home, for ideas and updates for this app. Choose **App** in the add form, a task's editor or the "Which list?" question on imported items. App tasks get their own section below Work and Home (shown once it has tasks) and work like other tasks (notes, status, subtasks, due and start dates, priority, Calendar with their own dot, reminders, carry-over timed like Home, dragging), except there are no timers and no Repeats. Moving a task to App turns off its repeat and stops its timer. The App colour is in Settings, Colors.
- **Time tracking:** each task row has a ▶ button showing today's time on that task. Pressing it starts a timer (the button becomes ■ and counts up), and starting a task again adds to its time. **Several timers can run at once**: if any timer is running, ▶ opens a popup listing the running timers with a Stop box ticked beside each; untick any you want to keep running alongside (the button reads "Stop 1 and start" or "Start alongside"), or Cancel. A running task's ■ stops just that timer. The header shows the newest timer with "+N" when more are running; tapping it stops the timer, or with several running lists them to stop one or all. Overlapping time counts for each task; checking off, deleting or dropping a task into another stops its timer. Each timer still running when its work day ends (the moment the lists switch to Home, so Extend day and Switch to Home count) stops at exactly that time, even if the app was closed then; one started after work hours stops at the end of the next work day. Time is saved per day in `time_entries`; a timer that crosses midnight is split between the days. The **Time** tab shows a Monday-to-Sunday week with ‹ › to look back: each day's tasks and totals, the week total and totals by task. Tap a time to correct it (h:mm, 90m or 1.5h); the difference is kept as one correction per task per day, so the timer records aren't rewritten. "+ Add time" logs time you didn't time. **Subtasks have their own timers**: each open subtask in the list has its own ▶ button and its own time, which is not added to its task's time. Only one timer runs at a time across tasks and subtasks, so starting either stops the other. Checking off or deleting a subtask stops its timer. On the Time tab subtasks are listed indented under their task with their own (correctable) times, and "+ Add time" can pick a subtask; day and week totals include task and subtask time. Timers work offline and sync like everything else. Logic: `web/js/core/timer.js` (pure).
- **Status:** a **Status** toggle sits with the other options in the add form, the task editor and each subtask row. Off (the default), there's no Status box and the name field keeps its full width; on, a Status box appears right of the name (which shrinks), ready to type. Turning the toggle off, or clearing the text, removes the status; anything that already has a status shows its box and the toggle on. A status (up to 60 characters, e.g. "Waiting on parts") shows as a pill to the right of the name in the list, level with it; long ones are shortened to fit with the full text on hover. Leave the box blank and nothing shows. Tap a pill to jump to its Status box. Suggestions offer In progress, Waiting, Blocked, On hold, Needs review and any statuses you've used. A task's status is kept if it's dropped into another task as a subtask. The Status colour is in Settings, Colors.
- **Daily tasks:** tasks that repeat. Turn on **Daily** in the add form, or set **Repeats** in a task's editor to Every day or Work days only (new daily Work tasks default to work days, Home to every day). They appear in a **Daily** section at the top of the Work or Home list, shown only once there's at least one, with "N of M done today". Checking one off crosses it off for today only; it's unchecked again the next day, and its subtasks start fresh each day too. Work-days-only tasks rest on days off. They can be reordered by dragging within Daily, have no due or start date, and stay out of reminders and carry-over. On the Calendar they appear on every day they repeat from the day they were added (one Daily-coloured dot per day), in a Daily block at the top of the day's Work or Home list; they can be checked off there only on today, and other days show them unchecked with fresh subtasks. Setting Repeats back to "Doesn't repeat" returns a task to the normal list. The Daily colour is in Settings, Colors.
- **Extending the work day:** near the end of work hours an **Extend day** button appears in the header beside "Work hours until…", with a picker for the default amount, common amounts or a custom number of minutes. Pressing it pushes today's work end out (the header says "(extended)") and keeps Work on top; the button comes back near the new end, so a day can be extended more than once. If it isn't pressed, Home goes on top when the button's time is up and the button disappears. Settings, End of the work day sets how many minutes before work ends the button appears (default 15), how long it stays up before switching (default 15; with the two equal the switch is exactly at your end time, longer keeps Work on top a little past it), and the default amount (default 30 minutes). Carry-over and the next-work-day Calendar preview use the actual switch time. The extension syncs to all devices. Opening the app while an extension is what's keeping Work on top asks whether to **Keep working until** the new time or **Switch to Home tasks** (which ends the work day there).
- **Pushing the end out after the switch to Home:** if the day has already switched to Home and a change of settings puts you back in work hours (a later work end, a longer button window, or the same change made on your other device), a popup asks "Your work day now ends at 6:00 PM. Move your Work tasks back to the top?" with **Move Work to the top** (also Enter) or **Stay on Home**. When the change was just saved on this device, the × in the corner, "Cancel, I entered the wrong time" and Escape all undo the save: the previous hours are put back and Settings keeps what you typed so you can fix it. When it came from your other device, × just closes it and Work stays on top. A later work end also replaces an earlier "Switch to Home tasks" for that day. Pulling the end in never asks.
- **Reset lists for today's hours:** a button in Settings, End of the work day. It clears today's Extend day or Switch to Home choice so which list is on top (and when today's work day ends) follows the work hours exactly, saving any unsaved changes in the form first. A line above it says what's on top right now and why. Your own task order and due dates aren't touched.
- **Carried over:** a task not checked off in time is pinned to the top of its list, marked "Carried over" with its overdue label. Work tasks carry over when work hours end on their due date (or, for a due date on a non-work day, once that day has passed); home tasks once their due date has passed. A task also carries over if one of its unchecked subtasks is past due. Carried-over tasks are ordered most overdue first, then by your drag order; other tasks can't be dragged above them. Dropping a task on the first regular task's top edge, or on the bottom edge of the last carried-over task, puts it first among the regular tasks (its position is worked out from same-group neighbours only, since carried-over tasks sit on top whatever their place in your order). It continues every day until the item is checked off or its due date is moved later. Due dates are never changed automatically.
- **Placement:** a new task goes before the first task in its list that is due later (tasks with no due date count as latest; high priority goes ahead of same-day normal). Dragging sets a position between its neighbours and never re-sorts anything else.
- **Lists:** Work, Home, and Needs sorting are separate; drag works only within a list.
- **Subtasks:** open a task to add, rename, remove or drag-reorder its subtasks (Enter adds one and keeps the cursor there for the next), and to set each one's due date and High priority. Open subtasks with a due date appear in the due-soon banner and the desktop notification (shown with their task's name), sorted by date with High first on the same day, and put their task on the calendar on that date. The "Add a subtask" row has its own optional due date, so a subtask can be dated as it's added. A task with no due date of its own shows its next subtask deadline in the list ("Next: Order parts, due tomorrow").
- **Subtask order:** subtasks are kept in due-date order so the next one to finish is directly under the task: open dated subtasks earliest first, then undated ones, then checked-off ones at the bottom. Subtasks that share a date (or are all undated) keep the order you drag them into; dragging is only possible within such a group. Setting or changing a date moves the subtask to its place straight away; unchecking one puts it back with its date. The "Next:" line on an undated task is always the first dated subtask in this order.
- **Turning a task into a subtask:** drag a task by its handle and drop it on the middle of another task (the row shows "Add as subtask"). A popup asks first and says what carries over; Cancel or Escape changes nothing. If confirmed, it becomes a subtask keeping its due date and priority, its own subtasks follow it (subtasks are one level deep), and its note is appended to the other task's note. Undo in the toast restores it. Dropping near a row's top or bottom edge still just reorders. The "Add as subtask" label floats over the row rather than sitting in it, so a long task name never wraps and grows the row while you're hovering (which would move its middle under the pointer). In the list they appear under the task with checkboxes; the progress pill (for example 1/3) folds them away and back, remembered per device. They're stored on the task row, so they sync with it.
- **Colours:** Settings, Colors lets you pick Match device, Light or Dark, and a colour for Work, Home, App, Daily tasks, Status, High priority, Due soon, Due today, Overdue and Needs sorting. Changes preview immediately and are kept on all devices once saved (leaving Settings without saving discards them). The header band uses your exact colour with black or white text, whichever reads better; where a colour is used as text it is nudged darker (light theme) or lighter (dark theme) just enough to reach 4.5:1 contrast. The last colours are cached on each device so the app opens in them straight away. Logic: `web/js/core/colors.js` (pure) and `web/js/theme.js`.
- **Start dates:** a task can have an optional start date, the day it joins your Tasks list. On the Calendar tab the add form has a Starts field filled with the selected day (blank for today or earlier), so tasks added there appear on your list on that day; Due stays optional and separate. Until then the task is only on the Calendar (on its start day), and the Tasks page notes "N tasks start later" with a link to the Calendar. From its start day it behaves like any other task. Set, change or clear it in the task editor; clearing it puts the task on your list now.
- **Calendar:** a toggle on the Calendar picks "Due date only" (a task appears on its due date) or "Every day until due" (it appears on each day from the day it was added through its due date; an overdue open task keeps appearing through today). A task with no due date of its own comes along every day until it's checked off: it's always on today in both modes (and in "Every day until due" on each day since it was added). Once work hours end (or on a day off), the next work day previews tomorrow's list: it also shows every unfinished task with no due date and every carried-over task. Friday evening and weekends preview Monday. The selected day's list uses the same lists and order as the Tasks page, and can be dragged the same way. The choice is saved with your settings.

## Test plan

### Automated
- `npm test`: 62 unit tests for several timers at once (alongside, stopping chosen ones, overlapping time), the App list (its section after Work and Home, carry-over like Home), time tracking (subtask timers kept apart from their task's, midnight and daylight-saving splits, switching and resuming timers, corrections, adding time, typing durations, Monday weeks, stopping at the end of work hours incl. extensions and days off, stable ids when two devices split the same timer), time entries in the offline outbox, statuses (cleaning, subtasks, kept when nested, suggestions), daily tasks (their section, done-for-today, work-days-only, fresh subtasks, their Calendar days, staying out of reminders, their colour), extending the work day (button timing, automatic switch, repeated and custom extensions, the reopen question), the offline outbox (combining, cancelling, replaying, which errors retry), the service worker covering every app file and the page loading nothing from other sites, colour contrast and theme settings, turning a task into subtasks, subtask date ordering, carry-over (work vs home timing, weekends, subtasks, ordering, drag groups), the next-subtask-due lookup, subtasks (including their due dates and importance in reminders and the calendar), work-hour modes, weekends, both calendar modes, due status and the reminder window, the due-soon list, placement by due date and priority (including no due date), manual-order keys, list order, Granola owner formats, notes, checkboxes, due phrases, aliases, and import de-duplication.
- `tests/e2e/offline.py` (22 checks, including the Offline status sitting level with the work-hours line and the header height staying fixed): a real service worker on localhost; the desktop goes offline, reloads, adds, checks off, renames, adds a subtask, adds and deletes a task and changes settings; closes and reopens offline; the phone edits the same task meanwhile; then it reconnects. It checks that nothing reaches Supabase while offline, the queue survives reopening, both devices' edits are kept, and nothing is duplicated.
- `tests/e2e/run.py`: a real browser with a desktop page (with a stand-in for the Windows shell) and a phone page sharing one fake backend, clock pinned to Monday 07:30, 10:00 and 17:30 Central. It checks 325 behaviours, including: optional due dates, far-off tasks listed immediately, due badges, the Windows notification on every open (and never from adding a task, restoring the window or a new day), the Shown/Hidden-on-open option (saved, applied on next open on desktop and phone, Show still works, notification unaffected), the banner staying hidden through minimize/restore and a new day until Show or a reopen, the reminder setting, overdue display, drag reorder, phone sync, Granola import, subtasks (rapid entry, checking off, folding, rename, remove, drag reorder, phone sync, the all-done prompt, subtask due dates and High in the list, banner, phone and calendar), unsaved Settings surviving a sync update, dragging a task onto another (hover highlight, the popup, Cancel, Escape, Add, Undo), the header keeping its height while a change syncs (and a quick sync showing no message), dragging a task into the first spot right below the carried-over ones (both drop points, and it stays after reopening), carry-over across Monday work hours, Monday evening and Tuesday morning (pinned on top, most overdue first, home vs work timing, no dragging above it, re-dating and checking off end it), subtask due date when adding, subtask date ordering (dates applied, same-date dragging, blocked cross-date dragging, checked-off to the bottom, unchecking, phone order), the Next line on undated tasks, colours (live preview, discard, save, phone sync, readable text for pale or bright picks, forced dark theme, reset), no sideways scrolling in the narrow window, the App list (no section until it has tasks, App in the add form with the Daily toggle hidden, its section after Work and Home, no timers on App tasks or their subtasks, no Repeats in the editor, subtasks, reordering by dropping on the top edge of a long-named task with the row keeping its size, moving a daily task with a running timer to App, App in "Which list?", Calendar with its own dot, not offered for logging time, colour), the pinned header and tabs (still at the top when scrolled to the bottom, a focused field not hidden under them, tabs usable while scrolled, on every tab), "By task" staying open through a refresh, several timers (▶ starts at once when nothing runs; otherwise the popup lists running timers ticked to stop, unticking starts alongside, both clocks count, header +1, listing and stopping one or all from the header, a task's ■ stops only its timer, Cancel), time tracking (subtask timers: their own buttons and times, the task's time untouched, switching between a task and its subtasks, checking a subtask off stops it, Time tab lines under their task, totals including them, correcting a subtask's time, week totals; start, live clock on the task and in the header, starting another stops the first, resuming adds on, checking off stops it, the Time tab's days, totals and week total, correcting a time, adding time, totals by task, earlier weeks, stopping at the end of work hours, stopped at 5:00 PM even when the app was closed overnight, a timer started after hours keeps running, stopping from the header), statuses (Status toggles: no box until on, names full width until then, box beside the name and focused when on, off removes the status, subtask toggles fitting on one line; set while adding, the add form box hiding again, nothing shown when blank, the box always in the editor and right of the name on the same line for tasks and subtasks, no sideways scrolling on the phone, pill to the right of and level with the name, tapping it to edit, long ones shortened without sideways scrolling, subtask statuses, suggestions, phone sync, clearing, colour), daily tasks (no section until one exists, adding with the Daily toggle, Work and Home sections above the normal tasks, checking off for today, progress, not in Done today, dragging, no dropping into another task, subtasks, Repeats in the editor both ways, phone, on the Calendar (today with progress and check-off, other days unchecked and disabled with fresh subtasks, a single dot, work-days-only on Saturday, not before they were added), colour, unchecked the next day, work-days-only on Saturday), extending the work day (button near the end, default and custom amounts, Work kept on top, the button returning, the reopen popup's two choices, the automatic switch, the settings and a longer button window, pushing the end out after the switch to Home on this device and from the other one, both popup choices, a later end replacing an earlier switch, the popup's ×, Cancel link and Escape undoing a mistaken time while keeping it in the form, the Reset lists button clearing a switch or an extension and saving unsaved hours first), start dates (Calendar fills Starts, saved with or without Due, shown on the start day, off the Tasks list until then with a note and link, clearing it in the editor, joining the list on the day), calendar scheduling, both calendar modes and the calendar list matching the Tasks order, and after-hours ordering with no due date changed. Setup instructions are at the top of the file.

### Manual (about 15 minutes, with real Supabase)
1. Desktop: add three work tasks and one home task; drag to reorder; restart the shell and confirm the order and window position held.
2. Toggle Keep on top; click another app and confirm DayTask stays above it; Ctrl+Shift+T toggles it back.
3. Phone: confirm the same lists in the same order. Check off a task; it should move to Done today on the desktop within a couple of seconds. Undo it from the toast.
4. Calendar: pick a date next week and add a task; it shows under that day and also in Tasks. Switch to "Every day until due" and check it appears on each day from today to its due date, in the same order as the Tasks page; switch back to "Due date only" and it appears only on its due date. Reopen the app on the phone and confirm the choice stuck.
5. Carry-over: add a work task and a home task both due today. Set work end to two minutes from now; once it passes, the work task moves to the top marked "Carried over" and the home task doesn't. The next day both are on top. Move one's due date to later in the week and check the other off; both leave the top.
6. Time: press ▶ on a task, wait a minute, then press ▶ on another: a popup lists the running timer ticked to stop. Confirm and the first stops; or untick it and both run (the header shows +1). Go back to the first: its time adds on. Open the Time tab: today lists both with their times; tap one and type 1:30 to correct it; use + Add time on yesterday. Leave a timer running past your work end: it stops at the end time. Press ▶ on a subtask: its own time counts, and its task's time doesn't change; on the Time tab it's listed under its task.
7. Status: in the add form turn on Status, type "Waiting on parts" and add the task: a pill appears to the right of its name. Open a task: no Status box until you turn on its Status toggle; then it appears beside the name. Turn it off and the status is gone. Tap the pill to change it; clear it and it disappears. Do the same for a subtask.
8. Daily: turn on Daily in the add form and add a work task and a home task. Each appears in a Daily section at the top of its list. Check one off: it stays, crossed off, and the count goes up. Tomorrow it's unchecked again. On Saturday the work one (work days only) is gone and the home one is there. Change its colour in Settings, Colors.
9. Extend day: set work end to 20 minutes from now. When the Extend day button appears, press it with the default; the header shows the new end and Work stays on top past the old end. Close and reopen the app: the popup asks to keep working or switch to Home; try both on separate reopens. Another day, leave the button alone and check Home goes on top when it disappears.
10. Settings: set work end to two minutes from now. After it passes, the band turns green, home is on top, and the work list is below it in your order, with every due date unchanged.
11. Give a task a due date two days out with the reminder set to 3: it shows "Due in 2 days" and the banner lists it. Hide the banner, minimize DayTask and restore it: the banner stays hidden and no notification appears. Press Show to bring it back. Close and reopen the desktop app: the banner is open again and the Windows notification appears once.
12. Subtasks: open a task, add three subtasks with Enter, give one a due date of tomorrow and turn on High priority, close it, check another off from the list and watch the phone update. The dated one shows "High" and "Due tomorrow" under the task, appears in the due-soon banner as "in <task name>", and its task shows on tomorrow in the calendar. Fold them with the 1/3 pill. Check the rest and use "Mark task done" in the prompt.
13. Give a task three subtasks with no dates, then date the last one: it jumps to the top. Give another the same date and drag the two into the order you want; try dragging a later-dated one above an earlier one (it won't go). Check the top one off: it drops to the bottom and the next one moves up under the task.
14. Drag one task onto the middle of another: the row says "Add as subtask" and a popup asks first. Cancel, then do it again and confirm; check it appears as a subtask with its due date and priority, then use Undo. On the phone, try the same with your finger.
15. Colours: in Settings pick a very light Work colour and a bright High colour; the header updates as you pick. Leave Settings without saving and it reverts; pick again and Save. The phone switches within a few seconds and High labels are still easy to read. Try Dark, then Reset all colors and Match device.
16. Copy enhanced notes from a real Granola meeting (desktop and phone), paste into Import. Confirm your items are added with the meeting context, others are offered with Add anyway, and a second paste adds nothing. Note any owner format it missed and add it to `parser.js` with a test.
17. Offline: with the app open on the phone, turn on airplane mode. The header says Offline. Add a task, check one off, edit another, then close the app completely and reopen it (still in airplane mode): it opens with those changes and a count of changes saved on the device. Edit something else on the desktop meanwhile. Turn airplane mode off: the count goes to Syncing then disappears, and the desktop shows the phone's changes with its own edit intact.

## Known limitations and next steps

- No recurring tasks.
- Subtasks are one level deep. Editing the same task's subtasks on two devices at the same moment keeps whichever save lands last.
- Phone reminders appear only when you open the app. Notifications on a closed phone would need Web Push (a scheduled Supabase function plus a service worker), which is possible on the free tiers but not built yet.
- If the desktop app stays open for days, it won't notify again until it's reopened (the due labels on tasks still update).
- Granola import is manual until an integration is verified (see above).
