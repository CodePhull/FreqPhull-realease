# Patch notes

Changes since the BPM detector became the foundation. Latest first.

---

## 0.7.29 (2026-08-02)

**The installer build failed on a warning.** electron-builder compiles
the installer and the uninstaller in two separate passes, and the dark
theming put uninstaller code in a file both passes read. During the
installer pass NSIS found uninstaller code with nothing to write it into
and warned about it, which electron-builder treats as an error. That
half now compiles only in the pass that owns it.

**Tracks left unanalysed now recover on their own.** Anything with no
tempo and a file on disk is outstanding work, whatever the reason - the
app closed mid-queue, the engines were missing at the time, or a fault
stopped the worker. Asking the user to press a button to recover from
that is asking them to clean up after the app.

There are three moments where it now catches up by itself: shortly after
startup, every half hour, and the moment the engines come back after
being unavailable. That last one matters most, since tracks that failed
during an outage failed because of the outage rather than anything wrong
with the files.

The retry stays bounded. Each sweep clears the in-session failure counts,
so a transient problem cannot permanently disqualify a track, but a file
that is genuinely unreadable fails its three attempts and settles back
out of the queue - verified as three retries per half hour rather than a
loop. The pending badge still responds to a click for anyone who wants it
sooner, but it no longer instructs: it reports what is waiting.

**Downloads were never analysed in the background.** The function that
wakes the analysis worker checks a flag saying whether engine setup is
running. That flag was declared with `let` thousands of lines below the
function that reads it, and `let` is not hoisted - so every call threw a
ReferenceError before it could look at the queue. Nothing was ever
queued, no error surfaced anywhere, and opening a track worked because
that is a different path entirely. The declaration now sits above every
reader.

This is the fourth fault of this exact shape, so the release check now
verifies that the variables gating real work are declared before the
functions that read them, rather than relying on review to catch it.

**The installer build failed on the uninstaller.** NSIS keeps the
installer and the uninstaller in separate namespaces and requires every
uninstaller function to carry an "un." prefix. The dark theming used one
shared callback for both, so building the uninstaller aborted with "Call
must be used with function names starting with un.". There are now two
callbacks with identical bodies, one per namespace. A page-level hook
that would have had the same problem was removed with it - it binds to
whichever page is declared next, which in a shared include can be an
uninstaller page.

The release check now knows the rule: an uninstaller callback must be
prefixed, an installer callback must not be, and the page-level hook has
no place in a shared include.

**The stockpile can be where downloads land, not where they are sent
afterwards.** A new setting points downloads at the stockpile instead of
the Downloads folder. Filing a track then becomes a move within one
folder tree rather than a haul across drives, and anything the matcher
cannot place waits in an _Inbox beside the style folders instead of
mixing in with ordinary downloads. The switch refuses to turn on until a
stockpile folder exists, since otherwise it would appear to do nothing.

**Automatic filing now covers every download.** The desktop app asked
the server to tag and file its own downloads, but the Chrome extension
and the watch folder did not - so the same setting behaved differently
depending on where a track came from. That decision now lives on the
server, in one place, and applies to all three.

**The installer is dark.** It built and ran, but NSIS ships a light grey
wizard, so a dark application was arriving inside a white window that
looked like it belonged to something else. The page surface, the header
strip, both header labels and the branding line are now painted in the
app's own colours. The header controls need repainting as each page is
shown rather than once at startup, because MUI creates them with system
colours already baked in.

**The updater window had no icon in the taskbar.** It set one, but by a
relative path, which resolves against the working directory rather than
the application - so once packaged it fell back to Electron's default.
The main window beside it already used an absolute path. This is the
third fault of that exact shape; a sweep found no others remaining.

The release check now validates the installer script's structure -
balanced blocks, callbacks that exist, valid colour values - because a
mistake in any of them aborts the build several minutes in.

**The installer still would not build.** The wizard script reads its
header image through NSIS's build-resources variable, which resolves to
whatever `directories.buildResources` is set to - and that defaults to a
`build` folder this project does not have. The bitmaps live in `assets`,
alongside the icon and the script itself, so the setting now points
there. Nothing moved; one line was wrong.

The release check now resolves every path the installer depends on, both
the ones read through that variable and the ones named directly in the
config, so a wrong folder fails here rather than several minutes into a
build.

**The installer would not build.** Two faults in the wizard work.

electron-builder writes its own NSIS symbols from the config before
including the custom script, so the script setting the same sidebar
bitmap and icons made makensis abort with "already defined" and no
installer was produced at all. The script now sets only what the config
cannot express - the header image and the page copy - and guards every
definition so a future version of electron-builder claiming one of them
cannot break the build again.

The integrity manifest was also missing. It is generated by the prebuild
step, which npm runs automatically before `npm run build` but not before
a direct `npx electron-builder` call. There is now a `publish-win`
script that carries its own prebuild, so publishing cannot skip it.

A release check fails the build if the installer script redefines
anything electron-builder already sets, or defines anything without a
guard.

**Three translation keys were defined twice.** JavaScript keeps only the
last of two identical keys in an object literal, silently - so two of
these were showing the wrong text, and editing the first definition
changed nothing at all. "Engines ready" showed a shorter message than
the one written for it, and a stockpile label and a confirmation toast
were sharing a single key while meaning different things. Each now has
one definition, and a release check fails the build on any duplicate.

**The installer has a proper wizard.** It was set to one-click, which
skips straight to a progress dialog - so the first thing anyone saw of
Freq.Phull was a bar with no explanation, and the welcome text sitting in
the installer script had been silently discarded for months.

Three pages now: what the app does, the install itself, and a finish page
that says the engine download is coming. That last one matters most -
without it, being asked for a large download moments after installing
feels like a second, unannounced installer.

No download size is quoted anywhere. A number reads as a cost before
anyone knows what they are getting, and the figure would be wrong for
anyone who skips the optional engines.

The sidebar and header artwork are generated from the app's own logo at
the sizes NSIS requires, rather than drawn by hand, so they stay correct
if the mark changes. A release check verifies the wizard is still
enabled, that the artwork is a real BMP at the right dimensions, that the
script stays ASCII with CRLF endings as NSIS needs, and that no size has
crept back into the copy.

**Engine setup shows what it is doing.** A single bar for a ten minute
install cannot say whether four still minutes are progress or a hang,
which is when people force-quit an install that was working. The stages
are now listed - runtime, numerical libraries, PyTorch, separation
models, transcription, verification - each showing whether it is done,
running or waiting, with the running one carrying its own bar. A long
pause now has a name.

The overall bar is weighted by how long each stage actually takes rather
than by how many there are. PyTorch alone is a third of the wait, so
counting steps would park the bar and leave it there; the time remaining
comes from the same weights. Failure marks the stage it stopped on
instead of clearing the list, so it is clear how far it got.

**Hiding the setup window no longer looks like cancelling it.** Setup
keeps running when hidden, which it always did, but reopening the window
offered to begin a fresh install rather than rejoining the one in
progress - and hiding it said nothing at all. It now rejoins, and hiding
leaves a note that says so and brings the window back when clicked.
Fixed alongside: a variable read before its declaration in that path,
which would have thrown.

**Downloading several tracks at once left some unanalysed.** The
background worker ignored any wake-up that arrived while it was already
running, and nothing re-checked afterwards - so a track that finished
downloading during another track's analysis was never picked up. With
three downloads landing together, the first would start the worker and
the other two would be dropped. Requests are now recorded rather than
discarded, and the worker takes another pass before it reports itself
idle, with the queue count as the authority: if work remains, it keeps
going. Verified against the exact case, with two tracks arriving
mid-analysis.

To be clear about the setting, since the two are easy to confuse: the
auto-analyse option only controls whether the app jumps to the Analyzer
page. Every downloaded track is analysed in the background regardless,
so BPM and key are ready when the track is opened.

**The updater stopped registering any of its handlers.** A helper added
in the previous version landed inside an if-block rather than at module
level. Function declarations in a block are scoped to that block, so
every call from outside it threw - which stopped setup part-way through,
before a single IPC handler was registered. That is why the check
reported no handler and why the version disappeared from About: both ask
the updater for something, and there was nothing listening. The helper is
at module scope now, and a release check fails the build if a function
that looks top-level is trapped inside a block.

The updater window also loaded its page by a relative path, unlike the
main window beside it. A relative path resolves against the working
directory rather than the application, which is not the same place once
packaged. It is absolute now.

**"core.hasSpansEnabled is not a function".** Two majors of the Sentry
SDK were in the tree at once. The packages were declared twice - once
under dependencies and again under optionalDependencies, at different
ranges - and one of those declarations pulled a newer @sentry/node
underneath it. Both then shared a single @sentry/core, so whichever lost
the resolution called an API the other did not have.

The duplicate block is gone and there is now one Sentry package at one
version. @sentry/electron was only ever used for the main process, which
is a Node process that @sentry/node serves perfectly well, and renderer
faults already report through the backend. Removing it also takes the
vulnerable OpenTelemetry chain out of the shipped tree: the runtime
dependencies now audit clean, down from twenty moderate advisories.

One thing is given up with it: native crash dumps from the renderer, the
kind that identified the decodeAudioData fault. JavaScript errors are
still reported. If those dumps prove worth having, the package can come
back pinned to a version built against the same SDK major.

A release check now fails the build if a package is declared in more than
one dependency block, since that is what allowed two versions of the same
library to be installed side by side.

**"log is not defined" when checking for updates.** Two faults stacked.
The updater called a function that lives in a different module, which
throws. Worse, it called it from an event listener - and because
electron-updater emits that event from inside the promise the check
returns, the fault replaced the real error, so every update problem was
reported as "log is not defined" whatever had actually gone wrong. The
call is corrected, every listener is now isolated so a fault in one
cannot hide the error that triggered it, and update failures are
reported in plain terms, since the usual cause is simply that nothing
has been published yet.

Includes everything built as 0.7.14, which was tested but never
published.

**"log is not defined".** The updater called `log()`, which is defined
in main.js, from updater.js. Separate modules do not share scope, so the
call threw every time the update check hit an error. The rest of that
file already used the right name. A release check now fails the build if
any module calls a helper that only exists in another file.

