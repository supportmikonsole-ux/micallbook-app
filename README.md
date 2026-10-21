# MiKallbook

Stage manager's prompt book: the script with every cue marked on it, and a calling view to run the show from.
Part of the Mi suite with MiKonsole (lighting) and MiKue (sound).

## Run

```
npm install
npm start
```

Build installers: `npm run build:win` (or `build:mac`, `build:all`). Output goes to `dist/`.

## Files

| File | What it is |
|---|---|
| `main.js` | Electron main process: window, show open/save, script consolidation |
| `preload.js` | The `window.micallbook` bridge the page uses |
| `index.html` | Layout |
| `app.js` | Show model, show files, modes, script toolbar, calling view |
| `script-view.js` | Page viewer: PDF pages, zoom, two-page spread, page tracking, mark layer slots |
| `text-doc.js` | Pasted-text scripts: page layout, and keeping marks on their words through edits |
| `marks.js` | GO points on the script: placing, drawing, moving, undo/redo, calling order |
| `panels.js` | Side panels: GO point inspector and Departments |
| `calling.js` | Show mode: Standby, GO / Back, highlighting and following the script |
| `operator.js` | Operator mode: one department's cues, states and script excerpts |
| `link.js` | Live link, page side: Link window, following the SM, checking copies match |
| `link-main.js` | Live link, network side (main process): the SM's sharing server and the operators' connection |
| `cuelists.js` | Live cue lists from MiKonsole and MiKue: the cue pickers' lists, cues not found, combo cues |
| `drive.js` | DRIVE: GO / Back fire MiKonsole and MiKue, MiKue's standby follows |
| `timing.js` | Show clock: sessions (rehearsals / performances), milestones, holds, Session Log |
| `reports.js` | Reports: report per session, template per show, PDF into `reports/`, Print |
| `runorder.js` | Concert running order: items, GO points per item, Show mode highlight, print / PDF |
| `cuesheets.js` | Department cue sheets: on screen, PDF (landscape) and CSV into `reports/`, Print |
| `mikast-link.js` | MiKast link, page side: MiKast Link window and pill, calls → planned sessions, report fields filled from MiKast |
| `mikast-link-main.js` | MiKast link, main process: picks the .mikast file, reads it and attendance.json every 2 s (read only) |
| `notes.js`, `notes-page.html` | Rehearsal notes from phones and laptops into the current report (served while sharing) |
| `vendor/qrcode/` | qrcode-generator 1.4.4 (MIT, Kazuhiko Arase): the notes page's QR code |
| `popout.html`, `popout.js`, `popout-preload.js` | Booth View: the pop-out calling display |
| `vendor/pdfjs/` | PDF.js 6.3.289 (Apache 2.0), bundled so nothing loads from the internet |
| `mi-theme.css` | Shared Mi suite look (master copy lives in MiKue; copy changes from there) |
| `mi-fonts.css` | Embedded fonts, same as MiKonsole and MiKue |
| `mikallbook.css` | MiKallbook-only styles |
| `MiKallbook_Manual_v2.html` | User Manual, opened from Utilities › User Manual or F1 in its own window (uses `mi-fonts.css`) |

## Show files

The file area sits in the header next to the brand, laid out like MiKonsole's: SHOW, the show name, New / Open /
Save / Save As, and the status (unsaved, unsaved changes, saved). On the right: the mode buttons, the Link status
(only while sharing or following), **Utilities ▾** and Exit.

**Utilities ▾** holds Reports, Notes from Phones, Cue Sheets and Departments (these two in Edit mode), Link Computers, Booth View and User Manual (also F1).
Each item says what it's doing now (e.g. "sharing · 2 following", "open"). Any key or a click elsewhere closes it.

Saving creates a show folder: `<Show Name>/<Show Name>.mikallbook` plus `script/` and `reports/`. Older `.micallbook` shows (from before the MiKallbook rename) still open; the first save writes a `.mikallbook` file beside the old one, which is left as it was.