**Tracks stuck on "pending" forever.** The queue counter and the worker
were built from different rules: the worker skipped tracks that had given
up after repeated failures, and the counter counted them anyway. So the
badge reported work the worker would never pick up, the loop found
nothing eligible and stopped, and the count sat there. Both now come from
one query. The badge also said "click to retry" while having nothing
bound to it - clicking did nothing at all. It now clears every reason a
track stopped being eligible and wakes the worker.

**The opening screen sometimes did not animate.** The main script is
780KB and was loaded synchronously, so the browser blocked on parsing it
before its first composite - the splash's animations had not started by
the time it was dismissed. Both scripts are deferred now, which lets the
window paint first. Execution order and timing are otherwise unchanged.

**Stems are written at 24-bit.** Every write in the separation pipeline
used 16-bit, and a stem passes through several in sequence: ensemble
averaging, fullness restoration, bleed cleaning, the lead and backing
split. Each one quantises, and the noise compounds down the chain rather
than being paid once. Measured across four stages, the noise floor sat
at -84 dBFS; at 24-bit it is -133 dBFS, roughly 48 dB quieter. It costs
half again in disk space and nothing in processing time, and it is what
a DAW expects: a stem is raw material for a mix, not a listening copy.
The renderer's waveform reader already handled 24-bit, so nothing
downstream changes.

**Slow + Reverb: playing a track, leaving the page and coming back no
longer plays it twice.** Playback continued from a page whose transport
was no longer on screen, and returning to press play started a second
voice over the first. Playing is now idempotent - a source already
running is stopped before another begins - sources are fully
disconnected when they end, and navigating away pauses, keeping the
position so returning resumes where it was.

**Slow + Reverb looks like a tool now.** The controls are hidden until a
track is loaded rather than sitting there dimmed, replaced by a short
line saying what to do; a wall of sliders that cannot do anything is
worse than an empty space that explains itself. Each control sits in its
own panel, the export section is separated from the part that makes
sound, and the sliders show a grab cursor.

## 0.7.13 (2026-07-31)

Three fixes found while testing 0.7.12.

**multer updated to 2.x.** It is the only dependency that both ships to
users and had a deprecated major version behind it. The upgrade was
verified rather than assumed: the app uses `multer({dest, limits})`,
`upload.single()` and two properties of the resulting file, all of which
behave identically on 2.x under an actual upload through Express.

`npm run audit` now reports only the dependencies that reach a user.
The larger number npm prints covers the build tool's own tree, which
never leaves the machine that builds the app.

**The restart button was drawing itself.** It carried a class name this
window does not define, so the browser fell back to its own control: a
white box in the system font, next to buttons that look nothing like it.
The completion page had the same fault, and worse - assigning the class
replaced the one the button already had, so it lost its styling
entirely. Both now use the names the stylesheet actually defines, and
the release check fails on any button whose class is never styled.

**The what's new list was written but never displayed.** The code that
fills it asked for an element by the wrong name. That returns nothing,
and the next line throws, which abandoned the rest of the page - so the
notes existed in the file, were correct, and never appeared. A release
check now verifies that every element the updater reaches for actually
exists, and that the notes reach the page at all.

## 0.7.12 (2026-07-31)

A large release. The headline is Slow + Reverb, a new page under
Transcribe for slowing tracks down, speeding them up and putting them in
a room, with renders good enough to distribute. Alongside it: the beat
switch detector stops mistaking intros and bridges for switches, history
scrolls properly on large libraries, settings are searchable, crash
reports carry enough detail to diagnose from, and the accent throughout
the app is now white rather than green.

**What's new appears once, and can be reopened.** The page shown after
an update now records the new version before deciding to display
anything, and skips itself if that record cannot be written - previously
a failed write meant it would greet the user on every launch from then
on. Nothing is shown after a first install, since nothing is new when
everything is.

Settings > Updates gains a Show notes button that opens the same page on
demand, so the notes are not lost the moment the window is closed. It
reuses that window rather than duplicating the view, which keeps release
notes written in one place and looking one way.

**Volume control on the Slow + Reverb preview.** There was no way to set
a listening level - the preview simply played at full output, which is
uncomfortable when the point of the page is sitting with a track and
moving sliders.

It is a monitoring control and nothing more. The saved copy keeps the
level worked out in 0.8.5, matched to the source's own peak; a preview
slider feeding into the render would hand people a way to clip their own
exports, which is the opposite of the point. The hint under the slider
says so rather than leaving it to be discovered.

Two details: the response is squared, because perceived loudness tracks
roughly the square of amplitude and a linear slider feels top-heavy over
its travel. And the level is remembered between sessions, while presets
deliberately leave it alone - a preset describes the effect, not how
loud you happen to be listening.

**Exports were far too quiet.**

The impulse response was normalised by its peak. Convolution sums the
entire response for every output sample, so a three-second tail
multiplied loudness - it raised a track by roughly twenty LUFS. The
level correction afterwards then pulled the whole render down by about
thirteen decibels to bring the peak back, and the direct sound went down
with the tail. The meter said the file was correct; it sounded quiet and
washed out. Responses are now normalised to unit energy, so convolving
with one leaves loudness where it found it and the reverb control means
what it says.

`afir`'s own dry and wet controls do not behave as a mix. Asking for all
dry and no wet produced silence, and so did the opposite. The two paths
are now split and mixed explicitly, which makes the balance arithmetic
that can be checked: at zero reverb the render is bit-identical in level
to the source.

The level target changed too. Normalising everything to -1 dBFS made
quiet mixes louder than their artist made them. The render now matches
the source's own peak, capped at -1 dBFS - so it sounds like the track
it came from, with headroom left for a lossy encoder downstream.

Verified by loudness rather than by peak, which is what the first attempt
got wrong: the source measures -22.2 LUFS at -1.41 dB peak, and every
preset now lands within about two LUFS of it with the peak matched to
three decimal places - including the heaviest cathedral setting, which
previously would have been thirteen decibels down.

**Saving a copy works for files opened from disk.**

The refusal was based on a browser assumption that does not hold here: on
the web a chosen file has no path, so there would be nothing for the
backend to render from. Electron hands the window the real location, so
a file opened from disk can be rendered exactly like a library track.
The restriction never needed to exist.

The same path also removes the WAV-only limit added in 0.8.3. Knowing
where the file is means it can go through the same conversion the
library uses, so every format the app supports can be opened directly
and previewed - not just WAV.

**Black screen on load was a renderer crash.**

A native crash report identified it exactly: `decodeAudioData` finishes,
Blink checks whether the source buffer has been detached, and reads a
null wrapper - EXCEPTION_ACCESS_VIOLATION, the whole window gone. That
is why nothing appeared in the logs and no error was ever shown: the
process that would have reported it had already died.

This file warns three separate times never to call `decodeAudioData`
because it fails in packaged Electron, and carries a hand-written WAV
parser written for exactly that reason. Slow + Reverb used it anyway.
It now uses the same parser as everything else, which is safe here
because every track arrives as WAV through the existing conversion.

Opening a file directly is limited to WAV, since that is what the safe
parser reads. Nothing is really lost: the library path converts every
format the app supports, and saving a copy already required a library
track.

A build check now fails on any call to `decodeAudioData`. The rule was
written in comments three times and still got broken, so it is enforced
rather than documented. Verified by reintroducing the call and watching
the check catch it.

**Black window when loading a track into Slow + Reverb.**

Three changes, in order of how likely each is to have been the cause.

Full-window dialogues no longer blur what is behind them. A fixed,
full-window layer with `backdrop-filter` is a known way to end up with a
solid black rectangle instead of a dialogue on some graphics drivers,
which matches exactly what was reported: the window going black at the
moment the track picker opens. The blur was buying nothing anyway - the
overlay already sits at over 96% opacity, which is the same reasoning
that removed it under lite mode. Both the dialogue and confirmation
overlays are now plain.

Slow + Reverb shares the audio context the rest of the app already
uses instead of creating a second one. A page may only hold a handful,
each claims the output device, and failing to obtain one threw at a
point that left the picker covering the window with nothing drawn in it.

The picker now closes before anything else happens, so whatever else
goes wrong the user is looking at the page and a message rather than an
empty overlay - and the failure is reported rather than swallowed, which
it was not before.

Also: the decoded audio is no longer copied before decoding. The copy
was defensive but pointless, since decoding consumes the buffer, and it
doubled peak memory on files that are already tens of megabytes.

**Slow + Reverb renders are now release quality.**

The first version used ffmpeg's `aecho` for reverb. That is an echo - a
few discrete delayed copies - and it sounds like one: metallic, with
audible repeats and flutter on transients. Fine behind a preview,
unsuitable for anything going to a distributor.

- **Convolution reverb.** The signal is convolved against a synthesised
  room response: a direct path, early reflections whose spacing is what
  tells the ear how big the room is, and a dense diffuse tail where
  treble decays ahead of the body, because air and soft surfaces absorb
  it first. The two channels are decorrelated so the tail spreads
  instead of sitting in the middle. Responses are generated rather than
  shipped, which keeps room size continuous and adds nothing to the
  download, and they are deterministic, so re-rendering gives the same
  file.
- **Transparent resampling.** Changing speed the tape way means
  resampling; the default engine is adequate rather than transparent.
  This uses libsoxr at 28-bit precision.
- **Peak control without touching dynamics.** Reverb and bass both add
  energy, so a render can clip. Rather than put a limiter across the mix
  and flatten the transients, the true peak is measured and exact makeup
  gain applied to land at -1 dBFS - headroom a lossy encoder downstream
  can overshoot into safely.
- **24-bit by default**, with 16-bit, FLAC and MP3 320 available.
  Dither is applied only where bit depth is actually reduced. Source
  sample rate is preserved rather than everything being forced to 44.1k.
  Tags carry across to the render.
- The export reports what it produced - rate, depth, final peak - so the
  numbers can be checked rather than taken on trust.