Internal names were kept from the MiCallbook days so saved shows, preferences and the links keep working: the `window.micallbook` bridge, localStorage keys (`micallbook.*`), the link paths (`/micallbook/...`), the `format: 'micallbook'` field inside show files, and the `micue` department target. On first start MiKallbook copies the old `micallbook` settings folder (AppData) into its own.
The script PDF is copied into `script/`, so the folder can be moved to another computer as a unit.
Scripts are copyrighted: nothing is ever uploaded anywhere.

## Script viewer

- **Import PDF…** (Edit mode). Scanned, image-only PDFs work; marks are placed by position, not text.
- **Paste Text…** (Edit mode) for original works, revues or a typed-up script. Pages are US Letter,
  12 pt monospace, 65 characters a line, 54 lines a page, the same on every computer.
  **Edit Text…** changes it later; marks stay on their words, and any whose words were deleted are flagged to check.
  - **Rejoin Lines** repairs text copied out of a PDF (a line break at every printed line): joins the paragraphs back
    together and drops page numbers. Ctrl+Z in the text box undoes it.
  - **Script layout** (on by default, display only) centers character names and indents ( stage directions ).
- Switching between a PDF and a text script keeps each GO point's cues and notes but not its position.
- Page Up / Page Down, Ctrl+Home / Ctrl+End, or type a page number.
- In a narrow window the toolbar wraps onto a second row.
- Ctrl + mouse wheel zooms; **↔** fits the page width to the window, **↕** fits a whole page in the window (both
  follow the window size; the choice is remembered on this computer).
- **1 Page / 2 Pages** side by side.
- **Paper / Dark**: Paper is a warm cream page (easier on the eyes than white). Dark shows light grey text on dark grey (the page image is inverted on screen only; the PDF is never changed).
  **Contrast** (Dark only) helps grey scanned pages.
- Dark, contrast, spread and zoom are remembered on this computer, not in the show file.

## Marking GO points (Edit mode)

- Click on the script: a quick picker opens at the spot. Pick the department (Tab / Shift+Tab steps through them),
  check the cue number (it suggests the next free one), **Enter** to place. **+ Add** puts another cue in the same
  GO for a combined call ("LX 12 + SQ 4"). **Esc** cancels.
- On PDFs with real text and on pasted text, the arrow snaps to the start of the word clicked. Scanned pages have no
  text, so the arrow goes exactly where you click.
- Each GO point gets a tab in the right margin strip; its line runs through the margin and the space above the
  marked line, so it never strikes through the words it marks. Tabs that would overlap stack.
- Click a tab to select it; double-click to change its cues; drag the arrow tip to move it; **Delete** removes it.
- **Ctrl+Z / Ctrl+Y** (or Ctrl+Shift+Z) undo and redo marking. Replacing or editing the script text starts a fresh history.
- The calling column lists every GO point in calling order (page, then top to bottom); click one to jump to it.

## Cue lists from MiKonsole and MiKue

A department's **Link** (Departments panel) says which app its cues live in: LX → MiKonsole, SQ → MiKue.
While those apps run on this computer, MiKallbook reads their cue lists (it never sends them anything yet).
- The calling column shows a status pill for each linked app: green with the number of cues, amber for
  MiKonsole running with Phone Remote not connected (its cue list only comes through Phone Remote) or an older
  MiKonsole / MiKue ("older version"), grey when off. Hover a pill for details.
- **Quick picker:** under the number, what that cue is ("Sunrise", "Doorbell · fires LX 1.5") and the app's cue list.
  Click a cue, or use **↑ ↓** in the number field to step through the list. Typing any number still works.
- **Inspector:** the same line under each cue, and the cue number fields offer the list as a dropdown.
- A cue that isn't in the app's list gets a wavy red underline on its tab, a red line in the inspector and the picker,
  and the calling column shows "n not found" (click it to go to the first). Nothing is flagged while an app isn't running.
- **Combo cues:** when a MiKue cue fires a MiKonsole cue (itself, or further along its Continue / Follow chain),
  MiKallbook adds that LX cue to the GO point: the tab reads **LX 1.5 / SQ 2**. It can't be edited on its own;
  changing or removing the SQ cue updates it. An LX cue typed in by hand that MiKue also fires becomes the combo cue
  (and goes back to a plain cue if MiKue stops firing it). A MiKonsole GO cue that just says GO shows as "LX next".
  If MiKue's cues change later, the inspector offers **Update from MiKue**. When MiKallbook drives the apps
  (DRIVE, below) only the SQ cue is sent, so the light cue never fires twice.
- Needs MiKonsole and MiKue from 2026-10-17 on (MiKonsole sends cue numbers, MiKue reports Continue/Follow and its
  MiKonsole targets). Older versions: the pill says "older version" and numbers or combo cues aren't available.
- MiKonsole only sends its cue list when Phone Remote connects, on GO / Back / Stop / Go To, and on submaster bumps:
  after opening a show or editing cues in MiKonsole, press GO once (or Disconnect / Connect) to refresh MiKallbook's list.
- MiKue only answers on the same computer (127.0.0.1:8090); MiKonsole's relay is read at localhost:8080.

## Inspector (click a GO tab)

Opens from the left. Cues (department + number, add/remove), **Standby** and **Warn** points (Place… then click the
script; the panel steps aside while you do; drawn as dashed SB / W tabs), a note, **Called on visual** (VIS on the tab),
and the calling order: **Earlier / Later** override reading order (↕ in the list), **Reading order** puts it back.
Marks flagged after a text edit get **Checked**; marks left without a position after a script swap get **Place on script…**.

## Departments (Utilities, Edit mode)

Color, code (the text on the tabs), name and link (None / MiKonsole / MiKue: where its cues live, for the cue lists and DRIVE) for each department;
▲▼ set the order of the picker buttons; × deletes (asks first if cues use it). Departments belong to the show.
**Save as default** makes new shows on this computer start with them; **Use suggested set** goes back to
LX, SQ, MIC, FLY, SPOT, VIDEO, DECK. MIC (Sound Board) is for mic cues: it isn't linked to an app, so it's called
but never driven.

**Mic numbers** (checkbox per department; on for MIC): the department is called by mic numbers instead of a cue
number. In the picker and the inspector a MIC cue is one or more groups, each a mic list (`4-8, 11`) and IN / OUT
(+ Group for another), and it reads **MIC 4–8, 11 IN, 2–3 OUT** on the tab, in Standby, the Booth View, Operator
mode, cue sheets and notes. A MIC cue typed as a number before this option keeps its text until it's edited.

## Milestones are cues

A GO point can carry one **milestone**: House Open, Places, Act 1 Up … Act 5 Down (**Milestone** in the picker and
the inspector). It can be the GO point's only cue (Standby reads HOUSE OPEN) or sit with department cues
(ACT 2 DOWN · LX 40, e.g. house lights up for the audience to leave). Each milestone is on one GO point only: setting
it on another moves it there. Put pre-show calls at the top of page 1 or on the title page (or on an item in a running order).

In Show mode, on the SM's computer, **GO on a milestone GO point logs that time** in the session:
- No session running: the first milestone GO **starts one**, of the kind chosen when Show mode started (else the
  last kind used, else Performance). Its acts = the highest Act n in the book.
- The **last act's Down ends the session** (Reopen in the Session Log if that was early). Its cues still fire as usual.
- **Back** over a milestone GO point takes its time out again; Back over the GO point that started the session removes
  that session if nothing else was logged in it.
- In a show with milestone cues the timing box keeps Hold, the reason and the Session Log; its milestone / Start
  Session button is hidden. Shows without milestone cues work as before.

## Calling the show (Show mode)

- **Standby** shows the next GO point: its cues, "GO n of N · page", the note, and VISUAL when it's called on visual.
- **Warn and Standby are calling steps** (2026-10-20): GO steps through a GO point's Warn and Standby points in
  script order (WARNING LX 5 → STANDBY LX 5 → LX 5 GO). Only the GO step fires, logs a milestone or flashes for
  operators; the big button reads WARN / STANDBY / GO. A Warn placed before an earlier GO is called before that GO
  (`callSteps`, `curStep`, `stepK` in calling.js; the link sends `k` and `step` so operators follow each step).
- **GO** (button or **Space**) calls the next step. A second press within 0.3 s is ignored.
  With DRIVE off nothing else happens; with DRIVE on it fires the cues (below).