Three faults were found by measuring rather than listening; each would
otherwise have shipped silently. `volumedetect`
clamps its reading at 0 dB, so a render that legitimately peaked at
+12.6 dB in the float intermediate measured as 0 and got the wrong
correction; `astats` reports true peak and is used instead. The helper
that read the meter only captured stderr on failure, so every successful
measurement returned nothing and no correction was applied at all. And
afir's own auto-gain, left at its default, buried every reverb render at
-60 dB. After the fixes, every preset lands within 0.01 dB of -1.0 dBFS.

**New: Slow + Reverb**, under Transcribe.

Slow a track down, speed it up, put it in a room, lift the low end. The
difference from the web tools that do this is that nothing renders while
you are deciding: the preview is a live audio graph, so dragging the
speed slider changes what you are hearing immediately, mid-playback. You
find the setting by ear instead of exporting, listening, adjusting and
exporting again. Rendering happens once, when you are happy.

- Load straight from your library, because the track is already on disk -
  no upload, no wait. Any format the app can open works, through the same
  conversion the analyser uses.
- Speed from 50% to 150%. By default pitch follows speed the way a tape
  does, which is the sound people mean by slowed. A switch keeps the
  original pitch if you want tempo alone.
- Reverb with five room sizes, from a booth to a cathedral. The impulse
  responses are generated rather than shipped, so room size is a slider
  instead of a fixed set of files. The dry signal eases back as the wet
  comes up, so adding reverb does not simply make everything louder.
- Bass, lifting everything under 120Hz.
- Six presets - slowed and reverb, chopped, nightcore, daycore,
  cathedral, original - as starting points rather than destinations.
- Saving a copy renders the file properly with ffmpeg at full quality,
  rather than recording the preview, and lands beside the original.

Verified with signals whose answers are known rather than by ear: a 440Hz
tone lands at 374Hz slowed to 85% with pitch following, stays at 440Hz
with pitch locked, and reaches 550Hz at 125%; the bass control measures a
5dB lift where 6 was asked for at the shelf's centre; and reverb puts a
decaying tail into silence where the dry signal has none. Every preset
renders at the expected duration.

**Beat switch detection no longer calls intros and bridges switches.**

Two faults, one behind the other.

A span with no drums still returns a tempo. The detector is given pads
and returns a number anyway, and that fabricated tempo, compared against
the real beat's, looked exactly like a tempo change - so an intro giving
way to the drums registered as a switch, as did any bridge where the
drums drop out. The tempo detector already computes a confidence score
from kick and snare agreement, and the two cases separate cleanly:
drumless spans score around 0.5, real beats two to three times that. A
span that scores below the floor now reports no tempo rather than a
guess. Nothing else changes - the tempo shown for a track is unaffected,
because the gate applies only inside section comparison.

The rule for what counts was also too loose. Any two changed dimensions
qualified, and texture plus energy is two - which is precisely the
signature of an intro, a drop, a breakdown or a bridge. At least one
musical dimension must now move: tempo, key, or the progression. Loud
then quiet at the same tempo in the same key is the same beat played
differently. Chroma differences between spans that resolve to the same
key are also no longer counted as re-harmonisation, since a pad-only
intro against a full arrangement produces exactly that.

Verified against three synthesised cases - an intro giving way to drums,
a genuine switch changing both tempo and key, and a mid-track breakdown.
Before: all three reported a switch. After: only the real one does.

**Duplicate finder deletes across every group at once.** Clearing a
library meant confirming once per group, and with dozens of groups that
is the same click repeated. A toolbar above the list selects or clears
every copy at once, shows how many are selected across all groups, and
deletes them in a single pass with one confirmation. Select-all respects
the existing safeguard: the oldest copy in each group stays.

**Stockpile suggestions show artwork.** Those rows carried no thumbnail
at all, which in a list where every title begins "[FREE] ... Type Beat"
removes the one thing that tells them apart at a glance.

**Crash reporting could have vanished on a clean checkout.**
`@sentry/node` is required at runtime but was never declared as a
dependency. It works on a machine where it was once installed by hand,
and is absent everywhere else - including the release workflow, which
runs a fresh install on a clean runner. Every build produced there would
have shipped with crash reporting quietly switched off, reporting
nothing, with no error to reveal it. Both Sentry packages are now
declared, pinned to the major versions whose API the code actually uses.

A release check now fails the build if any required package is missing
from package.json, so a feature can no longer depend on something that
only exists on one developer's machine.

## 0.7.11 (2026-07-30)

Every animation in the app audited against four questions: does it force
layout, does it repaint, does it snap when it repeats, and can a slow
machine escape it.

**The update screen's pulse had the same seam the opening screen used to
have.** Its loop ended on a different value than it began, so each beat
opened with the mark snapping back to full size and the halo jumping from
dim to bright. The fix from 0.7.6 never reached it. Both now carry the
attack inside the loop and return exactly to where they started, with the
same envelope easing as the opening screen.

**The loading shimmer no longer runs on lite machines.** It repaints a
gradient across every placeholder on every frame, which is real work for
pure decoration on hardware already short of cores. Capable machines keep
it.

Audited and found clean: no infinite animation forces layout, none
multiplies across a long list (the worst case is a handful of concurrent
download rows), there is not a single `transition: all` anywhere in 280
transition declarations, and reduced motion is handled app-wide rather
than animation by animation.

A release check now fails the build if an endlessly repeating animation
touches a layout property, repaints every frame, restarts on a different
value while visible, or if either escape hatch - the system reduced-motion
setting or lite mode - stops working. It distinguishes a real snap from a
loop whose endpoints are simply off-stage, which is why sweeping
highlights still pass.

## 0.7.10 (2026-07-30)

**Confirmations appeared underneath the thing they were asking about.**
Deleting duplicates put the "are you sure" prompt behind the duplicate
list, leaving a dimmed screen with no visible way forward. The cause was
layering assigned ad hoc over time: the list sat at 9999 and the
confirmation at 9000, so the question was a thousand layers below the
question it was about.

Stacking is now a named scale rather than scattered numbers, ordered by
what interrupts what: docked player, then dialogues, then context menus,
then confirmations, then notifications, then the boot and update screens
above everything. A confirmation outranks every dialogue by definition,
so this particular fault cannot come back regardless of which dialogue
raises it.

Every layer in the app was moved onto the scale - the loading screen,
update banner, tamper notice, scroll-to-top button and full-screen panes
included. None remain on a hard-coded number.

A release check fails the build on any raw stacking value, on the scale
being out of order, or on confirmations and dialogues not sitting on
their own layers.

## 0.7.9 (2026-07-30)

An audit pass. One real bug, two accessibility failures, and the checks
to stop them recurring.

**The player's mute button did nothing.** Two functions were both named
`toggleMute` - one for the player, one for the stem separator - and
because function declarations hoist, the later one silently won. Every
click on the player's mute called the stem version with no index, found
nothing, and returned. The stem one is now `toggleStemMute`.

**Setting descriptions and row metadata were too faint to read.** The
colour they use measured 3.09:1 against the lightest surface in the app,
below the 4.5:1 that normal-size text needs, and it carries exactly the
small explanatory text that has to be legible. It now clears the
threshold on every surface while staying clearly quieter than the text
above it.

**Dialogues were invisible to assistive software and leaked keyboard
focus.** The library doctor and smart folder windows had no dialogue
role, so a screen reader had no way to know a dialogue had opened, and
nothing stopped Tab walking straight out of the overlay into the page
behind it. Both now announce themselves, keep focus inside while open,
and hand it back to whatever opened them.

Audited and found clean: no duplicate element ids, no translation keys
that would render blank, no forced layout from reading geometry straight
after writing style, and every drag handler removing the listeners it
adds. The reduced-motion setting already covers everything added since
it was written, because it disables motion app-wide rather than naming
individual animations.

A release check now fails the build on any of it: two functions sharing a
name, a duplicate element id, a translation key with no definition, text
colour below the contrast threshold, or a dialogue that does not announce
itself and hold focus.

## 0.7.8 (2026-07-30)

Crash reports were accurate snapshots of a single moment. They now carry
what is needed to diagnose from a distance.

**Breadcrumbs.** Every server log line becomes a breadcrumb, so a report
arrives with the sequence that led to it - which request ran, which file,
what the engine decided - rather than only the instant of failure.
Health-check polling is filtered out, since a hundred identical lines
would push the useful trail off the end.

**Crashes in the window are captured at all.** The renderer is a browser
context with no Sentry of its own, so an exception in the interface left
no trace anywhere: no log, no report, just a screen that stopped
responding. Unhandled errors and rejections now post to the backend with
the trail the interface collected, and are reported with the same detail
as a server fault. Capped at five per session, because a fault inside a
render loop can fire every frame.

**An anonymous installation id**, so one machine reporting four hundred
times can be told apart from four hundred machines reporting once - the
difference between a nuisance and an emergency. A random identifier
stored beside the app's data: no name, no account, nothing tied to a
person.

**Live application state on every event:** version, uptime, whether it is
packaged, which Python is in use and whether it is the embedded one,
engine health and the reason if broken, analysis queue depth, active
downloads, library size, connected windows, last verification result.

**Searchable tags:** OS build, architecture, cores, memory, locale,
engine source, Python version, lite mode. Sentry filters and aggregates
on tags, so "is this only on four-core machines?" or "only with the
system Python?" is answerable from the dashboard instead of by reading
events one at a time.

A release check fails the build if any of this comes disconnected - each
piece was a real blind spot at some point.

## 0.7.7 (2026-07-29)

**A bad file no longer re-reports to Sentry on every restart, forever.**
The background analyzer's retry cap (3 attempts) lived only in memory,
so it reset on every launch - a file that genuinely cannot be analysed
(corrupt audio, a decode failure Python cannot recover from) crashed,
got reported, and came right back on the very next startup, endlessly.
The give-up is now persisted on the row (`analysis_gave_up`), so a
stuck file stays stuck instead of retrying forever, across all three
failure paths: a Python crash, a bad result the worker cannot parse,
and an ffmpeg failure before Python even runs. A missing file gives up
immediately rather than being rediscovered on every restart.