- **Back** (button or **Backspace**) steps back one GO point.
- On the script the standby GO's tab is enlarged and its line gets a highlighter band; GO points already called are dimmed.
  The script scrolls smoothly so the standby GO sits about a third of the way down.
  **Follow** (script bar, Show mode, on by default, this computer) turns that scrolling off and on.
- Clicking a tab or a row in the running order sets Standby there (for picking up mid-rehearsal). Nothing fires.
- After the last GO the strip shows END; Back steps back into the show. Your place is kept when you switch modes.

## DRIVE: GO fires MiKonsole and MiKue (Show mode)

**Entering Show mode on a fresh start** (Standby on GO 1, nothing called, no session running) asks "Drive MiKonsole
and MiKue?" (only the apps this show's departments are linked to): **Drive** (Enter), **Call Only** (GO just moves
the calling position; operators press their own GO), or **Cancel** (Esc: stay in Edit). In a show with milestone
cues it also asks the **Session** kind for the first milestone GO (with no linked apps the question is "Start the
show"). Going back into Show mode mid-show (from Operator or Edit) doesn't ask: DRIVE stays as it was. No question
when nothing is linked and there are no milestone cues, or on an operator's computer that follows the SM.
After the last GO, click GO 1 in the list (Show mode) to start the next run fresh.

The **DRIVE** button next to Back changes it during the show (remembered on this computer). With DRIVE on and
MiKallbook in Show mode, the Show mode banner turns red ("GO DRIVES MiKonsole + MiKue"); with DRIVE off it turns
amber ("DRIVE OFF · GO doesn't fire MiKonsole + MiKue"). With DRIVE on:
- **GO** fires the GO point's cues in the linked apps (each department's Link): LX cues in MiKonsole, SQ cues in
  MiKue, all at the same moment. MiKonsole's cue is looked up by number in its live list at that moment, so cues
  inserted in MiKonsole don't shift anything. Combo cues ("LX 1.5 / SQ 2") send only the SQ cue: MiKue fires the light.
- **Back** sends MiKonsole's Back when the GO point being stepped back over changed the lights (its LX cue went out,
  or MiKue fired it). MiKonsole's Back goes to the previous cue in MiKonsole's own list.
  It also **stops the sounds that GO point started** in MiKue (each SQ cue plus whatever it set off through Continue /
  Follow, 1 s fade). Sounds started by earlier GO points, like pre-show music, keep playing. Needs MiKue from 2026-10-18 on.
- **MiKue's standby follows** MiKallbook's: the next SQ cue from the calling position on (also after clicking a tab
  or a running-order row, and when DRIVE is armed).
- A cue that can't be sent never stops the show: MiKallbook moves on, the GO button flashes red and a message says
  what wasn't sent and why (not in the app's list, MiKonsole's Phone Remote not connected, MiKue not running…).
- Each app is only needed for the departments linked to it: a sound-only show needs just MiKue (set LX's Link to
  None, or delete LX, so nothing waits on MiKonsole). MiKonsole needs Phone Remote on **Connect**. The linked apps
  must run on this computer.
- Never drives in Edit or Operator mode, or on an operator's computer that follows the SM (the button is disabled
  there), even if its link is lost.

## Show clock: sessions (Show mode)

A **session** is one rehearsal or performance. The timing box sits in the calling column below Back / DRIVE (Show
mode only; not on a computer that follows the SM).
- **Start Session** asks the kind: Rehearsal, Tech, Dress, Preview or Performance (Enter = Performance). Each kind is
  numbered on its own (Performance 3).
- **The big button logs the next milestone now**: House Open → Places → Act 1 Up → Act 1 Down → Act 2 Up → … → the
  last act Down, then **End Session**. A second click within 1 s is ignored. The number of acts (1–5) is per show,
  changed in the Session Log.
- The box shows where the show is (HOUSE OPEN, PLACES, ACT 2, INTERMISSION, SHOW DOWN) with the time since it
  started, and a line of run times: `Act 1 1:00:00 · Int 15:00 · Act 2 … · Held 5:00`.