Given up isn't invisible, either. Library doctor now opens with a
"Tracks the analyzer gave up on" section listing anything permanently
stuck, each with a Retry button - for after fixing engines, replacing a
bad file, or just wanting one more shot. New endpoints:
`GET /history/analysis-stuck`, `POST /history/:id/retry-analysis`.

**"analyze.py exit 1" now says what went wrong.**

The same blind spot the tag writer had: analyze.py reports failures as
JSON on stdout, while the crash report only carried stderr - so every
one of these events arrived saying "exit 1" and nothing else. Reports now
extract the real exception, use it as the event's message, and carry the
Python traceback alongside it. Distinct exceptions form distinct issues
rather than merging into one, with numbers and file paths stripped from
the grouping key so one bad file per user does not become one issue per
user.

The specific failure was reproducible: a zero-byte audio file throws
deep inside the WAV reader with a blank message, which is why the event
was empty. Both ends are fixed. analyze.py names the condition - empty,
truncated, or not a readable WAV - instead of raising an unnamed error,
and the server checks the converted audio before spawning Python at all,
so a damaged file produces a clear message telling the user to
re-download rather than a crash report. ffmpeg exits cleanly on some
damaged inputs while writing nothing usable, which is how these reached
Python in the first place.

Likely origin for existing libraries: tracks left half-written by the
duplicate-download loop fixed in 0.7.2. Those files are still on disk -
the Library doctor and a re-download will clear them.

## 0.7.6 (2026-07-29)

**History scrolls properly on a large library.** Three rules were
competing to describe how tall an off-screen row is, and the one that
won - added in 0.4.3 - was both the least accurate and the only one
without layout containment. It reserved 64px for rows that actually
measure about 94px, so every row scrolled into view corrected the page
height underneath the scrollbar. That constant correction is what made
fast scrolling stutter on a couple of thousand tracks. The duplicate is
gone, the estimate matches reality, and the browser now remembers each
row's true height after its first pass.

**The opening animation is smoother.** Every loop ended on a different
value than it started, so each beat began with an instant jump: the mark
snapping back up to full scale, the halo popping from dim to bright, the
rings appearing at full strength on their first frame. The attack is now
part of the animation rather than the seam between repeats, and each
loop returns exactly to where it began. The hold is 3.2 seconds.

**Settings are findable.** Lite mode was sitting under Maintenance
rather than Performance, where anyone looking to make the app run better
would go. More usefully, the panel now opens with a search box: typing
filters controls by name and description, opens the sections that still
hold matches and hides the rest, so thirty controls across ten sections
collapse to just the part you came for. Searching a section's own name
reveals that whole section.

## 0.7.5 (2026-07-29)

**The accent is white.** Primary buttons were always white on dark, so
the green sitting alongside them was a second accent competing with the
app's own language rather than supporting it. It is gone: emphasis,
hairlines, focus rings, progress fills and the updater all read in white
or light grey now. Two new tokens, `--accent` and `--accent-dim`, mean
the accent is one line to change rather than fifty scattered literals.

Status colours went neutral with it. "Done", high confidence and strong
matches were drawn in the same green, which made a decorative colour and
a meaningful one indistinguishable. Problems stay red; everything that
is fine is simply neutral, which is a clearer signal than a third hue.

Two things deliberately kept their colour: the folder palette, where
five distinct hues exist so tracks can be told apart at a glance, and
the amber used for "worth a look" states between fine and broken.

Glows were dimmed by a fifth on the way across - white reads brighter
than green at the same opacity, so keeping the numbers literal would
have made every halo hotter than it was before.

## 0.7.4 (2026-07-29)

**One screen carries the whole update.** Asking for an update used to
scatter it across three places: a banner tracking a percentage in the
corner, then a separate window, then a restart prompt. Once the user has
asked for the update there is nothing left to decide, so the branded
screen now opens on Install and stays: it shows the download filling a
real progress bar with the percentage and speed, then - when the file is
down - swaps the "do not close this window" warning for a Restart now
button. Restarting brings back the completion page from 0.7.3, so the
whole update reads as one continuous thing.

The bar is honest about what it knows: until the first progress event
arrives, and again while the installer is unpacking, no percentage
exists, so only the shimmer runs. A real percentage switches it to a
determinate fill.

## 0.7.3 (2026-07-29)

**The updater window now has a job after the restart.** By the time
someone clicks restart the download is already done, so the old screen
was showing them a decision they had made minutes earlier. It now
appears on the first launch after an update instead, as a completion
page: confirmation, then what changed. Version numbers are gone from
it - the user knows the app updated, what they want is what they got.
It waits four seconds so it lands after the main window has painted
rather than competing with boot, and it never appears on a first
install, because nothing is new when everything is new.

Release notes live in one place: the `WHATS_NEW` block at the top of
the script in `renderer/updater/updater.html`, English and French. Leave
either list empty and the page shows the confirmation without it.

## 0.7.2 (2026-07-28)

**The same beat downloading over and over.**

`/download` is a Server-Sent Events stream, and an EventSource
reconnects by itself whenever the stream drops - which re-issues the
identical request and starts the download again. With a second window
or the extension queuing the same track as well, that is enough to fill
History with one beat repeatedly. Rather than chase each trigger, the
same track can no longer be downloaded into the same folder twice at
once, or within thirty seconds of finishing. The queue treats that
refusal as completion rather than an error, so nothing retries. A client
that disconnects mid-download now also stops yt-dlp instead of leaving
it running for a listener that has gone.

**Two more sources of duplicate History rows.** The finished download
lands in the output folder, and auto-rename moves the file again after
analysis. Neither told the folder watcher that the app itself was
responsible, so when the output folder sits inside the watched
stockpile, both looked like newly discovered files and were adopted as
separate tracks - the adopted copy then being analysed and renamed in
turn. Both operations now mark their destination the same way the
stockpile moves always have.

**port-in-use fixed at the source.** The single-instance lock was in
place, but `app.quit()` is asynchronous: it asks for a graceful
shutdown and lets the rest of startup keep running, so a second launch
still spawned a backend that then could not bind the port. It exits
immediately now, and nothing starts if the lock was not obtained.

## 0.7.1 (2026-07-28)

**Opening screen is white.** The mark, its halo and both transient
rings now read in white rather than green. The beat ring sits at bone
and the bar ring at pure white, so the 4/4 is carried by tone and travel
distance instead of hue.

**Release workflow fixed.** The Sentry step tested `secrets.SENTRY_DSN`
directly in its `if`, and the `secrets` context is not available there,
so GitHub rejected the whole file before running anything. The secret is
now surfaced as a job-level environment variable and the condition tests
that instead. Tag v0.7.1 and the run will go through.

**A lighter history payload.** The list endpoint selected every column,
which meant whole transcripts and every cached analysis result travelled
to the renderer on each refresh - including at boot, competing with
first paint. On a library the size of a couple of thousand tracks that
is about 3.3MB serialised, parsed and held in memory; the list now
carries only what it renders, around 1.15MB, a 65% reduction. Transcript
and cached analysis are fetched per track, when a track is opened, via
the new `GET /history/:id/full`.

**A smoother launch.**

- The opening screen animated `filter: drop-shadow`, which repaints on
  the main thread every frame - and boot is when that thread is busiest,
  so those were exactly the frames being dropped. The glow is now its
  own layer animating opacity, and the mark animates transform only.
  Both run on the compositor, off the main thread.
- The library path scan fired on the first idle gap, landing while the
  splash was still animating and the first history render was in flight.
  It is background housekeeping with no visible result, so it now waits
  until the opening is over.

**Updater window rebuilt to match the app.** It had drifted into its own
palette - a blue accent against the app's green, and shades a few steps
lighter - so it read as a different product appearing over the main
window. It now uses the app's exact tokens and its single accent, shows
the real Hood Knights mark instead of lettering, and the install
take-over pulses on the same 100 BPM grid as the opening screen. Its
progress shine animated `left`, re-running layout every frame; it now
uses a transform.

**Lite mode, for low-end machines.** Enabled automatically where there
are four cores or less, or four gigabytes of memory or less, and
available as a switch in Settings. It removes cost rather than
character: backdrop blur behind panels (our overlays already sit at 96%
opacity, so the blur was close to invisible while forcing the compositor
to re-filter everything beneath it on every frame), the largest shadows,
and the splash's decorative rings. The spectrum analyser drops to a 8192
point FFT - still finer than it shipped with for most of its life.
Layout, colour, type and animation are untouched.

## 0.7.0 (2026-07-28)

**New opening screen**

The boot splash now carries the real Hood Knights mark instead of a
drawn approximation, and it pulses on a beat grid rather than an
arbitrary sine wave. The logo moves on a kick envelope - sharp attack,
slow release - at 100 BPM, a hairline accent ring fires on every beat,
and a wider one lands on the bar line, so the loop reads as 4/4 rather
than an undifferentiated throb. A single `--bs-beat` value drives the
whole animation, so the tempo is one number to change.

- The logo is inlined as data, so the splash paints on the first frame
  with no file request behind it.
- The status line is held back 600ms: a fast boot shows the mark alone,
  and the message only appears if there is actually a wait. It carries
  the same text as the loading screen behind it, so the two can never
  disagree.
- The splash holds for at least one bar (2.6s) before dissolving. Shown
  from the first painted frame, it would otherwise appear and vanish
  within a few frames on a fast boot, which reads as a glitch. The floor
  governs the overlay only; everything behind it is already live.
- Honours `prefers-reduced-motion`: still mark, no rings.

## 0.6.9 (2026-07-28)

Idle CPU. The app used a few percent of a core while sitting there doing
nothing, which came down to loops that never stopped and a cache that
expired too eagerly.

- Two animation loops re-armed themselves at the display refresh rate
  even while playback was stopped: the timeline playhead and the mini
  player's seek bar. Neither can move while paused, so both were
  redrawing the same pixels sixty times a second. They now poll slowly
  while paused and return to animation frames the moment playback
  resumes. Because the window is created with background throttling
  disabled, this was burning CPU even while minimised - both loops now
  back off further when the window is hidden.