- **Hold** starts and ends a hold (the box turns red); pick a reason while it runs. An act going Up ends a hold.
- **Session Log** opens the Session Log (with no session running the button reads Last Session or All Sessions). The menu at its
  top picks any session of the show, newest first. In it: change any time (a milestone pressed late), delete one, add a milestone or another
  moment ("Pre-show speech") at a typed time, add a hold that wasn't pressed, set kind / number / date / acts, and
  End, Reopen or Delete the session. Run times: each act from its Up to its Down (holds inside an act are shown);
  intermission from one act's Down to the next act's Up; running time from the first Up to the last Down.
- Only one session runs at a time. It keeps running in Edit mode, and is saved with the show: open the show again and
  it carries on. Exit with a session running asks End Session or Leave Running.
- Sessions are stored in the show file (`reports`). Until the show is saved, the running session is also kept on this
  computer: if MiKallbook closes without saving, opening the show again offers to restore the times.

## Reports (Utilities)

Every session has a report. **Utilities › Reports** (hidden in Operator mode and on a computer following the SM)
opens the Reports window; the Session Log's **Report** button opens it at that session.
- Left: this show's sessions, newest first, with how many fields are filled in. **+ New Report** adds one for a
  rehearsal that wasn't timed (Enter = Performance, as for Start Session).
- Right: the report. **Times** come from the show clock (plus holds with reasons and other moments); **Edit Times**
  opens the Session Log on top. Then the template's fields: one line, several lines (grows as you type), number,
  yes / no. Typing marks the show as changed; Ctrl+S saves without leaving the window.
- **Edit Template**: rename, change kind, reorder (▲ ▼), delete (asks if reports have entries in it; those go
  too), + Add field, **Carry forward** (a new session starts with the last report's entry, e.g. Stage manager,
  Next call). **Use Suggested Fields** resets it; entries in fields with the same name are kept. The template
  starts with the suggested fields, one per department among them.
- **Save PDF** writes `reports\<date> <Kind n>.pdf` in the show folder (saving again replaces that report's PDF; a
  show never saved asks to be saved first), then offers Open PDF / Show in Folder. **Print** (Ctrl+P) opens the
  printer dialog. Both use the same Letter-size page.
- Report text is covered by the same crash recovery as the session times.
- Esc closes the window (or leaves Edit Template). GO / Back don't respond while it is open.
- Field kinds: one line, several lines, number, **time** (a clock picker; the PDF shows it as 6:30 PM), yes / no.
  Call time is a time field in the suggested template (in an older show, change its kind in Edit Template).

## Concert running order (instead of a script)

For choir and concert programs. On a new show's empty screen, **Running Order…** (it replaces a script; GO points
already marked keep their cues and wait to be put on an item). The script column then shows the running order
instead of pages:
- **Edit mode:** each item has a kind (Song, Speech, Transition, Riser move, Intermission, Other), title, estimated
  length (m:ss; "4" becomes 4:00), performers / group, and optional cue lines / lyrics (one per line). ▲ ▼ move an
  item, ✕ deletes it (its GO points can be kept, to put on another item). **+ Add Item** adds one at the end. The
  header shows the item count and total length; each item shows when it starts (+m:ss from the first item).
- **GO points:** **+ GO** on an item opens the usual quick picker. Click a GO to select it: the panel picks its
  **Item** and **On** (the start of the item, or one of its cue lines). Double-click edits its cues. Calling order =
  item order, the start of an item before its lines (Earlier / Later still work; **Item order** resets).
- **Show mode:** the standby GO's item is highlighted and kept in view, its line too; called GO points dim; clicking a
  GO sets Standby. GO, Back, DRIVE, Link, Booth View, Operator mode (shows the item instead of a script excerpt),
  cue sheets (an Item column), reports and notes from phones all work as with a script.
- **Print / Save PDF** (`reports\Running Order.pdf`): #, item, kind, performers, cue lines, length, start time.
  **With cues** adds each item's cues for the crew; without it the file is `Running Order - Performers.pdf`.

## Cue sheets (Utilities, Edit mode)

**Utilities › Cue Sheets** (Edit mode) lists the cues in calling order: **All departments** (every GO point with all its
cues) or one department (↑ ↓ or click on the left).
- Columns: GO number, cue(s) and VISUAL, page, the **script line** of the GO (with the Warn and Standby lines above it,
  marked W / SB, and their page when it differs), and **Also called · Note** (the other departments' cues on the same
  GO, "LX 1.5 fired by SQ 2" for combo cues, and the GO point's note).
- Script lines come from the script: pasted text (the line the mark is in, cut around the mark in a long speech) and
  text PDFs (the printed line). A scanned PDF has no text, so only page numbers show.
- **Save PDF** (Letter, landscape) and **Save CSV** (opens in Excel; every column, Standby / Warn separately) go into
  the show's `reports` folder as `Cue Sheet - LX Lighting.pdf` / `.csv` (saving again replaces it). **Print** (Ctrl+P).

## Notes from phones (Utilities › Notes from Phones, or the Reports window)

**Utilities › Notes from Phones** shows the QR code large, any time (no session or Reports window needed), so the team can scan it from this screen; it starts sharing first if this computer isn't sharing. It uses the same server and code as below.


Directors, choreographers, music directors and others send rehearsal notes from their own phones or laptops straight
into the report.
- **Take Notes from Phones** (bottom left of the Reports window) starts sharing, the same as Link → Start Sharing, so
  operators can follow too. The window then shows a **QR code**, the address (`http://<this computer>:8095/notes`)
  and the 4-digit code. Scanning the QR code opens the notes page with the code filled in.
- The notes page (any browser, same network): name and role (remembered on that device), **Note for** (the template's
  several-lines fields: General, each department, Cast…), **Cue (if needed)** with a **Last: LX 12** button for the GO
  point called last, the note, **Send Note** (Ctrl+Enter on a laptop). Its list of what was sent stays on that device.
- Each note is added to the end of that field as `LX 12 · Jane (Director): Spot late on entrance` (no cue part when
  none was given). It shows at once if the report is open (the box flashes green), with a toast either way.
- Which report: the running session, else the latest report dated today, else a new untimed Rehearsal report made by
  the first note. Starting a session later that day with the same kind times that report instead of making another.
- Same rules as the Link: same network, Windows Firewall allowing MiKallbook on Private networks, wrong code refused.
  A device can send a note at most every 0.4 s; a note is at most 2,000 characters. Notes only add text: nothing on
  the page can change anything else in MiKallbook.

## Operator mode (Edit | Show | Operator)

For a light, sound, spot or deck operator. Pick the department in the dropdown next to the mode buttons (remembered
on this computer). The window shows only that department:
- **Their next cue, large**, with its state against the SM's calling position: **WAITING** (2+ GOs away),
  **WARN** (the GO after the SM's standby), **STANDBY** (the SM's standby), **GO** (green, just fired).
  Other cues in the same GO show as "with SQ 4". Note and VISUAL included.
- **A script excerpt**: just the lines around the cue's Warn (W), Standby (SB) and GO points, GO line highlighted.
  Follows Paper / Dark.
- **Their next two cues**, each with a short excerpt around the GO word.
- It follows this computer's calling: Space / Backspace here, or the SM's computer when linked (below).

## Link: operators follow the SM (Utilities › Link Computers)

Every computer opens its own copy of the same show folder. The SM's MiKallbook shares; the others join and follow.
- **SM:** Link › **Start Sharing**. The window shows this computer's address (e.g. `192.168.1.20`) and a 4-digit code,
  and lists the computers following. The code stays the same from night to night; **New Code** drops everyone.
  The header then shows a blue **Sharing · n** button (click it to open the Link window).
- **Operator:** Link › type the SM's address and code › **Join** (both are remembered). The header shows **Linked**.
  Standby, GO (with the green flash) and Back all come from the SM; Space / Backspace do nothing here.
- **LINK LOST:** red banner and button; MiKallbook keeps trying to reconnect every 1.5 s. Until it's back, Space /
  Backspace work locally; when it reconnects the SM's position takes over again. A lost link is noticed within 3.5 s.
- **Copies that differ:** each show file has a hidden ID, and the SM sends a checksum of every GO point (cues, marks,
  VISUAL, note). A yellow banner lists the GO points that changed, are missing or extra, or a different calling order.
  A different show entirely gets a red banner and isn't followed.
- Only the calling position and checksums go over the network, never the script. Operators can't control the SM.
- Uses port 8095 (8096–8099 if that's taken; the address then shows `:port`). On Windows, allow MiKallbook on
  **Private** networks when the firewall asks (shown as Electron when started with `npm start`), and the booth
  network must be set to Private.
- Exiting the SM's MiKallbook while operators follow asks first.

## Booth View (Utilities)

A second window for a booth monitor. It stays dark. The menu in its top bar picks what it shows (remembered on this
computer):
- **Full call:** Standby cues in large type with the note and VISUAL, "GO n of N · page", the last cue called, the
  next three coming up, a clock, and a green flash on each GO.
- **One department** (e.g. LX · Lighting): the Operator view on the big screen: WAITING / WARN / STANDBY / GO, the
  department's next cue with its script excerpt (W / SB / GO lines), and its next two cues. It works whatever mode
  the main window is in, so an operator can keep the main window in Operator mode for one department, or in Show
  mode, and put a department on the booth monitor. If that department is removed from the show it shows the full call.
- The top bar says SHOW, OPERATOR, EDIT · not calling, FOLLOWING THE SM, or LINK LOST (red).
- The first time it opens on another monitor if there is one; after that it remembers its monitor, position, size
  and full screen (this computer). If that monitor isn't connected it opens on the main screen.
- **F11** or double-click toggles full screen.
- It never needs the keyboard: Space / Backspace pressed while it is in front are GO / Back in MiKallbook.
- Closing MiKallbook closes it.

## Status

Phase 1 complete (steps 1a–1f): app skeleton, show files, Edit/Show mode, PDF and pasted-text script viewer, marking (GO points, Standby/Warn, inspector, departments, calling order), calling view, Booth View.
Operator mode done: O1 (docked department view), O2 (live link), O3 (Booth View department view).
Live cue lists and combo cues done.
Header file area like MiKonsole's done.
Phase 2 (DRIVE: GO fires MiKonsole and MiKue) done.
Phase 3a (show clock: sessions, milestones, holds) built.
Phase 3b (reports, notes from phones, time fields) built.
Phase 3c (department cue sheets) built.
Utilities menu, Link status pill, Booth View in the toolbar, ↔ / ↕ fit buttons.
Phase 5 (concert running order) built. See `MiCallbook_Scope.md` in the Project Files for the plan.
MiKast link (MiKast Phase 4: calls become sessions, sign-ins fill the report) built. See `MiKast_Phase4_Plan.md`.

## MiKast link (Utilities › MiKast Link)

A show can be linked to its MiKast production (`.mikast`). MiKast owns the schedule; it flows one way, into MiKallbook.
- `mikast-link-main.js` reads the `.mikast` file (its `link` block: each call with who is called, and sign-in names)
  and `attendance.json` beside it, every 2 s, read only. Calls come through when MiKast saves; sign-ins at once.
- Each call becomes a **planned** session (`planned: true`, `call: <id>`, stored ended so it never counts as running),
  numbered by date after the sessions of its kind so far. Start Session / the first milestone GO / Session Log Start
  times today's planned session; Back over the first milestone makes it planned again.
- A planned session follows its call's date and kind until started. A call deleted in MiKast removes an untouched
  planned session, else marks it `callGone`. A session deleted here is listed in `show.mikast.dismissed`.
- Report fields filled from MiKast (matched by name): Call time, Absent / late, Called, Next call. `session.auto` keeps
  what was filled; a field the SM has typed in is left alone.
- The Reports window lists planned sessions from today on under **Coming up (from MiKast)**.
- Mic names (2026-10-20): the `link` block's `mics` (`{ '<n>': personId }`, MiKast's Main mic plot) puts
  "4 Jane D., 5 Sam P., 6 —" with MIC cues: tab tooltips (marks.js), Operator mode (operator.js `micWhoTexts`),
  the Booth View department view (calling.js / popout.js) and cue sheets (+ a CSV *Mic names* column).
  `micWhoText` / `micWhoLines` live in mikast-link.js; a new plot or names redraw them (`micNamesMaybeChanged`).
- `show.mikast = { path, rel, prodId, name, dismissed }`; `rel` is relative to the show folder (sibling folders), so
  moving both folders together keeps the link.