- Locating the Python interpreter costs several child processes and the
  answer was only cached for a minute, so anything polling the app
  re-probed every minute forever. The cache now lasts ten minutes and an
  interpreter still present on disk simply renews it. Setup, repair and
  breaker resets already clear the cache, so nothing stale can hide.
- The health endpoint is polled continuously by both the app and the
  extension and logged every single hit - thousands of lines a day and a
  permanently busy log file. Now logged once per hundred.
- A release check fails the build if any self-rearming animation loop
  loses its idle guard, or if one of their timer handles is used before
  it is declared. Fixing this section produced exactly that
  use-before-declaration fault, which would have crashed the renderer on
  load.

## 0.6.8 (2026-07-28)

A cascade failure caught in a real download session, plus its cleanup.

**The folder watcher was stealing downloads in progress.**
Downloads stage into a hidden `.fp-dl-*` directory inside the output
folder so the finished file can be renamed onto the same volume. When
that output folder sits inside the watched stockpile - downloading
straight into a category folder - the watcher saw the half-written file,
adopted it as a new track named after the video ID, and moved it out.
The download that was still running then could not find its own output,
so it failed and retried, producing duplicate entries, duplicate files
and fingerprint and tag errors reading "file not found". The watcher now
ignores staging directories entirely; the download registers its own
track when it finishes.

**Repairing one package could take out every engine.**
Repair mode runs through the same script as full setup, and the embedded
runtime provisioning came first. Repairing a single missing package on a
machine without the embedded runtime therefore provisioned a brand new,
empty Python and installed only that one package into it. Because the
embedded runtime is preferred over system Python, every engine then
failed with "No module named numpy". This is the
`selfheal.repair-ineffective` report. Two fixes: repair mode never
provisions a runtime, it repairs whatever is already in use; and the
embedded runtime is only preferred once it actually contains the
analysis stack.

**Cleanup for libraries already affected.**
Settings gains "Fix entries named after video IDs": it fetches the real
title from each affected track's source URL and renames the file to
match. The audio was never wrong, so nothing is downloaded again.

**Optimisation.** The library path scan walks every audio file under the
stockpile root - thousands of stat calls on a large library - and several
UI paths could request it simultaneously, which is why it ran twice
within half a second at startup. A clean scan is now reused for 20
seconds; anything that repairs a path invalidates it immediately.

## 0.6.7 (2026-07-28)

Follow-up to 0.6.6: the scripts are found now, but two of them were
missing dependencies nobody had ever installed.

**File tagging never had mutagen.**
`write_tags.py` needs mutagen and assumed it arrived as a transitive
dependency of audio-separator. It does not. The script reported this
correctly, but as JSON on stdout while the server only logged stderr,
so every failure looked like a blank "exited 1". Both handlers now log
stdout as well. mutagen is installed with the core numerical tier and
is part of engine verification, so machines that already ran setup pick
it up automatically through the existing self-repair at next launch.

**Fingerprinting needed librosa.**
Same story, and librosa drags in numba and llvmlite for what amounts to
one perceptual hash. Since no fingerprint has ever succeeded there are
no stored hashes to stay compatible with, so the fingerprinter is
rewritten on numpy and soundfile, which the app already installs. It
decodes through the bundled ffmpeg for formats soundfile cannot open.
Verified deterministic, and identical across an 8dB volume change.

**Sentry: a DSN in the example file is now used.**
Editing `sentry.config.example.json` instead of copying it to
`sentry.config.json` is the obvious thing to do, and it silently
produced a build with crash reporting switched off. Both the resolver
and the diagnostic now accept a real DSN from the example file, while
still rejecting the placeholder. The diagnostic reports which file the
DSN came from.

**Analysis cache visibility.**
The server log now states plainly whether opening a track was served
from cache or triggered a full analysis, and why.

## 0.6.6 (2026-07-28)

Three bugs found in a packaged-build log.

**Tags and fingerprints never worked in installed builds.**
`write_tags.py` and `fingerprint.py` were resolved to a path inside
app.asar. Node reads the archive transparently so the path looked
valid, but the Python child process cannot open it, and every call
died with "No such file or directory". BPM/key tags were never written
to any file, and no download was ever fingerprinted - which is also why
the Library doctor reported zero fingerprinted tracks. Both scripts now
ship as real files, and every Python spawn resolves through a helper
that guarantees an on-disk path, copying out of the archive when that
is the only copy. Existing libraries can catch up with the fingerprint
backfill offered by the Library doctor.

A release check now fails the build if any Python script is spawned
from an unresolved archive path or is missing from the packaged files,
so this class of bug cannot ship again.

**Engine verification crashed on every startup.**
`discoverPython()` returns a command string, and the verification code
treated it as an object, so it spawned `undefined` and threw
"The file argument must be of type string" - visible in the log as
"startup verify threw" and an unhandled rejection. Self-repair
therefore never ran and Verify engines never worked. Fixed to use the
same command/args contract as the rest of the file, with the spawn and
the endpoint both guarded so a failure can no longer surface as an
unhandled rejection.

**The extension is now offered directly, with no repository links.**
Settings > Extension leads with a Get the extension button that copies
the bundled folder into Downloads, and the install guide does the same.
Every link that sent people to the GitHub releases page has been
removed, including the fallback that opened it when a download failed.
Wording no longer mentions zips or unzipping, because neither is
involved any more.

**Opening a history track showed "analyzing..." for ten seconds.**
The track's BPM and key were already in the database the whole time.
They now appear immediately, marked as refreshing, while the full pass
fills in loudness, sections and the rest.

## 0.6.5 (2026-07-28)

The app now keeps the Chrome extension up to date.

Chrome only auto-updates extensions installed from the Web Store, and
it cannot hot-swap an unpacked extension while it is running. What it
does do is re-read an unpacked folder on startup, so the app keeps that
folder in sync and Chrome applies the change the next time it opens.

- The unpacked copy now installs to a fixed folder name. Chrome derives
  an unpacked extension's ID from its path, so a versioned folder name
  would have produced a new ID on every update and forced the user to
  add the extension again. The path is remembered in settings.
- Twenty seconds after launch, if the installed copy is older than the
  one bundled in the app, its files are refreshed in place and a
  notification reports the version change and asks for a Chrome
  restart. Silent when there is nothing to do.
- Settings > Extension shows both versions (bundled and installed) and
  has a Check now button that syncs on demand.
- Only files the extension owns are replaced; anything else the user
  left in that folder is untouched.
- New endpoints: GET /extension/status, POST /extension/update.

## 0.6.4 (2026-07-28)

The Chrome extension now ships inside the app.

- The extension source lives in the desktop repo (`extension/`) and is
  bundled into the build, so "Get the extension" no longer depends on a
  GitHub release having the right asset attached. It copies the folder
  straight into Downloads, works offline, and always matches the app
  version. Chrome's Load unpacked wants a folder rather than a zip, so
  this also removes the manual unzip step.
- `POST /extension/download` accepts `{source:'github'}` to force the
  old behaviour of fetching the newest release asset, and still falls
  back to it automatically if the bundled copy is missing.
- `GET /extension/info` reports whether a copy is bundled and which
  version.
- The release workflow now zips the extension and attaches it to the
  GitHub release automatically, so the standalone download exists for
  people who are not running the desktop app yet.
- The bundled folder is excluded from the asar archive: extraResources
  puts a real folder on disk, and recursive copies out of a virtual
  asar path are not reliable.

## 0.6.3 (2026-07-28)

French localisation audit.

- Restored accents across 109 French strings. Everything added since
  0.4.1 had been written in bare ASCII ("Evenement envoye", "Verifier
  les moteurs"), which read as broken French next to the app's original
  properly accented text.
- Fixed one grammar error the accent pass itself introduced:
  "Desactivez" (imperative) had become "Désactivéz" instead of
  "Désactivez".
- The Stockpile smart-folder button label and tooltip were hardcoded
  English and never passed through the translation layer. Now localised
  like every other control.
- Release checks now include a French quality gate: accent-less French
  vocabulary, invalid verb endings, untranslated values identical to
  English, and mismatched {placeholders} all fail the build.

## 0.6.2 (2026-07-27)

Field-testing fixes from the 0.6.1 build.

- Library doctor and smart-folder dialogs were invisible: the markup
  used a modal box class that does not exist in the stylesheet, and the
  overlay never received the inline display that activates its
  backdrop. Both now use the app's real setup-card structure.
- The file-tags and auto-rename toggles reset to off when leaving and
  reopening Settings. Saving worked; the hydration call had been
  attached inside an unrelated event handler instead of the settings
  renderer, so the checkboxes re-rendered blank. Hydration now runs on
  every settings render.
- Analysis could sit on "Running analysis engine..." indefinitely if
  the Python child hung. The server now kills the child after 180s and
  emits a proper error (with a Sentry report, category analyze.timeout),
  and the renderer has its own 200s watchdog that falls back to the JS
  BPM/key estimator and points at Verify engines.
- Library doctor with zero fingerprinted tracks now explains that
  nothing can be compared yet and offers a one-click fingerprint
  backfill, instead of reporting a meaningless "all clear - 0 tracks".

## 0.6.1 (2026-07-25)

**Real waveform in the analyzer timeline**

The section timeline now renders the track's actual waveform - min/max
peaks computed in one pass over the already-decoded audio buffer
(~1000 columns, mono mix, stride-sampled so a 10-minute WAV costs
~15ms). Painted as a pointer-events-free canvas layered over the
section colors, so scrub clicks and section tints work exactly as
before; the timeline grew from 18px to 30px so the shape reads.
Repaints on window resize (debounced) and on every new decode.

**Tag-and-forget releases (GitHub Actions)**

`.github/workflows/release.yml`: push a tag like `v0.6.2` and GitHub's
own Windows runner builds the app, fetches bundled binaries, writes the
Sentry config from a repo secret (`SENTRY_DSN` - set once in repo
Settings > Secrets > Actions), and publishes a draft release with the
installer + latest.yml + blockmap attached. No local tokens ever again.

**Extension 4.4.0**

Compatibility audit against the 0.6.x server contract passed clean (the
extension's playlist grabber already enqueues per-video URLs, so the
server's playlist-URL guard never affects it). Picked up the new
download phase field: "Converting…" label during the ffmpeg step and a
monotonic progress guard, matching the desktop queue.

**Validation**

Release checks now cover syntax on all entry points, Python AST, EN/FR
string parity, installer script byte integrity, route registration
order, and packaged file content. This round the content check caught
and removed a duplicated translation key.

**Opening a track from History is now instant**

Every open was re-running the full analysis pipeline - Python spawn
(~1s of imports alone), decode, BPM/key/loudness/beat-switch - because
the DB only stored the headline numbers. The complete analysis result
is now cached in the DB (`history.analysis_json`, keyed to the file's
mtime) and served on reopen in ~50ms: same metrics, same sections, same
timeline, zero spawn.

- Both producers write the cache: the interactive analyzer and the
  background worker.
- The cache invalidates itself when the file changes on disk (mtime
  drift > 2s) or goes missing - those cases re-analyze exactly as
  before.
- The forced beat-switch re-detect always bypasses the cache: an
  explicit re-run request means fresh computation.
- Diagnostic log says which path served the result
  ("loaded from cache (instant)" vs "running full analysis").
- Bounded by design: results are ~2-4KB each (scalars + per-30s section
  summaries, no waveforms), 400KB hard cap per row, and an LRU ceiling
  of 1500 cached rows (~5MB total). Least-recently-opened entries beyond
  the cap lose only their cache blob - the row, BPM and key stay - and
  re-cache on next open. Matters because sql.js rewrites the whole DB
  file on save; the cache can never balloon that write.

## 0.5.0 (2026-07-21)

**Live spectrum analyzer: measurement-grade pass**

- FFT 16384 (was 8192): ~2.9Hz bins. The entire 20-40Hz octave used to
  live in ~3 bins - that was the staircase at the low end.
- Both channels analyzed, combined in the power domain ((pL+pR)/2).
  Previously only LEFT was read: side-heavy content measured up to 3dB
  low and right-only elements were invisible.
- Inverse bin mapping: wide visual bins take the max over their FFT
  span; narrow (low-freq) bins interpolate between the two straddling
  FFT bins at their geometric center. Replaces the forward snap +
  copy-neighbor fill that plateaued the bass region.
- The long-average curve now does its EMA in the power domain. dB-domain
  averaging is a geometric mean of power and read several dB low on
  dynamic material.

**More accurate loading bars**

- Engine setup: trickle interpolation between step events, paced by
  per-step measured ETAs. The torch step no longer freezes the bar at
  one number for five minutes - and the trickle is capped (+8, ceiling
  97) so a genuinely stalled step visibly stalls instead of lying.
  Real events always win; the bar never moves backwards.
- Downloads: yt-dlp's percentage only ever covered the raw stream.
  Download now occupies 0-92, [ExtractAudio] raises to 96 with a
  "Converting…" phase label, done carries 100. Monotonic guard drops
  out-of-order SSE updates around the phase transition.

**Private embedded Python runtime**

Every real-world support case - multiple users, every Sentry event -
traced back to the machine's own Python: MS Store aliases, PATH damage,
incompatible versions, admin-locked installs. 0.6.0 stops depending on
it. Setup now provisions the official python.org embeddable package
(3.11.9, ~11MB, fully self-contained) into
`%LOCALAPPDATA%\freqphull\engines\python\`:

- No registry, no PATH, no admin, no installer UI.
- Nothing the user installs, uninstalls, or upgrades later can touch it.
- The `._pth` site-enable and get-pip bootstrap (the two classic
  embeddable-package traps) are handled, with the same multi-retry
  robust downloader as everything else.
- `discoverPython()` prefers the embedded runtime unconditionally when
  present. System Python probing survives only as a fallback for
  offline-first-run machines.

**Engine verification and automatic repair**

- New `verify_engines.py` import-checks every tier (core analysis /
  stems / whisper) with native-lib smoke tests (torch tensor op catches
  missing VC++ DLLs that plain import misses), and reports the exact
  pip packages that are broken.
- `setup-engines.ps1 -Repair -Packages a,b` force-reinstalls precisely
  those packages (`--force-reinstall --no-cache-dir`), reusing every
  hardening lesson in the script. Repair refreshes the ready marker's
  `last_repair` date but never creates the marker - only full setup may
  claim readiness.
- 15 seconds after boot, if engines were ever set up, the server
  verifies them and silently repairs anything broken. The user whose
  install worked yesterday and got AV-quarantined overnight is fixed
  before they notice. At most one automatic attempt per session; a
  quiet toast on start, a green one on success - only failure is loud.
- Settings gains **Verify engines**: on-demand deep check with a
  one-click repair offer when something is broken.
- New Sentry categories `selfheal.repair-failed` and
  `selfheal.repair-ineffective` so unfixable machines surface remotely
  with the package list attached.


**Richer crash-report payloads**

Every soft-error event gains a `machine` context (OS release, arch, CPU
model + cores, total/free RAM, process uptime) and clean grouping -
events fingerprint by category, so five different exit codes make one
`setup.failed` issue with five events, not five issues.

Per-category payloads:

- `ytdlp.*` - yt-dlp version (cached `--version`), format, URL kind
  (bare video vs video-in-playlist). Answers "stale binary?" instantly.
- `bg-analyze.python-crash` - exit code, file extension + size,
  duration, classifier verdict, last 1200 chars of stderr.
- `bg-analyze.parse-failure` - stdout AND stderr tails, file extension.
- `bg-analyze.ffmpeg-failure` - file extension, size, exists-on-disk.
- `transcribe.failed` - model, language, upload size (whisper's stderr
  already rides in the exception message via run()).
- `backend.crash-loop` / `fatal-startup` - packaged flag, uptime,
  userData drive letter.

**setup.failed events now include the setup log**

First real-world Sentry event exposed a blind spot: the `setup.failed`
soft report only attached `stderrTail`, but setup-engines.ps1 writes
its diagnostics to `%TEMP%\freqphull-setup.log`, not stderr - so remote
events arrived saying "exit 1" and nothing else. The handler now reads
the log tail once and attaches it to the event (`setupLogTail`, last
~1800 chars, PII-scrubbed like everything else), along with the exit
code. The same read feeds the in-app diagnostic modal, replacing a
duplicate file read.


**Bulk download filename collisions eliminated**

0.4.3's staging directories fixed cross-download races, but filenames
inside staging were still title-derived (`%(title)s.%(ext)s`) - yt-dlp's
title sanitization was the collision source. Downloads are now staged as
`%(id)s.%(ext)s`: video IDs are unique by definition, so two tracks can
never fight over a filename no matter what they're called. The human-
readable name is applied at promote time from fetched metadata, through
a Windows-safe sanitizer (illegal chars, trailing dots, 150-char cap).

**Playlist URLs handled properly**

yt-dlp silently ignores `--no-playlist` on playlist-only URLs (no `v=`
component) - one of those would have dumped the entire playlist into a
single staging dir, recreating the collision bug. Three layers now:

- `/info` detects playlist-only URLs and expands them via
  `--flat-playlist --dump-single-json` (one fast metadata pass, capped
  at 500 entries).
- The renderer queues every entry as its own download - paste a
  playlist URL into the Download tab and the whole thing queues, each
  track through its own isolated staging pipeline. Re-pasting skips
  tracks already queued.
- `/download` rejects playlist-only URLs outright (`playlist_url` code),
  and a leak guard refuses to promote when staging somehow contains
  more than one audio file - with a Sentry soft-report
  (`download.playlist-leak`) so we hear about it.

Note for existing libraries: these fixes prevent NEW corruption. Files
damaged before 0.4.3 are still on disk - run Settings > Library doctor
to find and re-download them.


**Library doctor**

Settings > tools row: scans the library for rows sharing near-identical
audio (hamming <= 25 bits) under DIFFERENT titles - the damage signature
of the pre-0.4.3 bulk-download bug. The oldest row in a group is the
presumed owner of the audio; newer rows with other titles are suspects.
Each suspect gets a one-click **Re-download**: fetches the correct audio
from the row's own youtube_url into the same folder (through the normal
download pipeline, so it's analyzed and fingerprinted like anything
else), then removes the corrupted row. `GET /history/doctor` backs it.

**Timeline scrubber + live playhead**

The section timeline in Analyze is now a real transport control: click
anywhere to seek proportionally (per-section clicks still snap to
section starts), with a live playhead line tracking playback via rAF -
self-terminating when the markup leaves the DOM. Tracks with no beat
switch detected get a plain scrub bar with the same mechanics, so every
analyzed track is seekable from the timeline.

**Auto-rename with BPM/key**

New opt-in setting: after analysis, files are renamed to
`Title [140BPM Cm].ext`. Skips files already stamped (`[..BPM..]` in the
name), skips locked files (EBUSY/EPERM - open in a DAW), collision-safe,
updates the DB path, broadcasts history-changed so every window updates.
Off by default.
The existing write-tags feature also gained a proper Settings toggle
(both backed by `GET/POST /file-tags-pref` writing settings.json).

**Smart folders**

Stockpile gained rules-based folders: name + BPM range + key + mode,
stored as JSON in a new `stockpile_folders.smart_rules` column
(guarded migration). The folder tracks endpoint evaluates rules live
against history, so a smart folder never goes stale - a new 142 BPM
minor-key download appears in "Dark trap 130-150" the moment analysis
lands. Created via the ⚡ Smart button next to New folder.

## 0.4.3 (2026-07-11)

**Bulk download corruption fixed (wrong audio under the right name)**

Parallel/playlist grabs could pair track B's title with track A's audio.
Root cause: yt-dlp wrote `%(title)s.%(ext)s` into the shared output
folder, and when a second download's sanitized title collided with an
existing file, yt-dlp skipped the download ("already downloaded") and
reported the first file's path — so the second history row pointed at
the first track's audio. Fix: every download now runs in its own
`.fp-dl-*` staging subdirectory (collisions impossible), then the file
is promoted into the output folder with a collision-safe rename
(`name (2).mp3`, `name (3).mp3`, ...). Stale staging dirs from crashed
runs are swept after 1 hour. Failure paths clean up their staging dir.

**v0.4.1 CSS actually shipped this time**

The 0.4.1/0.4.2 stylesheet block (context menu, toast count badge,
clipboard paste hint) silently missed its injection anchor and never
landed — which is why the FR download page showed the paste hint as raw
unstyled text crashing into the Fetch button. All of it is now in the
main stylesheet, and the paste hint is absolutely positioned below the
URL row instead of inline (no more overlap in either language).

**Boot splash**

The window now paints instantly with a pulsing HK monogram on a dark
background (pure inline SVG — zero asset dependencies) instead of a
black screen while the backend boots. Dissolves when app-ready fires.
BrowserWindow gets `backgroundColor:#0b0b0b` so there is no white flash
before first paint. Splash animation honors `prefers-reduced-motion`.

**Accessibility**

- `:focus-visible` outlines for keyboard users (mouse clicks stay clean).
- `prefers-reduced-motion: reduce` disables all decorative animation
  app-wide, including the splash pulse.
- 21 icon-only buttons had their `title` mirrored into `aria-label`;
  6 more (window chrome, play, separator controls) got explicit labels.
- History context menu is keyboard navigable: arrows move, Enter
  activates, Esc closes.
- Toasts announce via per-element aria-live (asserted errors, polite rest).

**Performance**

- History search debounced 120ms — typing a 9-char query is now 1-2
  renders instead of 9.
- `content-visibility:auto` on history rows: the browser skips layout
  and paint for offscreen rows entirely. Biggest win on 1000+ track
  libraries.
- `will-change` on progress fills and toasts so they composite on the
  GPU instead of relayouting.

## 0.4.2 (2026-06-25)

Sentry test reliability fix.

- The test button was sending `captureMessage('info')`, which Sentry
  silently hides from the default Issues view. Events arrived but
  weren't visible unless you knew to look in Discover / All Events.
  Now sends a real `captureException(new Error(...))` at error level,
  tagged `test:true`. Lands in Issues immediately.
- Diagnostic readout now shows DSN host + project ID extracted from
  the configured DSN. Use these to verify you're checking the right
  Sentry project (most "test sent but I see nothing" reports are wrong-
  project mismatches).
- `flush()` timeout is now 4s (was 2s) and the result is surfaced. If
  the event was queued but delivery wasn't confirmed (firewall etc.),
  the toast says "queued — check Sentry in 1-2 min" instead of claiming
  it sent.

## 0.4.1 (2026-06-25)

UX polish pass — no design changes, just things that should have been there.

**Keyboard shortcuts.** `/` and `Ctrl+F` focus the visible search input.
`Esc` closes any open modal, and if no modal is open, clears the focused
search input. `Ctrl+1` through `Ctrl+9` switch tabs (analyze, transcribe,
separator, master, history, stockpile, settings).

**History search wrapper.** The search input now sits in a relative
container with a result counter (`5 / 142` on the right of the field
while searching) and an `×` clear button. Both hide when the search is
empty. The native `::-webkit-search-cancel-button` is masked so we have
one consistent control instead of two competing ones.

**Right-click context menu on history rows.** Eight actions: Open in
Analyze, Send to Stem Separator, Send to Transcribe, Favorite/Unfavorite,
Copy title, Copy source URL, Show in folder, Remove from history.
Auto-dismisses on scroll, resize, outside click, or Esc.

**Clipboard URL paste suggestion.** When the URL input gets focused
and (a) it's empty AND (b) the clipboard contains a YouTube URL, an
inline hint appears below the input with a one-click `Paste` button.
Recognizes youtube.com/watch, /playlist, /shorts, /embed, and youtu.be.
Auto-dismisses after 8 seconds.

**Toast deduplication.** Identical toasts now stack into a single
notification with a `×N` counter badge instead of cluttering the corner.
The timer resets each time so you can see when the latest one fired,
and a brief scale-pulse signals the bump. Fixes the screenshot-of-four-
identical-errors case.

**Extension download 404 redirect.** When `/extension/download` returns
404 (no extension asset attached to the latest release yet), the app
now opens the releases page automatically with an info toast — instead
of just showing a red error. Releases need an attached
`freqpull-ext-vX.X.X.zip` to enable the one-click download path.

## 0.4.0 (2026-06-25)

**Sentry, end-to-end verifiable**

- DSN baking via `sentry.config.json`. Drop a file next to the app with
  `{ "dsn": "..." }` and electron-builder bundles it into the build. The
  module reads it at runtime from `__dirname` or `process.resourcesPath`.
  `FREQPHULL_SENTRY_DSN` env var still works as a higher-priority
  override for dev/CI. File is gitignored.
- `sentry.config.example.json` template included as a starting point.
- Settings > Privacy: two new buttons. **Run diagnostic** shows DSN
  status (present? source? package installed? Sentry active?) and the
  last test event ID. **Send test event** fires `captureMessage` and
  awaits `flush()` so you can verify the round-trip without provoking a
  real crash.
- Server endpoints `/sentry-status` and `/sentry-test` back the buttons.
  Test endpoint stashes the most recent event ID so the diagnostic
  readout can show what was sent.

**Update window UX**

- Progress detail line: `12.3 / 87.5 MB · 3.2 MB/s · 28s left`. ETA
  computed from remaining bytes / current bytes-per-second.
- Smoother progress fill via CSS transition.
- Error state with diagnostic message and **Try again** button. The
  retry triggers a fresh `checkForUpdates()` round.
- "Download complete" confirmation line when ready to install.
- updater.js now relays `update-error` events from electron-updater
  through the same state pipe.

**Extension distribution**

Users no longer need to clone or zip-download the whole repo to install
the extension. New `POST /extension/download` endpoint:

- Fetches the latest release via GitHub API
- Finds the `freqpull-ext-*.zip` asset
- Streams it to `~/Downloads` (or `%TEMP%` as fallback)
- Returns the local path

The how-to wizard's first step now shows **Download extension zip**
as the primary action, with **Open releases page** as a small fallback.
A click on the success toast opens the containing folder.

**Engine setup**

- Disk space preflight: bails before download with a clear error if the
  user profile drive has less than 3.5 GB free. Saves the user from a
  failed install 2 GB into the torch download.
- More setup-engines.ps1 narrative comments collapsed to terse summaries
  (VC++ install block, Step 1 Python detection block, Invoke-RobustDownload
  preamble). Pure ASCII + CRLF preserved.

## 0.3.9 (2026-06-23)

- Crash reporting is now always on. The toggle was removed entirely and replaced with an informational disclosure in Settings > Privacy: what's sent (anonymized stack traces, app version), what's scrubbed (file paths, usernames, YouTube URLs), what's never sent (audio, library content, personal data). FREQPHULL_NO_CRASH_REPORT=1 still works as a dev-only escape hatch.
- Why we dropped the toggle: the toggle UI hydrated from `/prefs` which returns sql.js TEXT values as strings, and `!!"0"` is `true` in JS — so toggling off then reopening Settings would show ON. Plus a fresh install with no DB pref entry would show OFF even though the actual default was ON. The dedicated `/crash-report-pref` endpoint we added intra-version still had a stale-state edge case after the app was closed. Removing the toggle removes the bug class entirely.
- Startup migration: stale `privacy.json` from previous opt-in/opt-out builds is deleted at startup so it doesn't sit in userData forever as dead state. Plus the toggle defaulted to OFF because there was no DB pref to read while the actual state (privacy.json) said ON. Dedicated `/crash-report-pref` GET/POST endpoints now read and write `privacy.json` directly, with clean boolean responses. `user_set` flag distinguishes a default-ON state from an explicit user choice, so the first-run notice only shows when the user really hasn't decided. Toggle now snaps back to the actual persisted state if the save fails.
- Transcribe no longer auto-starts. Dropping or picking a file now stages it (shows the filename in status) and enables a Start button. User picks model + language, then clicks Start.
- Removed "powered by Whisper" from the transcribe subtitle. New copy: "Convert audio to text - runs locally, offline."
- Crash reporting default flipped to ON (opt-out). First-run shows a one-time toast disclosing it; click it to jump to Settings > Privacy and opt out. `localStorage.fph_crash_notice_seen` flag means it only fires once per renderer install.

## 0.3.8 (2026-06-22)

**Sentry crash reporting (opt-in).**

- `sentry-init.js` module shared by main, renderer, and server processes.
- Disabled by default. Enable from Settings → Privacy; opt-out via env
  var (`FREQPHULL_NO_CRASH_REPORT=1`) or by leaving the build's DSN unset.
- PII scrubber strips `C:\Users\<name>`, `/home/<name>`, `/Users/<name>`
  from `event.message`, exception values, stack frames, request URLs,
  and breadcrumbs before transmission.
- Settings UI toggle writes `privacy.json` to userData. main.js reads it
  before any child process is forked and propagates via env var so all
  three processes pick it up.
- Sentry packages are optional dependencies (`@sentry/electron`,
  `@sentry/node`) so the app builds without them. Crash reporting is
  silently inactive if the packages aren't installed.

**Soft-error reporting.**

In addition to uncaught crashes, ten soft-error sites now call
`reportSoftError(category, err, context)` when something fails without
crashing. Rate-limited at 10 events per category per hour, per process,
so a single broken machine can't burn the quota.

| Process | Category | Fires when |
|---|---|---|
| node | `bg-analyze.python-crash` | analyze.py exits non-zero with engines installed |
| node | `bg-analyze.parse-failure` | Python exits 0 but stdout isn't valid JSON |
| node | `bg-analyze.ffmpeg-failure` | ffmpeg decode step throws |
| node | `ytdlp.forbidden` | 403 after Android-client retry |
| node | `ytdlp.signature-broken` | YouTube changed signatures, retry didn't help |
| node | `setup.failed` | setup-engines exit non-zero |
| node | `transcribe.failed` | whisper crashes |
| main | `backend.crash-loop` | backend hit the 5-restart cap |
| main | `backend.fatal-startup` | __FREQPHULL_FATAL__ marker (port collision, etc) |
| renderer | `renderer.download-failed` | user sees a download error toast |
| renderer | `renderer.setup-error-shown` | user sees the setup-error modal |

Categories that aren't useful for action (geo-blocked videos, age-gated,
deleted, etc) are NOT reported.

**Installer scripts trimmed.**

- setup-engines.ps1 lost its essay-style preamble + per-step narrations.
- Sanity-verified: pure ASCII, CRLF line endings preserved.

## 0.3.7 (2026-06-22)

**Performance pass.**

- `saveDB()` debounced. sql.js holds the database in memory; every call was
  serializing the whole blob and `fs.writeFileSync`-ing it synchronously. With
  `dbRun()` calling `saveDB()` after every insert, a 5000-row library was
  writing 5+ MB to disk on every history change. Now coalesces over a 500ms
  window with a force-flush on `beforeExit` / SIGTERM / SIGINT.
- Logger buffered. `slog()` was doing `fs.existsSync(logDir)` then
  `fs.appendFileSync(logPath, ...)` synchronously per call. The existsSync is
  cached now (set once at startup), and writes batch into a 200ms flush.
  Force-flush on every exit path including uncaughtException.
- Renderer SSE deduped. The fingerprint backfill flow was opening a second
  `EventSource` to `/events`, which made the server broadcast every event to
  the same renderer twice. Reuses the main connection via a one-shot listener.

## 0.3.6 (2026-06-22)

**YouTube 403 / signature errors now auto-retry on the Android client**

- New `attachListeners(p)` factored out so the first attempt and the retry share
  the same stdout/stderr/close handling.
- Classify the failure from stderr: 403 / signature-broken → retry with
  `--extractor-args "youtube:player_client=android,web"`. Video-unavailable,
  members-only, geo, age-restricted → fatal, no retry.
- After a retry that still fails, surface a human message instead of raw
  yt-dlp stderr. Toasts on yt-dlp-related errors are clickable and jump to
  Settings → Updates with the right section auto-expanded.

**Loop icon now pixel-perfect**

The previous redraw was still stroke-based, which fights subpixel rendering at
14px on high-DPI displays (effective stroke ~1.4px, doesn't grid-align,
antialiases across two rows). Replaced with a filled silhouette at viewBox
14×14 (1:1 with rendered size), integer coordinates, no curves. Material
Design two-arrow repeat shape, crisp at any DPI and in compact mode.

---

## 0.3.5 (2026-06-22)

**Whisper tuning for fast vocals**

Six extra flags on the whisper invocation:

- `--beam_size 5 --best_of 5` — multi-candidate decoding.
- `--condition_on_previous_text False` — stops error cascades on dense lyrics.
- `--no_speech_threshold 0.3` — keeps quiet ad-libs the default 0.6 drops.
- `--word_timestamps True` — DTW alignment tightens word boundaries.
- `--hallucination_silence_threshold 2.0` — drops "thanks for watching" tails.
- `--fp16 False` — explicit for CPU compatibility.

**Bilingual mode**

New "Bilingual (FR + EN)" option in the language picker. Skips `--language` so
whisper detects per-segment, with an initial_prompt biasing toward FR+EN
hip-hop slang. Plain Auto-detect commits to one language for the whole file,
which mistranscribes code-switching tracks.

**Visible transcribe progress**

- File-size + model-RTF ETA shown up front: "Transcribing — ~3 min (model: base)".
- MM:SS elapsed timer, tabular-nums.
- Phase rotation every 15s: load model → listen → decode → align → finalize.
- Completion shows total: "Transcription complete in 2:47". EN/FR localized.

**UI cleanup**

- Dropped "Runs via OpenAI Whisper" branding; reworded to "Runs locally —
  no audio or text leaves your machine."
- Dropped four stale "AI Transcribe Setup.exe" references (HTML info-note,
  two app.js error paths, one server.js hint). All now point at
  Settings → AI engines → Re-run setup.

**Extension thumbnail fallback**

History rows can have stored `maxresdefault.jpg` URLs that 404 on non-HD
videos. New `fphThumbFallback(img)`: max → hq → mq → hide. `hqdefault.jpg`
exists for every YouTube video. Extension to 4.3.2.

**Install/setup hardening (eight bugs)**

1. Setup script `fs.copyFileSync` was unguarded against EBUSY/EACCES (AV scan,
   OneDrive, parallel instance). Bounded retry: 100ms, 250ms, 500ms, 1000ms,
   then a hint distinguishing locked-file from unwritable-tmp.
2. `tripEnginesBrokenBreaker()` now short-circuits when `setupRunning` is true.
   An in-flight worker that fails during setup with `ModuleNotFoundError` is
   expected, not signal.
3. Orphan PowerShell detection. The spawn writes a PID file; every server
   start probes the PID with `process.kill(pid, 0)` and tree-kills any live
   one from a prior crash.
4. Watchdog: if no setup event for 5 minutes, emits a "stalled" status so
   users can tell hung from slow.
5. PowerShell launch errors: ENOENT → "install PowerShell 7", EACCES →
   "AppLocker or IT policy is blocking PowerShell, try as Administrator".
6. `killSetupProcessTree()` actually shipped this time (was claimed in 0.3.4
   but never landed). `/setup-cancel` cleans up the leftover PID and tmp
   marker files.
7. Renderer `startEnginesSetup()` got a 1.5s reentrancy guard.
8. Startup sweep of stale `engines-ready.json.tmp` files older than 5 min.

---

## 0.3.4 (2026-06-21)

**Setup-failure diagnostics**

Mqxence's logs were showing `setup-engines: exit 1` with no detail. Pip output
was being piped only into the script's local log file in `%TEMP%`, never
reaching the server. Three diagnostic paths now:

- `EmitError` reads the tail of `freqphull-setup.log` and ships it in the
  error event's `log_tail`.
- Server, on any non-zero setup exit, reads the same log directly and dumps
  the last 50 lines into the server log with `[setup-log]` prefix.
- Renderer: setup-error modal has a collapsible "Show diagnostic log" with
  a "Copy to clipboard" button.

**Atomic marker write**

`engines-ready.json` was written via `WriteAllText`, which is not crash-safe.
A kill mid-write left a partial fragment that `JSON.parse` chokes on, and the
server then thought setup had failed. Now writes to `.tmp` + `Move-Item -Force`
to the final name.

**Tree kill on setup cancel**

`setupProc.kill()` only signaled PowerShell, not its python.exe / pip
grandchildren. New `killSetupProcessTree()` uses `taskkill /T /F` on Windows.

**bg-analyze pauses during setup**

`nudgeAnalysisWorker()` returns early when `setupRunning`. Without this, a
download arriving during setup would spawn analyze.py against an incomplete
Python env and trip the engines-broken breaker, showing a "deps missing"
toast while setup was visibly running.

**Pip cache poisoning recovery**

New `Invoke-PipInstall` helper: any failure auto-retries with `--no-cache-dir`.
Catches corrupt wheels in `~/.cache/pip` from a previously-broken install.

**Loop icon redraw**

Switched from 24×24 viewBox @ 14×14 stroke to 16×16 viewBox @ stroke-width
1.6. (Superseded by 0.3.6's filled-silhouette fix.)

**Fatal-marker parsing**

`msg.split('__FREQPHULL_FATAL__')[1].trim()` could pull trailing log lines
into the error dialog. Take only up to the first newline.

**Backend crash-restart cap**

Capped at 5 consecutive restarts. The 6th surfaces a dialog ("backend has
crashed 5 times in a row, possibly AV-quarantined") and exits.

**Python launcher args propagated through every spawn**

When `discoverPython()` cached `{cmd: 'py', args: ['-3']}`, the seven spawn
sites were passing the bare command without the args. Fixed at all seven.

---

## 0.3.3 (2026-06-20)

**Engines-broken breaker, widened**

The 0.3.2 patch notes claimed a Python-missing breaker but the function and
state variables were never actually defined in source (call sites would have
thrown `ReferenceError` the moment exit-9009 fired). Built for real this time.
Now covers both Python-missing and `ModuleNotFoundError` / `ImportError`.

Classifier extracts a reason + detail from any Python failure:

- exit 9009 / "Python was not found" / "Microsoft Store" → python-missing
- `ModuleNotFoundError: No module named 'X'` → deps-missing, detail=X
- `ImportError: cannot import name 'X'` → deps-missing, detail=X

`/bg-analyze/status` returns `breaker_tripped` / `breaker_reason` /
`breaker_detail`. Renderer drives a per-reason toast and a diagnostic strip
in Settings → AI engines from this.

**setup-engines.ps1: numpy preflight**

New Step 2.5 installs numpy / scipy / scikit-learn / soundfile before torch.
A clean 30-second failure when pypi is unreachable is much better than a
cryptic torch error 200 MB into a 250 MB download. Dropped `--quiet` from
all four `pip install` calls so the log captures the real error. Re-sanitized
to pure ASCII + CRLF (PowerShell parser requirement).

**Analyzer header**

Caught my own emoji-to-SVG sweep injecting SVG markup into nine
`.textContent` assignments — rendered as literal `<svg ...>` text on screen.
Rebuilt the badge as a clean array of text segments joined with a separator.
Added a runtime `textContent` guard that strips `<svg>` from any assignment
and logs a stack trace, so future regressions are loud.

**Beat-switch detector**

False positives are worse than false negatives — a flagged switch is an
authoritative claim. Six changes:

- Novelty window W=12 (was 8). Closer to verse-length scale.
- Sigma threshold 1.7 (was 1.4). Drops borderline noise.
- Minimum peak distance 30s (was 20s).
- Minimum section length 20s (was 12s).
- Require ≥2 of {BPM, key, harmony, energy, texture} to change. A single
  feature changing is a fill or a breakdown, not a switch.
- Cross-window validation: every surviving boundary gets re-tested with a
  ±25s wider lens. Single-block novelty spikes that don't replicate are noise.

New `texture` dimension catches drum-pattern shifts that leave chroma
unchanged. Common in hip-hop, missed by the chroma test alone.

---

Older entries available in git history. Earliest tracked: 0.0.8.
