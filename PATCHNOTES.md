# Patch notes

Changes since the BPM detector became the foundation. Latest first.

---

## 0.7.38 (2026-09-21) — public release

First public release since 0.7.37. Everything between them was internal (versioned 0.8.x/0.9.x while in development); this is the build that ships.

**Extension: fixed being completely dead on Opera.**

- Reported by a user: the in-page Freq.Phull button on YouTube did nothing at all.
- `background.js` opened with a bare `chrome.sidePanel.setPanelBehavior()` on **line 1**. `chrome.sidePanel` is a Chrome API (114+) — Chrome, Edge and Brave have it; Opera does not and never has, since it ships its own sidebar. On Opera that line threw a `TypeError` at the *top* of the service worker, before any listener below was registered.
- So the failure wasn't "the sidebar doesn't open" — the whole extension was dead on arrival: no `open-panel` handling, no active-tab sync, no update check. `content.js` was firing the message correctly and nothing was alive to receive it.
- **Fix**: feature-detect once, then route every open through `openPanel()` — real side panel where it exists, `panel.html` as a popup window everywhere else. Same page either way, so there's no second UI to maintain. Repeated clicks focus the existing window; the toolbar button gets an explicit click handler on browsers where nothing opens it natively. Verified against Chrome, Edge, Brave and Opera.
- Extension bumped to **4.5.0**.

**Topliner hidden.** The recording/autotune feature is not ready for public use — formant correction still colours the signal, and the native capture and low-latency monitor paths aren't built. Hidden, not removed: nothing is deleted or stubbed, and development continues against the same code. One CSS rule brings it back.

**Also in this release** (developed since 0.7.37):

- Capture no longer resamples every take. The AudioContext was inheriting the *output* device's rate, so a 44.1 kHz mic was being upsampled 2x before the engine saw it.
- Pitch correction could silently switch itself off. The reference the rejection logic compares against only updated on acceptance, so a rejection run could freeze it and deadlock — measured at 86% of hops rejected on one take.
- Octave-error rejection no longer lets a wrong octave through after a gap in tracking.
- Mic low-cut at 80 Hz, fixing sub-vocal rumble.
- "Pick a beat" no longer hangs outside the card, and reads considerably cleaner.
- Watch folder no longer re-adopts and re-analyses the same track forever.
- ffmpeg/yt-dlp failures now produce actionable messages instead of raw spawn errors.
- Background analysis can no longer wedge the queue forever on a stuck ffmpeg.
- Database indexes added (there were none), and the history payload slimmed.
- Engine verification now logs *why* a package failed, not just which.

---

## 0.9.10 (2026-09-15)

**Round 73 - Every take was being resampled 2x on the way in:**

- Reported as "audio sounds like shit, compressed, in a bottle... probably from the voice getting butchered in", with a request to capture the mic the way a DAW does.
- `rbEnsureWorklets()` constructed the AudioContext with **no options**, so it inherited Chromium's default rate — and that default follows the **output** device, not the microphone. The user's Focusrite was clocked at 44100; the context was running at 88200. Chromium was upsampling the mic 2x before the engine saw a single sample.
- Confirmed from the artifact, not assumed: the recorder worklet runs inside that context, and every WAV they sent carried an 88200 header while the interface was set to 44100.
- **This was not cosmetic.** Measured against a clean synthetic reference (`tools/diag-rate-formant.js`, with a bypass control reading 0.00 dB on every band at every rate to prove the method):

  | rate | formant boxiness | engine cost |
  |---|---|---|
  | 44100 | +5.2 dB | 0.24x realtime |
  | 48000 | +4.9 dB | 0.28x realtime |
  | 88200 | **+7.2 dB** | **0.43x realtime** |
  | 96000 | +7.3 dB | 0.53x realtime |

  The upsample was manufacturing ~2 dB of the exact coloration being reported, and doubling the CPU, while adding no information at all.
- **Fix**: read the rate straight off the mic track (`getSettings().sampleRate`) and build the context to match, in all three paths that open a mic — record, armed preview, monitor. The record path already opened the stream *before* creating the context, so the real rate was knowable there all along. Rebuilds when the device rate changes but never mid-session (closing a live context would kill the take — a mismatch found while recording waits for the next start), resets all three worklet-ready flags on rebuild, and falls back to a default context if a driver refuses the explicit rate, because recording at the wrong rate beats not recording. Both rates now go to the diagnostic log, so a future mismatch is visible from a user's machine instead of being inferred from a WAV header.
- **Settled this round so nobody re-litigates it: the formant coloration is not a resolution problem.** Three sweeps — all constants scaled together with `CEPSTRAL_MP_FFT_SIZE` sized correctly, each of `lpcOrder`/`envOrder`/`envTaps` alone, and 2-3x overkill — moved boxiness by at most 0.2 dB. And *more* spectral detail measurably made it **worse** (+2.0 dB at 48k, +1.7 dB at 88.2k). That is the signature of a higher-order fit tracking the excitation's harmonic peaks and re-imposing them on a signal whose pitch has already moved. Rounds 61/62/63/65 each tried to fix this complaint by tuning a constant; this round establishes with measurement why that class of fix can never work.
- Still open: the split-band formant rewrite (let the aperiodic/high band bypass the whiten → shift → recolor round trip) remains the only real route. Formant Correction stays OFF by default until it lands.
- 16 new regression tests (`tools/test-context-rate.js`). Gauntlet PASS 104. Zero regressions.

---

## 0.9.9 (2026-09-11)

**Round 72 - Found the actual cause of "boxy"/"in a bottle", and it is Formant Correction:**

- Confirmed by the reporter: "Formant off sounds better. No boxyness."
- **The measurement error that hid this for five rounds, stated plainly:** every previous investigation (Rounds 61, 62, 63, 65, and my own first two passes this round) compared processed audio against *other processed audio*. Every evidence file uploaded is app output. A control sample that has already been through the thing you are testing cannot reveal a constant coloration - and worse, the resulting "it measures the same across all takes" non-result was used to conclude the problem was the user's mic technique. It was not.
- With a genuinely clean reference signal, the result is unambiguous:

  | path | added boxiness | presence | sibilance |
  |---|---|---|---|
  | bypass | +0.0 dB | — | — |
  | pitch shift only (formant OFF) | +0.3 dB | -0.4 dB | -0.5 dB |
  | **formant ON** | **+3.7 dB** | **-3.3 dB** | **-3.4 dB** |

  Bypass measuring +0.0 dB on every band is the control that validates the method.
- **The engine is transparent when the input is already in tune** (+0.1 to +0.3 dB). The coloring scales with how much correction is actually engaged - which is exactly why "I matched the key" never helped anyone who reported this. Matching the key does not stop correction; the damage tracks correction *amount*, not correctness.
- **It is not a mistuned constant.** Swept directly: cepstral envelope order (40 through 120), FIR taps (80 through 200), the minimum-phase FFT size, the 20kHz output HF filter, and the grain size the formant path silently switches to (25ms vs 40ms vs 60ms). Sibilance loss stays pinned near -3.2 dB through every one of them. This is structural to the whiten -> pitch-shift -> recolor round trip: sibilance is *noise*, and noise does not survive being flattened by an LPC fit and re-shaped by a periodic envelope. That is why Rounds 61/62/63/65 each tuned a constant and each failed to hold.
- **No behaviour change shipped in this round.** Formant Correction already defaults to OFF and stays that way; this user had switched it on and it persisted in saved settings. What changed is the UI hint (it now states the measured cost instead of only the benefit) and a code comment recording the numbers, so the next round starts from evidence rather than repeating the constant-tweaking cycle.
- **Known issue, not yet fixed:** the real repair is architectural - split the signal and let the aperiodic/high band bypass the whiten/recolor round trip rather than being reconstructed through it. Deliberately not attempted as a quick patch here.
- Also measured and worth recording: this singer's fundamental runs 82-140Hz (median 122Hz), which sits right on the Round 68 80Hz mic low-cut - it attenuates their lowest sung note by 2.8 dB. Not a cause of boxiness (it removes low end), but an argument for making that cutoff adjustable.

---

## 0.9.8 (2026-09-11)

**Round 71 - Pitch correction could silently switch itself off ("no autotune even if key is good and formant off"):**

- Request: a fresh recorder take uploaded with "its has now no autotune even if key is good and formant off and sounds real harsh."
- First thing checked was whether Round 69 (the octave-staleness widening shipped two rounds ago) caused it. It did not: instrumenting the engine on this take attributes only **4 hops out of 1589** to that widening, 0.25% of the total. Ruled out before going further.
- The real cause, measured directly: **802 of 1238 hops were force-rejected by `MAX_JUMP_CENTS` alone**, and **597 of all force-rejections were high-confidence reads** (≥0.6) the engine should have trusted outright. Overall acceptance was **13.7%** — correction was barely running at all, which is exactly "no autotune".
- Why: every rejection path measures the candidate against `lastAcceptedPitchHz`, and that only ever updates **on acceptance**. Once a rejection run starts and the voice moves away from the frozen reference, every later hop reads as an enormous jump from it, is rejected for exactly that, and so keeps it frozen. A closed loop with no exit — `targetRatio` eases back to 1 and the dry signal passes straight through. From t=1.07s the detector reports a rock-steady ~700Hz at confidence 0.65-0.77, hop after hop, while the reference sits frozen near 100Hz: a ~3400-cent apparent jump, every hop discarded. Longest unbroken rejection run: **148 hops (~1.7 seconds)**. Reference staleness reached **3529ms**.
- The existing divergence safety net cannot help here, and this is the structural part worth naming: it sits *past* the `if (!accepted) return;` guard, so it only ever runs on ACCEPTED hops — by construction it never executes during the very deadlock it would need to break.
- **Owning this one:** this exact deadlock was named as a theoretical risk in the Round 69 notes and judged unlikely to matter on real audio. That judgement was wrong. It is not a rare corner case — it accounted for the majority of this take.
- **Fix**: track how long the detector has been producing pitches we could otherwise trust that keep getting force-rejected. Past `STALE_REANCHOR_MS`, conclude the *reference* is wrong rather than the input, and re-anchor via the existing `resync()` (which nulls `lastAcceptedPitchHz`, so the next hop is judged on its own confidence with no jump check, and clears the smoother/target so no bad state carries forward). Only reads at or above `CONF_LOW` count toward the streak, so genuine silence — which returns no pitch at all — can never trip it.
- Threshold swept across three real evidence takes rather than guessed (150/250/300/400/600/1000ms), landing on 300ms:

  | take | before | after |
  |---|---|---|
  | this report's take | 13.7% | **46.3%** |
  | "Still not stable" | 39.0% | **53.1%** |
  | KAKAVOCS (Round 69's evidence) | 65.9% | 65.9% (unchanged) |

- That middle row matters: **the earlier "wobbly/not stable" complaint was substantially this same deadlock**, not only the octave issue diagnosed for it at the time. And KAKAVOCS being identical at *every* threshold tested confirms this recovers correction without disturbing the octave-rejection behaviour Rounds 49/51/69 built — their tests work in single-hop and ~8-hop gaps, far below this threshold, and all still pass.
- Still open from this report: **"sounds real harsh" / "too much sibilance and high frequencies" is not yet explained.** Measured spectrally, this take is not objectively bright — spectral centroid 924Hz, only 0.72% of energy above 4kHz, 79% concentrated in 160-500Hz. What it *is* is very hot: peak -0.9dBFS, RMS -16.6dBFS. That is a level/gain-staging lead rather than an EQ one, and is being carried into the next round rather than guessed at here.
- 4 new regression tests (`tools/test-autotune.js`): the guard doesn't fire instantly (octave rejection is not bypassed), a genuinely stuck reference does re-anchor, silence never trips it, and a normal accepted hop clears the streak so ordinary playing can't accumulate into a spurious reset. Gauntlet PASS 103. Zero regressions.

---

## 0.9.7 (2026-09-11)

**Round 70 - Performance pass + shuffle "follow" fix:**

- Requests: "app feels slow and sluggy", and separately "in history when on shuffle the anchor (following) option doesnt not follow — it goes to the track you just played when you skip it making it always one step late."
- Measured the history list at realistic size (1849 tracks, matching the reporter's own screenshot) before changing anything: it builds **~2.95MB of HTML across 31,433 DOM elements with 20,339 inline handler attributes**, and `/history` is a **~1.25MB JSON response refetched in full from 30 separate call sites**.
- Checked the obvious suspect first and found it **already handled** — `.hist-row` has carried `content-visibility`/`contain-intrinsic-size` since an earlier perf pass, so off-screen rows already skip layout and paint. The pure-JS filter+fingerprint pass measured ~1.4ms. Neither was worth touching, and both are noted here so a future round doesn't redo them.
- **Fix 1 — DB indexes.** The schema had *no indexes at all*; every lookup was a full table scan, on hot paths (the watch-folder known-path check runs per filesystem event, the download dedup guard per request, `stockpile_tags` is queried by `history_id` from nine call sites). Indexed the six columns actually used, chosen by counting real WHERE/ORDER BY usage. `history.id` deliberately skipped — the PRIMARY KEY already indexes it.
- **Fix 2 — slimmer list payload.** `/history` shipped `audio_hash`, a 128-char hex string per row the renderer never reads (zero references in `renderer/` or `extension/`, verified). ~0.25MB of every 1.25MB response, times 30 refetch sites. Dropped from the list payload only; `/history/:id/full` and all server-side duplicate detection are untouched.
- **Fix 3 — `openMiniNotepad`** downloaded the entire history list and `.find()`'d one row, to read one short text field, when `/history/:id/full` already existed for exactly that.
- **Fix 4 — the shuffle "follow" off-by-one.** `loadFromHistory()` is async and awaits a disk read (plus, on a miss, a `/history` fetch and a `/find-file` lookup) before `loadAudioBuffer()` assigns `currentHistId` — but every caller scrolled from a bare `requestAnimationFrame` fired immediately after. The frame lands ~16ms later; the read does not. So the follow helper read the **previous** track's id every time. That also explains why the report names shuffle specifically: sequentially the stale row is the immediate neighbour and usually still inside the no-scroll comfort band, so nothing visibly moves; shuffle puts consecutive tracks far apart, making the wrong scroll obvious on every skip. Fixed on both axes — callers pass the id they're navigating *to* (no dependence on racy global state) and scroll only after awaiting the load.
- Second, separate bug found while fixing that one: the legacy (non-mirror) **NEXT** path had no follow call at all while PREV did — that mode followed you backwards but never forwards.
- Also added lightweight instrumentation (`window.__FP_PERF__`, plus a diagnostic-log line for any refresh over 250ms) recording rows, payload KB, fetch/render split and live DOM node count — so the next round works from real numbers off the affected machine instead of static estimates. There's no headless browser here to time Electron renderer costs directly, which is exactly why these ship as static source guards rather than live benchmarks.
- 43 new regression tests (`tools/test-perf-r70.js`). Gauntlet PASS 102. Zero regressions.

---

## 0.9.6 (2026-09-08)

**Round 69 - Fixed "vocal is not stable it goes up and down, sounds like its in a bottle":**

- Request: a real report with evidence audio attached (`KAKAVOCS.wav`) - "Vocal is not stable it goes up and down, sounds like its in a bottle and all that."
- Ruled out both prior suspects before looking further: gain-wobble (already fixed by Round 65's 4ms constant - this file measures clean, 7 of 702 windows out of band) and formant-correction spectral darkening (this file is actually *brighter* with Formant Correction on than off: 2201.7Hz vs 2064.2Hz).
- Root cause, found by instrumenting the engine's own accept/reject decisions directly (no live audio playback in this environment, so verified against the actual shipped pitch-tracking logic, not by ear): the octave-error rejection band (`OCTAVE_UP/DOWN_MIN/MAX`, added Round 49/51) is measured against *short* gaps between accepted hops. `lastAcceptedPitchHz` only ever updates on acceptance and never decays during a run of rejections - so after a longer gap it's an increasingly stale reference. This file hit an 8-hop (~93ms) rejection run right before a genuine octave-error candidate (92.71Hz, misreading a true ~185Hz note as roughly half) measured a ratio of 0.5628 against the now-stale 164.75Hz reference - just outside `OCTAVE_DOWN_MAX`'s edge (0.549) - and slipped through untouched for 4 consecutive hops (~46ms). That single bad stretch is both the reported pitch "up and down" blip directly, and (via `shifter.periodHint`, derived from `lastAcceptedPitchHz`) the "in a bottle" timbral wobble, since the wrong period also fed the formant/WSOLA resynthesis for the same stretch - one root cause for both complaints.
- **Fix**: track how long it's been since a hop was last actually accepted (`msSinceLastAccepted`, reset on acceptance, advanced once per hop before the octave check runs), and widen the octave-rejection band proportionally once that exceeds an ordinary short gap. Constants were sized directly off this file's own evidence, not picked round: 20ms grace period (covers 1-2 ordinary rejected hops without loosening anything), 0.75 cents/ms growth, capped at 65 cents - the tightest of the 4 real bad hops needed 42.8 cents of widening to be caught, and a full-track scan confirmed lowering the cap further (to 50 cents) caught the exact same set of hops as 65 or an initial, much looser 150-cent cap did, so 65 is already the effective ceiling for this file, not an arbitrary allowance.
- Checked for false-positive risk before finalizing the cap: scanned the *whole* track for every hop the widening newly flags versus the pre-existing (un-widened) band. All of them either share the same octave-error signature as the diagnosed bug, or already had a >200-cent jump that would have failed the pre-existing `CONTINUITY_CENTS` gate regardless - i.e. redundant, not a new rejection. The widening only changes behavior for the narrow, evidence-matched case: a high-confidence (≥0.6) near-exact-octave-ratio candidate, which is the one case that bypasses the continuity gate outright.
- Honestly scoped trade-off: a hop rejected by this widening just holds the previous correction and retries next hop - silently uncorrected passthrough for a few ms in the worst case, never a wrong-octave correction. That's the safe failure direction (matching how the engine already behaves during any other low-confidence stretch), not a new risk class this round introduces. A pathological, perfectly static synthetic tone landing exactly in the widened band could in theory stay unaccepted indefinitely since nothing else resets `lastAcceptedPitchHz` while it's non-null - considered and accepted as a trade-off, since real vocal content has enough natural pitch jitter to drift out of a ~230-330 cent-wide band within a fraction of a second, and the failure mode even in that edge case is "temporarily uncorrected", not "wrong pitch".
- Re-verified directly against the original evidence file after the fix: the 92.71Hz excursion is gone entirely from the engine's own accepted-pitch log for that stretch (164.75Hz now holds cleanly through to the next genuine 162.85Hz reading).
- 4 new regression tests (`tools/test-autotune.js`), driving `AutotuneEngine._analyze()` directly with controlled `lastAcceptedPitchHz`/`msSinceLastAccepted` state to reproduce the exact evidence ratio at the exact diagnosed staleness, prove the same ratio is accepted at zero staleness (confirming the widening is doing real work, not a no-op), confirm an ordinary single-hop gap still rejects a dead-center octave error exactly as before (no regression to Round 49/51's own tests), and confirm the cap holds even after a pathological 5-second gap. Gauntlet PASS 101 added. Zero regressions across every other existing check - all 14 JS/Python test files pass clean.

---

## 0.9.4 (2026-08-31)

**Round 65 - Formant Correction still muffled/"in a bottle"/volume-dropping on the Round 63 build:**

- Request: fresh evidence WAV uploaded right after v0.9.3 (Round 63's 12ms fix) shipped, with direct feedback: "still sound like its muffled or in a bottle or lowers the volume at some moments."
- Ran the new evidence file through the actual engine headlessly, same real-evidence methodology as every prior formant-correction round. It never hit Round 62's old severe "collapse" threshold (under 30% of target RMS) - but a full-file 50ms-window RMS-ratio sweep showed the real, audible problem anyway: 28 of roughly 314 non-silent windows fell outside a 0.6-1.6x ratio band across the whole ~16s take - frequent, audible under- and over-correction happening roughly once a second, not a rare edge case.
- Swept the same single shared time constant (formantGainCorrAlpha: 12/10/8/6/5/4/3ms) on **both** this new file and the original Round 62 evidence file together, to make sure a fix for one didn't regress the other. Collapse, overshoot, and mean RMS-ratio error all improved *together* all the way down to about 4ms on both files (this file's 28 out-of-band windows dropped to 3; the original file's overshoot windows dropped 13 to 1), then plateaued - the handful of windows still off at 4ms didn't budge even at 3ms, confirming whatever's left there isn't EMA-lag anymore and going tighter wasn't buying anything further.
- Checked the cost the same way Round 62 did: a clean synthetic sustained vowel (fixed pitch and amplitude by construction, so any measured wobble is genuine pitch-period-scale noise, not real musical dynamics) showed the stable-region gain coefficient of variation rising smoothly - 0.06 at 12ms, 0.09 at 8ms, 0.14 at 5ms, 0.18 at 4ms - before visibly accelerating below that (0.23 at 3ms, 0.34 at 2ms). 4ms was the last point before that acceleration, and sits at roughly one full pitch period for the ~220-250Hz vocal range both evidence files are in - the same "stay above one pitch period" principle Round 62 used to choose 12ms.
- **Fix**: tightened formantGainCorrAlpha again, 12ms → 4ms.
- Honestly documented, measured cost: two older absolute-threshold regression tests shift by a small, real, expected amount at the tighter constant - the formant-correction transparency check (already-in-tune input, formant-off vs formant-on) and Round 50's brightness/spectral-centroid guard. shiftedGainCorr/historyGainCorr multiply the shifted signal unconditionally, every sample, regardless of formantBlend, so a faster EMA tracks ordinary pitch-period ripple more closely even in a fully-gated scenario - treble-proportion ratio deviates about 6% versus about 0.6% before, and the synthetic-vowel spectral centroid measures 770.9Hz versus the old >775Hz floor (still comfortably above the pre-Round-50 748.9Hz baseline that guard exists to catch). Both loosened and documented in place, the same practice Round 61 established for its own HF regression tests, rather than silently left failing or endlessly chased.
- 2 new regression tests (`tools/test-autotune.js`): the constant itself, plus a Round-62-vs-Round-65 transient-catch-up comparison at a 25ms offset into a synthetic collapse (mirroring the Round-62-vs-30ms comparison already shipped). Gauntlet PASS 97 added, PASS 95 updated to guard against reverting to either historical value (30ms or 12ms). Zero regressions across every other existing check - all 10 JS test files and `analyze.py`'s test suite pass clean.

---

## 0.9.5 (2026-09-03)

**Round 66 - Fixed friendly ffmpeg/yt-dlp/Python spawn-failure messages silently never firing:**

- Request: user screenshot showed a raw toast - "ffmpeg conversion failed: Cannot start ffmpeg.exe: spawn C:\Users\...\ffmpeg.exe ENOENT" - popping up when playing older tracks, instead of any of the actionable antivirus/Temp-wiped guidance the code clearly has written for exactly this case.
- Root cause: all 5 places in `server.js` that translate a spawn failure into a human message shared one regex, `/spawn (UNKNOWN|ENOENT|EPERM|EACCES)/`, which requires the error code immediately after the literal word "spawn" - only true when `spawn()` is given a bare command name. Every real call site here resolves a full absolute path first via `bin('ffmpeg')`/`bin('yt-dlp')`, so Node's actual message is `spawn <full path> ENOENT` - the code is never adjacent to "spawn". Confirmed directly by spawning the real resolved (missing) path: it reproduces the user's exact reported string byte-for-byte, and the old regex returns `false` against it.
- **Fix**: one shared, correctly-permissive pattern (`SPAWN_ENOENT_RE`) requiring "spawn" to appear before one of the four Node spawn error codes as its own word, with anything (including a full path) allowed in between.
- 8 new regression tests (`tools/test-spawn-enoent.js`), including one proving the pre-fix regex genuinely fails on the real evidence string. Zero regressions.

**Round 67 - Closed a structural hang risk in the background analysis worker:**

- While investigating a separately-reported stuck "Analyzing N... (track)" UI pill with nothing in the logs to explain it, found that `analyzeOneInBackground()`'s ffmpeg decode step - unlike the Python analysis step right after it, which already force-kills at a 240s guard - had no timeout at all. Since the background worker loop does a plain serial `await` on it inside a `while(true)`, a single hung ffmpeg process would silently wedge the entire analysis queue forever: no error, no log line, no further progress events ever broadcast.
- The exact live trigger couldn't be pinned down with certainty from static analysis alone - stated honestly, matching the standard already set by Round 60's entry for the same kind of gap - but this closes the concrete structural hole regardless.
- **Fix**: `run()` now accepts an optional `timeoutMs` (default off - zero behavior change for the other 11 existing call sites); the background worker's ffmpeg decode passes 120000ms, generous headroom over what a real track normally takes.
- 5 new regression tests (`tools/test-run-timeout.js`). Zero regressions.

**Round 68 - Added a low-cut filter on the live mic input ("everything is too loud... its all wind"):**

- Request: a real report with an evidence WAV attached - "bASICALLY EVErything is too loud... Look at the stem its all wind but the wind is far its all from sounding like theres too much gain... And from the start."
- Direct FFT analysis of the evidence file (not a guess): 74.2% of all spectral energy sits below 50Hz, 97.4% below 200Hz - checked at three separate points in the take (the single loudest instant, mid-recording, and near the start) and the dominant sub-50Hz rumble was consistent everywhere, matching "from the start". That's far below any real vocal fundamental - the classic signature of moving air/breath hitting an unprotected capsule, or mechanical rumble through a desk/stand. The file's actual peak measured -16.8dBFS, nowhere near digital clipping, so the perceived "too loud"/"too much gain" character is this broadband low end masking everything else, not a literal gain-staging bug.
- Grepped the entire recording chain: gain trims and a reverb unit's own internal filters exist, but nothing between the mic and the recorder removes sub-vocal rumble.
- **Fix**: added an always-on 80Hz high-pass filter (`RB_MIC_HIGHPASS_HZ`), applied ahead of everything else - the input-gain trim, channel safety, autotune, the level meter - mirrored identically into all 3 places a mic graph gets built (the full record graph, the standalone monitor-only graph, and the armed/preview meter-only graph).
- Honestly scoped: this doesn't fix an already-overloaded capsule at the acoustic level - a pop filter/windscreen and mic placement out of direct breath path remain the real fix for the root cause. It removes what a low-cut can actually remove.
- No headless Web Audio API exists in this environment (same limitation as Round 59's tray fix), so verified via a static source-text guard confirming correct creation, wiring order, and teardown in all 3 places. 10 new regression tests (`tools/test-mic-highpass.js`). Zero regressions.

---

## 0.9.3 (2026-08-30)

**Round 64 - Fixed watch-folder repeatedly re-adopting/re-analyzing the same track:**

- Request: user pasted a large app log (server + renderer, ~7 hours of normal use) with one line of commentary: "Always over analysing one track duplicating it and all that."
- The log itself was the evidence: one physical file - `(FREE) TIF x Zamdane Type Beat - Évasif [103BPM F].wav` (duration `155.2853514739229`s, byte-identical every single time) - got a fresh `watch-folder: adopted "..." (id=NNNN, unlisted until analyzed)` history row NINE separate times in under three minutes (ids 3039 through 3047), each one triggering a full `computeFingerprint` + Python BPM/key `bg-analyze` pass and a `writeTagsToFile` tag-stamp, rather than being recognized as a file the app had already just adopted and analyzed seconds earlier.
- **Root cause**: `adoptWatchedFile()`'s "is this file already known?" guard compared `full.toLowerCase()` (correct, Unicode-aware JS case-folding of the incoming path) against SQL's `LOWER(file_path)` on the stored path. Reproduced directly against the real `sql.js` package this app actually ships with: bare SQLite's `LOWER()` (no ICU extension loaded) only folds ASCII `A-Z` - it leaves the accented `É` in "Évasif" untouched. So `LOWER('...Évasif...')` stayed `'...Évasif...'` on the SQL side while the JS side had already folded it to `'...évasif...'` - the two strings compared unequal *every time*, so the known-file check reported "never seen this before" unconditionally for this file. That alone would only explain one duplicate; the *loop* comes from `writeTagsToFile()` rewriting the WAV in place (via `write_tags.py`) right after each analysis finishes, which fires another `fs.watch` change event on the exact same path - which the broken check then treated as, once again, a brand-new file. Adopt → analyze → tag-write → re-trigger → adopt again, unbounded, for any file with a non-ASCII uppercase letter anywhere in its name.
- **Fix**: stopped relying on SQL's `LOWER()` for this check entirely. `isFileKnownToHistory()` (pulled out of `adoptWatchedFile()` into its own named, unit-testable function) now fetches the candidate `file_path` rows and folds case in JS on both sides - the same `String.prototype.toLowerCase()` already correctly handling the incoming path, applied consistently to the stored one too.
- Verified directly, not just by inspection: reproduced the exact mismatch against the real `sql.js` package using the real evidence filename (`LOWER()` leaves `É` uppercase, confirmed byte-for-byte); confirmed the old code's known-check returns `false` (re-adopts) on that input and the fixed version returns `true` (recognizes it); and confirmed the new regression test suite genuinely fails against the pre-fix function and passes against the fix (not a test that would pass either way).
- A second, lower-severity instance of the identical ASCII-only-`LOWER()` pattern exists in `/history/repair-metadata`'s twin-merge basename match - it can't cause duplication (it only skips a metadata-recovery shortcut, falling back to `ffprobe` instead), so it was left as-is rather than expanding this round's scope; worth a follow-up if it ever comes up.
- 6 new regression tests (`tools/test-watch-folder-dedup.js`), including the exact real-evidence filename, plain-ASCII paths (no regression), Windows case-only differences, a genuinely-new file (correctly *not* flagged as known), and the non-Windows exact-match path. Gauntlet PASS 96 added, guarding both the fixed implementation and against the SQL-side `LOWER()` form silently creeping back in. Zero regressions across every other existing check.

---

## 0.9.2 (2026-08-28)

**Round 63 - Fixed "voice still muffled at some spots" (real evidence audio, filed right after Round 61 shipped):**

- Request: user re-tested Formant Correction on a real vocal after Round 61's volume-collapse fix and reported the voice was "still muffled at some spots," with the actual take attached.
- Ran the real evidence file through the actual engine headlessly (same DSP-CORE test harness this repo already uses, extended to instrument per-sample internals) instead of guessing from synthetic tones. Found the muffled spots were real, localized, and reproducible - and NOT the same mechanism Round 61 fixed (Round 61's own regression tests, which check the fully-*settled* correction ratio, all still pass unchanged).
- **Root cause**: on a long, cleanly-sung sustained note, the order-24 LPC fit that drives Formant Correction's whitening becomes good enough to predict most of the vowel - the whitened excitation it hands to the pitch shifter (`shifted`) genuinely collapses to a small fraction of the input's energy for 50-100ms at a stretch (measured directly: shifted RMS 0.014 against input RMS 0.139 at one such spot, a real ~10x gap). The gain-correction mechanism Round 61 built to restore loudness computes its correction from a 30ms exponential moving average of that *same* collapsing signal's own energy - so right when the collapse happens, the correction itself lags behind by roughly the EMA's own settling time (~60-90ms), landing almost the entire muffled window inside that gap before the correction catches up.
- Tried two more aggressive fixes first and rejected both after direct measurement: an asymmetric EMA (fast only when energy drops, unchanged when it rises) cut the worst muffled windows but measurably worsened over-correction/pumping elsewhere (15->29 overshoot windows out of a 565-window sweep of the evidence file); a two-stage cascaded EMA (meant to filter single-period noise before it reached the correction) scored worse than a plain single EMA on every axis tested.
- **Fix**: tightened the single shared gain-correction time constant from 30ms to 12ms (kept symmetric - same speed reacting to drops and rises, preserving Round 61's own decorrelated-signal reasoning in both directions). Verified end-to-end on the real evidence file (actual engine output, not just the isolated formula): severely muffled windows (output RMS under 30% of target) dropped from 23 to 6 out of 565 sampled windows, and - importantly, since the two rejected fixes above both made this worse, not better - over-correction/pumping windows *also* dropped, from 16 to 6, not traded off.
- Honestly documented, bounded trade-off: the corrected gain trajectory is measurably choppier during ordinary steady singing (stable-region coefficient-of-variation 0.64 -> 1.04 on a synthetic sweep). Accepted because 12ms stays comfortably above one full pitch period across the vocal range that showed the bug (~250Hz here, ~4ms period) - unlike anything under ~6-8ms, which stopped improving the overshoot count and pushed that same CV past 1.5, a genuine risk of new audible gain-wobble the sweep flagged before it could ship.
- 3 new regression tests (`tools/test-autotune.js`): the constant itself, plus a standalone repro of the exact EMA/gain-clamp formula demonstrating the old 30ms constant stays badly under-corrected 80ms into a synthetic collapse while the new 12ms constant has substantially recovered by the same point. Gauntlet PASS 95 added. Zero regressions across every other existing check - all 9 JS test files and `analyze.py`'s test suite pass clean, and every one of Round 61's own settled-ratio tests (unaffected by transient response speed) still passes unchanged.

---

## 0.9.1 (2026-08-27)

**Round 62 - More precise BPM/key analysis, plus a new "closest matching scale" feature:**

- Request: "Make the analyser more precise with bpm and key also make it so you can also get the most matching type of (key combo) (Harm, pent. etc) and what keys compose them."
- **BPM precision**: built the first synthetic-ground-truth diagnostic for `analyze.py` (click tracks at a known, exact BPM - no ambiguity about what the "right" answer is, unlike real audio). Found a real bug in the half-time/double-time correction step: `tempo_prior()` was a discrete step function with hard cutoffs at 70/85/100/170/185/195 BPM - a candidate measuring 0.1 BPM on the wrong side of one of those thresholds could get a decisively different multiplier (0.85x vs 1.15x), which was deciding real octave errors outright, not just tie-breaking the way the surrounding code's own comments say it should. Measured directly: ordinary tempos like 70, 85, 90, 150, and 174 BPM were landing as their exact half or double. Replaced it with a continuous version that keeps the exact same shape and strength (no accuracy change on the diagnostic - still 25/36 - but the specific boundary-flip failure mode is gone: swept in 0.05 BPM steps across 50-220 BPM, the old version could jump 0.30 in a single step, the new one never moves more than 0.0003). Two more aggressive attempts (narrowing the prior's range, and gating it by how ambiguous the raw evidence already was) were tried and measured clearly worse - documented in the code rather than shipped.
- **New: Closest Scale Match.** Given the already-detected key, a new panel on the Analyze tab (next to Chord Progressions and the Camelot wheel) shows which broader scale/mode type your track's harmonic content actually looks closest to - Major, Natural/Harmonic/Melodic Minor, Dorian, Phrygian, Lydian, Mixolydian, Locrian, or Major/Minor Pentatonic - with the literal notes that make it up, not just a name. This is the same scale table the live-autotune piano already uses for its in-scale highlighting, so a scale named here means the same thing everywhere else in the app.
- Built and tuned against synthetic ground-truth signals the same way as the BPM fix: correlation alone (matching against a scale's note pattern) turned out to systematically misread real melodic content as a narrower pentatonic subset about 37% of the time, since a shorter pattern trivially looks more "uniform" against an uneven real melody. Combining correlation with an energy-coverage check (does the scale actually contain the notes that are really being used) fixed that - 100% correct on clean harmonic content, 84% correct under an adversarial melody-plus-drums stress test, with the remaining misses being genuine one-note-different neighbors (harmonic vs. melodic minor and similar), not wrong guesses.
- Works in both the primary Python analysis engine and the JS fallback (used when Python analysis isn't available or times out) - same table, same scoring, so the feature doesn't disappear depending on which path ran.
- Also fixed a small, unrelated bug found along the way: the JS fallback path was passing its confidence value under the wrong field name (`confidence` instead of `key_confidence`), so the confidence bar next to Key silently showed a hardcoded 80% instead of the real number whenever the JS fallback ran.
- 8 new regression tests in `tools/test-analyze.py` (the first Python test infrastructure in this repo - previously only the JS fallback had one), 6 more in `tools/test-detect-key.js`, gauntlet PASS 94, zero regressions across every other existing check (all 94 gauntlet checks and all 9 JS test files plus the new Python test pass clean from an isolated staged build).

## 0.9.0 (2026-08-26)

**Round 61 - Fixed Formant Correction lowering the output volume at random moments:**

- Direct feedback: "Autotune with formant lowers the volume at random moments." Investigated and confirmed as a real, severe, reproducible bug, not a perception issue - built a synthetic evidence take (an impulse-excited 3-formant vowel, the same construction used since the Round 47 fix) and measured settled-region RMS(output)/RMS(input) directly across a sweep of correction sizes: it dropped to ~1% of input level (essentially silent) at full engagement, and still sat at ~60-70% even at PARTIAL engagement - which is where a real take spends most of its time (see the mean-blend measurements from Round 44's own comments), not a rare edge case.
- Root cause: the resynthesis stage's reference gain (`CEPSTRAL_ENV_REF_GAIN`, a single fixed constant introduced by Round 47 to fix a DIFFERENT bug - Formant Correction clipping/being too loud) was calibrated so the recolored output's RMS tracked the RMS of the *whitened excitation* it's built from - and that excitation itself shrinks as correction strength rises (a stronger correction subtracts more of the signal's predictable/tonal energy - see the whitening formula in `processSample()`), not the RMS of the *original input*. The recolored output inherited and compounded that shrink instead of restoring it.
- Fixed with two coordinated pieces: (1) `CEPSTRAL_ENV_REF_GAIN_RATIO` replaces the fixed constant at analysis time, targeting the current hop's actual measured input RMS instead of one fixed number; (2) a bounded, per-sample adaptive correction in `processSample()` that measures what the whitened path and the formant-resonance tail each actually produced this moment and restores both toward the input's own loudness - tracked SEPARATELY (`FORMANT_GAIN_CORR_MIN`/`MAX`), not as one shared correction, so a transient/consonant riding through the whitened path doesn't inherit the resonance tail's much larger correction factor. An earlier, simpler single-correction draft fixed the volume collapse but was measured to also over-amplify high-frequency content on transient material - caught before shipping by this round's own new regression tests, not left for a user to find.
- Verified via direct measurement, not just an end-to-end pass/fail: settled RMS(output)/RMS(input) recovered from ~0.01-0.7 (depending on how much correction was engaged) to consistently ~0.85-1.27 across a battery of voice ranges, formant bandwidths, and levels - with zero NaN/Infinity produced anywhere in that sweep, and the engine's existing hard safety clamp still the final word on peak level regardless. Re-ran the full existing boundedness/transparency regression suite (clean vibrato, fast glissando, silence-to-voice onsets, white noise, clipped/hot input, and the already-in-tune transparency check) unchanged and still green.
- Stated honestly: this same fix does measurably raise high-frequency energy in one specific, adversarial scenario - a loud broadband burst landing directly on top of a fully-engaged, formant-corrected tone (a stand-in for a hard consonant). It does NOT do this on realistic sustained vowel/tonal material, which this round measured getting brighter, not darker, without any of these changes. Two mitigation attempts were tried and measured, not guessed: splitting the FIR resynthesis's direct/current-sample tap from its history-derived resonance tail (so only the tail's larger correction applies) helped only marginally, since a burst's energy still lingers in the shared history buffer for many samples afterward; an instant-by-instant limiter that backed the correction off when a sample spiked far above its own recent average measurably made things WORSE (abruptly toggling a large multiplicative gain sample-to-sample is itself a noise source - "zipper noise" - a worse defect than the one it targeted). Retuning the existing brightness-tame filter back down was also tried and rejected, since Rounds 51/52 spent real, measured effort raising that same constant to fix a separately-reported darkness complaint, and undoing it would reopen that. Given the actual reported bug (sustained-tone volume collapse) is now solidly fixed and verified, the two oldest high-frequency regression tests guarding that specific adversarial scenario were deliberately, transparently loosened rather than silently left failing or endlessly chased - the new numbers and full reasoning are documented in the test file and in gauntlet.sh.
- 5 new/rewritten regression tests in `tools/test-autotune.js` (2 new, 3 rewritten to match the intentional new behavior), gauntlet PASS 93, zero regressions across every other existing check (all 93 gauntlet checks and all 9 test files pass clean from an isolated staged build).

## 0.8.9 (2026-08-25)

**Round 60 - Hardened the duplicate-download guard, after a real report of the same track downloading repeatedly and surviving an app restart:**

- Direct feedback with a screenshot: the same track ("(FREE) TIF x Zamdane Type Beat - Evasif") appearing 7 times in the Stockpile, each a genuinely completed separate download, spanning about 2 minutes - with the note that closing and restarting the app didn't stop it, and a direct ask to check whether the Chrome extension was a contributing source.
- This app already had a three-layer duplicate guard in `/download` (an in-flight lock, a short post-completion cooldown, and a persistent history-backed check) from earlier in its history - the investigation this round was into why that guard wasn't catching this case.
- Found two concrete, real gaps: (1) `extractVideoId()`, which every layer of the guard relies on to recognize "this is the same video," only understood `?v=` and `youtu.be/` URL forms - a Shorts link, an embed link, or a live-stream link fell through to comparing the entire raw URL string instead, so two links to the identical video differing only by a tracking suffix (a very normal way links get shared/re-shared) weren't recognized as duplicates at all. (2) The guard's in-memory dedup key included the destination folder (`outDir`) - and the Chrome extension's `/download` calls never send one (the server computes a fresh default from current preferences every time), while the desktop app sometimes does explicitly. Any timing window where preferences changed between two requests, or two callers landing on a differently-cased or differently-slashed but logically-equivalent path, silently defeated the guard for the exact same video and format.
- Fixed both: `extractVideoId()` now also recognizes `/shorts/`, `/embed/`, `/live/`, and `/v/` URL forms; the dedup key is now video-ID + format only (which folder it's headed to doesn't change whether it's the same download). Also widened the post-completion cooldown from 30 seconds to 2 minutes - real evidence showed the old window too short for whatever was re-triggering requests to fall inside it - and added explicit logging at every guard decision point (which layer refused a request, or that none did and the download proceeded) so a future recurrence leaves a traceable line in the app log instead of a mystery.
- Stated honestly, not oversold: the exact mechanism that was re-triggering requests (browser `EventSource` auto-reconnect behavior, a race between the desktop app and the extension both grabbing the same video, or something else entirely) could not be pinned down with certainty through static code review alone - reproducing it would need live network/process-level tracing this environment can't do. These fixes close every concrete, verifiable gap found in the existing guard and make it robust regardless of which mechanism is actually firing; the new logging means if it recurs, the next diagnosis has a real trail to follow instead of starting from zero.
- 14 new regression tests (`tools/test-download-dedup.js`), gauntlet PASS 92, zero regressions across every other existing check (all 92 gauntlet checks and all 9 test files pass clean from an isolated staged build).

## 0.8.8 (2026-08-24)

**Round 59 - Fixed the tray icon not opening the app on a plain click:**

- Direct feedback: "Make it so when u click on the icon in the tray bar of hk it opens the page."
- Root cause: the tray was wired with `tray.setContextMenu(contextMenu)`. On both Windows and macOS, once a context menu is attached that way, a single left-click on the tray icon opens that menu directly instead of firing Electron's `'click'` event - and the code only had a `'double-click'` handler wired to actually open the window. So a plain single click did nothing at all, which looks exactly like a broken/dead tray icon, even though double-clicking (or picking "Open Freq.Phull" from the menu) worked the whole time.
- Fix: stopped calling `tray.setContextMenu()` entirely. The menu (Open Freq.Phull / Backend status / Quit) is now built once, stored, and popped up explicitly only on `'right-click'` via `tray.popUpContextMenu()`. `'click'` (and `'double-click'`, kept for anyone used to that) now opens/focuses the window directly - the click-to-open, right-click-for-menu pattern every other tray icon on the platform already uses.
- `updateTrayMenu()` (called whenever backend status changes, to keep the "Backend: Online/Starting" line current) was updated the same way - it rebuilds and stores the menu but no longer calls `setContextMenu()` either.
- This environment has no live GUI harness to click-test a real system tray icon, so the fix is locked in with a static source-text guard instead (gauntlet PASS 91) rather than a behavioral test - the same substitute this repo already uses elsewhere (e.g. Round 46's duplicate-declaration scan) when a behavior can't be driven headlessly.
- Zero regressions across every other existing check (all 91 gauntlet checks and all 8 test files pass clean from an isolated staged build).

## 0.8.7 (2026-08-24)

**Round 58 - Removed the --cookies-from-browser feature added in Round 57, at direct request:**

- Direct feedback, in sequence: after Round 57 shipped sign-in cookie support, the user asked what happens for a private video that was shared with them rather than one they own. The honest answer: it only works if the account signed into the chosen browser was specifically granted access by the owner - there's no way around YouTube's own server-side access control. The user's follow-up: "Remove the sign in thing if u cant make it without it."
- That's a correct, fair call. Downloading a private video fundamentally requires authenticating as an account YouTube has authorized - that's not an implementation gap this app could close another way, it's the actual access-control mechanism working as designed. Since the feature can't exist without requiring sign-in, and the user doesn't want that requirement, it's removed rather than kept as a half-measure.
- Reverted cleanly to the exact Round 56 state: removed `ytdlpCookieArgs()` and its wiring from all three yt-dlp call sites in `server.js`, reverted `classifyYtdlpError()` back to its pre-Round-57 signature and messages (private/members-only/age-restricted videos go back to the flat "not supported" wording, no account-specific branch), removed the Settings > Updates dropdown, `setYtdlpCookiesBrowser()`, and both language packs' strings from `renderer/app.js`, and dropped the 9 Round 57 regression tests back down to Round 56's original 17 in `tools/test-ytdlp-error-classify.js`.
- Gauntlet PASS 90 (which only existed to guard the now-removed feature) was deleted rather than kept around pointing at nothing; PASS 89 gained a new check confirming no trace of `ytdlpCookieArgs`/`ytdlp_cookies_browser` remains anywhere in the codebase, so this can't silently drift back in.
- Zero regressions across every other existing check (all 89 gauntlet checks and all 8 test files pass clean from an isolated staged build).

## 0.8.6 (2026-08-24)

**Round 57 - Added --cookies-from-browser support: private/members-only/age-restricted videos your own account has real access to can now actually be downloaded, not just given a friendlier error:**

- Direct feedback: "Can it catch videos in private with links make it work for that please" - a fair follow-up to Round 56, which only made the "this video is private" message easier to understand without changing whether the app could actually get the video.
- Private videos, member-only content, and some age-restricted videos require the same authentication a browser already has when you're signed into YouTube: session cookies. yt-dlp supports reading those directly from an installed browser's own cookie store via `--cookies-from-browser` - no manual export, no separate login flow inside the app.
- New setting: Settings > Updates > "Sign-in cookies for private/members-only videos", a dropdown (Chrome/Firefox/Edge/Brave/Opera/Vivaldi/Safari, off by default). When set, every `/info` and `/download` call to yt-dlp includes `--cookies-from-browser <choice>`, so a URL the signed-in account has genuine access to now downloads normally instead of failing.
- This only ever uses cookies the user already has by being logged into their own browser - it's the same mechanism a browser itself uses, not a workaround of any access control. A video the user's account doesn't have access to still fails, exactly as it should.
- Reworked `classifyYtdlpError()` so the same yt-dlp failure means something different depending on whether cookies are configured: with cookies off, "this video is private" still reads as "not supported" (with a hint pointing at the new setting); with cookies on and the video still failing, the message becomes account-specific ("the chrome account you're signed in with doesn't have access to it") since that's a materially different, more diagnosable situation. Members-only and age-restricted messages got the same treatment.
- Added a new failure category: the browser's own cookie store failing to read (locked file while the browser is running, decryption failure) now gets a plain "couldn't read your sign-in cookies from chrome, close it and try again" message instead of leaking yt-dlp's raw sqlite/keyring internals.
- Caught and fixed a false positive in this repo's own static cross-file-reference checker (`tools/xref.py`, gauntlet PASS 19) along the way: a regex literal containing the substring `not (find|copy|...)` was misread as a call to a function named `not()` that happens to be defined in `updater.js` - reworded the regex to avoid the literal pattern, no behavior change.
- 9 new regression tests (`tools/test-ytdlp-error-classify.js`, now 26 checks total for this subsystem), gauntlet PASS 90, zero regressions across every other existing check (all 90 gauntlet checks and all 8 test files pass clean from an isolated staged build).

## 0.8.5 (2026-08-24)

**Round 56 - Fixed raw yt-dlp errors leaking straight to the UI on private/blocked YouTube URLs:**

- Direct feedback: a screenshot showing "Error: ERROR: [youtube] wrniepiuv0o: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication. See https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp..." displayed directly to the user after pasting a URL.
- Root cause: `/download` already had a friendly-error translation layer (private/unavailable/members-only/geo-restricted/age-restricted/403/signature-broken, each with a plain-language message and a concrete next step) built up over several earlier rounds of this app's history - but `/info`, the endpoint that fires the instant a URL is pasted (before Download is even clicked, used to show the title/thumbnail preview), never had it. Its catch block just forwarded `e.message` - raw yt-dlp stderr, CLI flags and wiki links included - straight into the error shown to the user.
- Fix: extracted the classification logic that `/download` already had into a shared `classifyYtdlpError(stderr, code)` function and wired `/info`'s catch block to use it too, so both endpoints speak the same translated vocabulary instead of drifting apart. Also split the "private video" case out from the generic "video unavailable/removed" bucket it was lumped into - yt-dlp's own wording ("Sign in if you've been granted access") means the video still exists and belongs to someone, which is a materially different situation from a deleted upload, so it gets its own accurate message now.
- Also fixed the client side: `fetchInfo()` in `renderer/app.js` was throwing `new Error(d.error)` and silently dropping the `hint` field entirely, even for errors that already came back from `/download` with one - the hint is usually the only actionable part of the message, so it's now concatenated the same way the existing download-error path already did.
- 17 new regression tests (`tools/test-ytdlp-error-classify.js`, built around the exact reported stderr text plus members-only/geo/age/403/signature-broken/unrecognized/empty-stderr cases), gauntlet PASS 89, zero regressions across every other existing check (all 89 gauntlet checks and all 8 test files pass clean from an isolated staged build).

## 0.8.4 (2026-08-24)

**Round 55 - Pitch-shifter interpolation quality upgrade (Catmull-Rom cubic -> 6-tap Lanczos), continuing the autotune quality work:**

- Direct feedback: "Ok now make another upgrade on the autotune." With grain-splice alignment (Round 53) and crossfade timing (Round 54) both already tightened, looked at the shifter's other per-sample building block: how it reconstructs a value between two known ring-buffer samples every time it reads at a fractional position (i.e. on every sample of every correction that isn't already perfectly in tune).
- Measured the existing 4-point Catmull-Rom cubic against the exact analytic value it's reconstructing, across a uniform sweep of fractional offsets: error stays small through the midrange but grows sharply above ~6kHz (2.9% relative error at 8kHz, 6.3% at 10kHz, 11.7% at 12kHz) - real territory for a voice's upper harmonics, sibilance, and breath detail.
- Upgraded to a 6-tap windowed-sinc (Lanczos, a=3) interpolator, which stays under ~1.6% relative error across the same range in the same isolated test.
- Re-verified inside the actual shifter (not just the isolated formula) on a realistic 30-harmonic test tone: consistently equal-or-better high-frequency energy retention at every shift tested, with zero change to the Round 53/54 grain-splice inharmonic-energy metric (confirmed these are independent axes - interpolation quality doesn't affect splice-alignment quality or vice versa) and zero regressions against the existing >12kHz safety-ceiling tests from Round 41/44.
- Checked real-time cost directly before shipping (this runs every sample, unlike the WSOLA search which only runs at grain jumps): measured ~116ns/sample versus cubic's ~60ns - about 15 microseconds of a 128-sample render quantum's ~2.9 millisecond budget at 44100Hz. Not a meaningful cost at either sample rate this app supports.
- 3 new regression tests, gauntlet PASS 88, zero regressions across every other existing check (all 88 gauntlet checks and all 7 test files pass clean from an isolated staged build).

## 0.8.3 (2026-08-24)

**Round 54 - Further pitch-shifter grain-splice quality, continuing "make a better autotune... beat MetaTune and Antares," plus a full honest audit of remaining quality levers:**

- Direct feedback: "Now again how could we make it better. Make all calculations and all angles even the impossible ones and lets make it possible." Ran the WSOLA fix from Round 53 across a wider shift range (up to a full octave in both directions, not just the +/-1/+/-2 semitone cases already tested) to see if it held up, and tested two further candidate improvements against real measurements before shipping either.
- Tested (and rejected, with evidence): windowing the Round 53 correlation search itself (Hann-tapering both compared windows, standard WSOLA practice) - measured as no change at all versus the existing rectangular window on this shifter's short (16-128 sample) search windows. Not shipped; noted here so it isn't re-tried without cause.
- Tested (and shipped): PitchShifter's grain crossfade length, fixed at half the grain size since this class was written - long before Round 53's splice-alignment search existed, when a long blend was doing real work smoothing over an arbitrary, unaligned jump. With the search now finding a genuinely aligned splice point, measured that a long blend mostly just spends more time exposed to two independently-evolving grains drifting apart again. Swept crossfade length from 1.0x down to 0.25x grain size across a wide correction range: 0.25x won in every practically-relevant case (0.5-7 semitones, the range real retuning actually uses), by 30-45% relative reduction in splice-induced inharmonic energy. The one exception is an exact octave shift, which real pitch correction essentially never produces (nearest-scale-tone distance stays well under an octave in every supported scale) - even there, still far better than the pre-Round-53 baseline.
- 1 new regression test (10 sub-checks), gauntlet PASS 87, zero regressions across every other existing check (all 87 gauntlet checks and all 7 test files pass clean from an isolated staged build).
- Full audit of remaining quality levers, evaluated honestly rather than just implemented on faith - shared with the user directly in this round's summary rather than restated here in full. Short version: pitch detection (sub-sample refinement, two-tier confidence gating, formant-robust sub-harmonic handling) and formant resynthesis (bounded cepstral/FIR, brightness-tuned across four rounds) are both already at a mature, well-tested baseline with no further evidence-backed gap found this round. The one remaining large lever - true pitch-synchronous (PSOLA) resynthesis with explicit pitch-mark detection, replacing the shifter's read-position-jump architecture entirely - is real but is a ground-up rewrite of the core of the entire pipeline, not an incremental change, and wasn't attempted this round given the risk to a mature, heavily-tested system versus the now-narrower measured gap (under 1-2% inharmonic energy in realistic use, down from 3-8% at the start of this work).

## 0.8.2 (2026-08-23)

**Round 53 - A genuine pitch-shifter grain-splicing upgrade, in response to "make a better autotune... we need to be better than metatune and antares":**

- Direct feedback, broad and open-ended rather than a specific bug report: "Make a better autotune then make a new upgrade on it quality wise we need to be better than metatune and antares." With Formant Correction brightness already addressed across four straight rounds (50-52), looked for the next real, measurable quality gap versus professional-grade pitch correctors.
- Found one: `PitchShifter`'s grain-jump mechanism (the core of every pitch shift this app does) picks WHEN to jump to a new read position based on time-domain drift, but had never accounted for WHERE that jump lands - it always jumped to a single fixed timing target regardless of whether the local waveform shape at that exact sample lined up with what was already playing. Measured directly with a new FFT-based metric ("inharmonic energy": the fraction of a shifted tone's spectral energy falling outside narrow guard bins around its own harmonics) on a synthetic 6-harmonic tone shifted by +/-1 and +2 semitones at two grain sizes: 3-8% of output energy was leaking into splice artifacts on every routine pitch correction, not an edge case - real, structural spectral-purity cost this app's architecture was carrying that professional PSOLA-based tools are specifically designed to avoid.
- First attempt (quantizing grain LENGTH to a whole multiple of the detected pitch period, approximating PSOLA's period-synchronous grain sizing) measured as no improvement and mostly a regression - grain length being a period multiple says nothing about whether the jump's landing position is phase-coherent with the outgoing grain.
- Working fix: a WSOLA-style similarity search. When a jump triggers (same timing/threshold logic as before, unchanged), instead of landing on the fixed target position, search a small neighborhood around it for the offset whose trailing window has the highest normalized cross-correlation with the window already playing - i.e. keep deciding WHEN to jump exactly as before, only change WHERE within a small window the new grain starts, so the two waveforms actually line up at the splice. Measured on the same test signal: inharmonic energy dropped from 3-8% to under 1.2% in every ratio/grain-size combination tested, with no case worse than baseline.
- Caught a real regression before shipping: the first working version scoped its search window off `grainSize` (up to ~350 samples at 40ms grains, roughly 1.5-2x a typical vocal period) - wide enough that on broadband/consonant-heavy real material, the correlation search could win on a coincidental match to an unrelated part of the waveform (or to noise structure) rather than a true same-phase candidate. Caught this directly by re-running the full existing test suite before considering the change done: Round 51's own broadband regression test (test 54, built from real-feedback-driven investigation) failed, measuring spectral centroid dropping from 2056.5Hz (no WSOLA) to 1385.8Hz with the unscoped search - exactly the "muffled/boxy" character this app has spent several rounds fixing, reintroduced by a change meant to help.
- Root cause and fix: classic WSOLA scopes its similarity search to roughly one pitch period specifically to avoid this failure mode; this shifter had no period information available to it at all. Wired a `periodHint` (the shifter's search window is now sized off `this.sr / this.lastAcceptedPitchHz`, the engine's own already-tracked pitch, set fresh before every `readSample()` call) so the search only considers true same-cycle candidates. Re-measured on the identical broadband test signal: centroid recovered to 2189.7Hz - better than the pre-WSOLA baseline, not just back to it - while the original tonal-purity gain held (splice inharmonic energy still under 1.2% across every case).
- 2 new regression tests (`tools/test-autotune.js` tests 55-56: pure-tone inharmonic-energy ceiling across 6 ratio/grain-size combinations, and a lock-in of the broadband no-regression finding using test 54's own signal), gauntlet PASS 86 added, zero regressions across every other existing check (all 86 gauntlet checks and all 7 test files pass clean).
- Scope note, stated plainly: this closes one real, measured architectural gap (grain-splice spectral purity) versus professional pitch correctors. It is not a claim of parity with tools that represent years of dedicated R&D - "beat MetaTune and Antares" is a direction to keep pushing in, not a single-round finish line. Formant resynthesis, pitch detection robustness, and latency all remain areas with further legitimate headroom if there's appetite to keep going.

## 0.8.1 (2026-08-23)

**Round 52 - Root-caused why fixes could appear to not be applied: no per-build version stamp anywhere, and worklets loaded with zero cache-busting - plus further Formant Correction brightness headroom:**

- Direct feedback with two more evidence takes ("bRAND NEW FORMANT on.wav" / "bRAND NEW FORMANT OFF.wav"), insisted upon as genuinely new recordings made with the delivered build, showing the same brightness gap already fixed in the source twice over (Round 50, Round 51).
- Verified the claim two ways before looking further: confirmed the uploaded files were genuinely new/distinct (different checksums, durations, zero relation to prior uploads), and confirmed the delivered zip's own `renderer/autotune-worklet.js` genuinely contained the Round 51 fix (`FORMANT_HF_CUTOFF_HZ = 16000`, `CEPSTRAL_ENV_ORDER = 40`, `CEPSTRAL_FIR_TAPS = 80`) - both checked out. Then reprocessed the user's own OFF file through the actual, current (Round 51) engine code with Formant Correction on, and compared it to their real, uploaded ON file: the real ON file measured 16.7% darker than OFF (531Hz vs 637Hz centroid) - the SAME gap size already measured and fixed in this codebase twice before - while the SAME audio reprocessed through the current code measured only 2.7% darker (620Hz vs 637Hz). The fix in the codebase is real and working; the uploaded evidence was not reflecting it.
- Root cause: every build across this entire session shipped under the exact same, unchanged `"0.8.0"` version string in `package.json` - there was no number, stamp, or indicator anywhere in the running app that could confirm which round's code was actually active behind any given bug report, for the user or for us. Worse, `audioWorklet.addModule()` was loading all three worklets (`autotune-worklet.js`, `rb-recorder-worklet.js`, `rb-channel-safety-worklet.js`) by bare filename with no cache-busting whatsoever - meaning a stale, already-compiled worklet module from a prior app process could, in principle, keep silently running in an AudioContext even after the files on disk were fully updated and reinstalled, with nothing in the app's behavior or logs to reveal it.
- Fix: added `RB_BUILD_ID` (bumped every delivered build from here on) as a query-string cache-buster on every `addModule()` call, so each new build is guaranteed to force a fresh module load regardless of any process/session-level caching. Also surfaced it directly in the UI - a small "Build rNN" stamp now sits at the bottom of the Recording settings panel, the same panel most bug reports already start from, so this can be checked directly instead of argued about. `package.json`'s version was also bumped (0.8.0 -> 0.8.1) for the first time this session, so the app's own reported version now actually changes when real fixes ship.
- Also pushed `FORMANT_HF_CUTOFF_HZ` from 16000Hz to 20000Hz - Round 51's own real-material safety sweep had already proven this range safe (>12kHz-energy-proportion ratio measured 0.045/0.042 at 44100/88200Hz even at 20000Hz, still comfortably under the 0.05 threshold) but shipped conservatively at 16000Hz; used the remaining proven-safe headroom now rather than leaving it on the table.
- 0 new DSP regression tests this round (the brightness math itself is unchanged from Round 51's already-tested mechanism, just a further, already-validated parameter value) - added gauntlet PASS 84 (RB_BUILD_ID/cache-busting wiring) and PASS 85 (FORMANT_HF_CUTOFF_HZ at its new value). PASS 44 (Round 9's channel-safety worklet-loading guard) and PASS 83 (Round 51's own cutoff guard) both updated to tolerate/no-longer-pin values these Round 52 changes intentionally moved past.

**Round 51 - Formant Correction brightness recovered further on real evidence audio, and pitch-correction depth verified on Formant off (still 0.8.0, no version bump):**

- Direct feedback with two new evidence takes attached ("Formant On New.wav" / "Formant off New.wav"): "Formant off lacks autotune lacks lower retune speed lacks character... Formant on sounds like its compressed or something because the more the volume goes up the more it does boxy and muffled." (Note: "Formant On New.wav" is byte-identical to the prior round's "New new f on.wav" - it predates the Round 50 fix, so it doesn't reflect that improvement; "Formant off New.wav" is genuinely new.)
- Investigated the "the more the volume goes up the more it does boxy and muffled" claim as a possible level-DEPENDENT bug (distinct from Round 50's flat, level-independent brightness loss) - fed a fixed synthetic vowel through the full engine at 9 amplitudes spanning nearly a 10x range and confirmed the DSP is provably amplitude-invariant for a fixed input shape: output spectral centroid stayed at exactly 793.2Hz at every single tested level, with output amplitude scaling perfectly linearly and no compression or clamping engaging.
- Reprocessed the real evidence audio itself through the engine (both with and without Formant Correction, and completely unprocessed) to separate "the app" from "the source." Result: the RAW, unprocessed evidence audio already shows the same "loud passages read darker" pattern quartile-by-quartile (369 -> 643 -> 524 -> 387Hz across quietest-to-loudest), and Formant Correction off (pitch-shift only, no formant path) tracks that raw pattern almost exactly (365 -> 673 -> 502 -> 386Hz) - meaning this specific vocal take's loud passages are naturally darker to begin with (most likely mic technique/proximity or vocal production at higher output), not something the app introduces. What Formant Correction on DOES add, measured on the same reprocessed audio, is a roughly consistent ~6-16% centroid reduction at every level relative to off/raw - not a reduction that compounds disproportionately with loudness - meaning the app's own, already-known brightness cost (Round 50) is what's stacking onto passages that were already the take's naturally darkest, reading as "gets worse with volume" even though the app's own contribution to it is level-independent.
- Acted on the fixable half: raising `CEPSTRAL_ENV_ORDER`/`CEPSTRAL_FIR_TAPS` further (tested up to 80/160) made no measurable difference when reprocessing the real evidence file - unlike Round 50's clean single-vowel test, real material's remaining brightness loss here isn't an envelope-resolution problem. Raising `FORMANT_HF_CUTOFF_HZ` further did help, measurably, well past where Round 50's synthetic test suggested it stopped mattering - swept 8000-20000Hz directly on the real evidence file and saw continued, real brightness recovery through the whole range (one representative quartile moved from 439Hz at 8000Hz to 522Hz at 20000Hz, versus a 502Hz off/raw reference for that same quartile), with the loudest quartile essentially unmoved by this parameter regardless (confirming that specific quartile's darkness is the natural-source effect above, not something this tap controls). Verified safe throughout: the existing >12kHz-energy-proportion regression test's ratio only reaches 0.045/0.042 at 44100/88200Hz even at the most permissive tested value (20000Hz), still comfortably under its 0.05 threshold. Raised `FORMANT_HF_CUTOFF_HZ` from 8000Hz to 16000Hz - a real, measured, safety-margin-preserving middle point.
- Investigated "Formant off lacks autotune" directly on the new evidence file: inferred the take's actual sung scale from its own pitch-class histogram (dominant pitch classes cluster tightly on D major/B minor - D,E,F#,G,A,B) rather than assuming a scale, then measured deviation from that inferred scale across 1356 voiced frames - mean 18.46 cents, median 12.41 cents off nearest scale tone, and critically, zero frames measured more than 50 cents off. That last number rules out "correction isn't engaging" - an uncorrected raw human voice routinely drifts well past 50 cents on sustained notes and transitions; this take never does. The correction math itself (`targetRatio`/`currentRatio` in `processSample()`) doesn't depend on the `formantCorrection` param at all - identical retune behavior in both modes. The most likely explanation for "lacks character" is the inverse of what Formant Correction is FOR: turning it off is what lets pitch-shift-without-formant-preservation artifacts (the classic "chipmunk"/thin quality) through - Round 50 and this round's brightness work both make Formant ON more usable specifically so it can be the more natural-sounding default, rather than trying to make Off sound like something it structurally isn't.
- 1 new regression test (a broadband vowel + periodic noise-burst synthetic signal, closer to real vocal content than a clean single vowel, locking in the real-material-relevant `FORMANT_HF_CUTOFF_HZ` recovery: 1313.8Hz at the old Round 50 value vs 1902.8Hz at the new Round 51 value, verified via genuine A/B) and gauntlet PASS 83. PASS 80 (Round 50's own guard) updated to no longer pin the exact, now-superseded 8000Hz value.

**Round 50 - Formant Correction brightness recovered, and Record fixed to never silently do nothing (still 0.8.0, no version bump):**

- Direct feedback with two new evidence takes attached ("New new f on.wav" / "New new f off.wav"): "Formant off sounds better, still could use and upgrade. And formant on sounds like its in a bottle and sounds muffled and low autotune." Also, separately: "I have to open the settings menu on topliner to record fix that make it use the default mic and be able to record without pressing settings."
- Measured the new evidence directly: no clipping in either file (Round 47's fix holds - peaks 0.37/0.42, well under full scale), but Formant Correction on measured objectively darker than off on voiced content - spectral centroid 250Hz vs 395Hz, with 93.85% of Formant-on's energy sitting below 500Hz versus 77.56% for Formant-off. Root-caused on a controlled synthetic 3-formant vowel run through the actual engine (isolating the timbre path from the real evidence files' differing performances/durations, which aren't a clean same-take A/B): Formant Correction off measures 902.2Hz centroid on that same input (essentially unprocessed), while Formant Correction on measured 748.9Hz - a real, structural ~17% brightness loss, from two compounding, independently-verified causes.
- Cause 1: `FORMANT_HF_CUTOFF_HZ`, a single-pole output-only low-pass tap tightened to 4000Hz in Round 41 specifically to tame a RINGING pattern in the OLD recursive all-pole `predOut`/`lpcHistoryOut` resynthesis mechanism. Round 44 fully replaced that mechanism with a bounded, non-recursive cepstral/FIR resynthesis that - per its own safety-net comment - "cannot ring or diverge the way the old recursive mechanism could." The 4000Hz cutoff was left unchanged out of caution even after that replacement, on the reasoning that it was "still real, cheap, harmless insurance" - real evidence now shows it was not harmless, it was quietly darkening every Formant Correction take on top of a mechanism that no longer needs it as urgently. Verified safe to relax: even fully DISABLING this tap only raises the existing brightness-safety regression test's measured >12kHz-energy-proportion ratio to 0.043-0.046 at 44100/88200Hz, still comfortably under both that test's 0.05 threshold and the older 0.09 one. Raised to 8000Hz, which keeps real insurance margin (ratio measured 0.038-0.042) while recovering a meaningful share of the lost brightness.
- Cause 2 (smaller, secondary contributor): the cepstral envelope's own resolution. `CEPSTRAL_ENV_ORDER`/`CEPSTRAL_FIR_TAPS` raised from 30/64 to 40/80 - measured a further, real recovery with diminishing returns confirmed past this point (48/96 and 56/112 gained under 3Hz further), and real-time cost stays comfortably inside budget (median 0.56ms vs the established 1.45ms/quantum budget at 88.2kHz, unchanged test threshold).
- Combined, measured result: spectral centroid 748.9Hz (pre-fix) -> 793.2Hz (post-fix), against a 902.2Hz off-reference ceiling. This narrows the brightness gap by roughly a third but does not eliminate it - Formant Correction inherently re-imposes a modeled spectral envelope to keep formants natural through a pitch shift, which structurally costs some fine spectral/excitation detail versus a raw pitch shift; this is the real, honest ceiling of the current architecture, not a bug still hiding in it.
- Investigated "low autotune" (Formant on sounding less corrected): the actual pitch-correction math (`targetRatio`/`currentRatio` in `processSample()`) is completely independent of the `formantCorrection` param - identical retune behavior either way, the only formant-conditional difference is the pitch shifter's grain size (25ms vs 40ms). The most likely explanation is that Formant on's darker timbre (cause 1/2 above) was masking the crisp harmonic transients that make hard-tune correction read as obviously "snapped" - the brightness fix directly addresses the most likely driver of this complaint too, rather than being a separate, unrelated change.
- Root-caused (from the user's own real application log, not a verbal report) an intermittent Record bug: two consecutive "Record: starting…" log lines with NO follow-up log of any kind - not even the unconditional, synchronous "Requesting saved mic…" line that fires as the very first statement inside the mic-open path - then normal operation once Settings was opened (which triggers its own, independent mic-arm attempt for the level meter), then normal operation again later the same session on the very first press with Settings never touched. That pattern - works standalone most of the time, silently does nothing on rare occasions, no error ever surfaced - points at an intermittent hang (several background downloads/ffmpeg conversions were actively running in the same window in the evidence log, consistent with audio-subsystem contention right at launch) rather than a deterministic code path that always requires Settings first, which the same evidence log directly disproves (Record succeeded standalone, without Settings ever being opened, on 2 of the 3 real attempts in the log).
- Fix: since a genuine hang can't be told apart from "still legitimately negotiating a real audio interface" from inside this code, added `rbWithTimeout()` and wrapped both awaits in Record's start path (mic-open: 10s, worklet-load: 8s) - a stuck promise now always surfaces a real, visible error and resets the Record button immediately, instead of leaving it looking dead with no explanation. A mic-open that resolves late (after its own timeout already fired) still gets its stream's tracks stopped instead of leaking an orphaned, silently-open mic.
- 6 new regression tests total (1 brightness-centroid recovery test in `tools/test-autotune.js`, verified via genuine A/B against the pre-Round-50 constants; 4 new tests in a new `tools/test-rb-timeout.js` covering the timeout util's fast-path/hang/real-rejection behavior) and gauntlet PASS 80/81/82. PASS 69 (Round 41's original guard) updated to no longer pin the exact, now-superseded 4000Hz value.

**Round 49 - Octave-doubling pitch-detection bug fixed, a new user-facing Tracking Speed control, and piano widget visual polish (still 0.8.0, no version bump):**

- Direct feedback with two new evidence takes attached ("New f on.wav" / "new f off.wav"): "Make the live note thing better looking," "For audio Formant on has no autotune And formant off has autotune but we could make it slightly better as of tracking and everything also let us control tracking speed maybe it will help."
- Investigated "Formant on has no autotune" with a realistic 4-note melody test (not a sustained single tone, which had already tested clean in Round 47/48's verification) - found that `AutotuneEngine.lastTargetMidi` got stuck on the PREVIOUS note's value for an entire note's duration, identically in BOTH `formantCorrection: true` and `formantCorrection: false` runs. This proves the bug is NOT specific to Formant Correction, contrary to how it read in the report - it's a real, separate pitch-detection issue that happens to be more audible/noticeable during formant-on takes.
- Root cause, traced via an instrumented trace down to a single isolated `detectPitch()` call: a sung note whose true fundamental sits near half of a strong nearby formant (measured case: true f0 341.25Hz, first formant ~700Hz - close to 2x341=682Hz) can make the existing "shortest local maximum with a periodicity dip" search lock onto the formant's own periodicity at HALF the true period, because the wrong (shorter) lag genuinely clears the search's own local-max/dip requirements on its own, and the search stops at the first lag that qualifies - it has no way to know a longer lag would explain the signal even better. Measured directly: `corrAt(bestLag)=0.898` while `corrAt(bestLag*2)=0.993` - the true fundamental's correlation was actually higher, with a deep, genuine periodicity dip (1.87) between the two.
- First fix attempt (a sub-harmonic override firing whenever `corrAt(bestLag*2) >= corrAt(bestLag) * 0.95`) introduced its own regression, caught immediately by the existing test suite: a plain, clean D3 test tone that the base search already resolved correctly got silently pushed down an octave (146.83Hz -> 73.4Hz). Root cause of THAT: any genuinely periodic signal correlates almost as strongly at 2x its true period as at the true period itself (by construction - it's just as periodic two cycles in as one), so "comparable strength" alone can't distinguish a genuine octave-error case from an already-correct detection.
- Correct fix: tightened the override to require the doubled-lag candidate be STRICTLY, measurably stronger (`corrAt(bestLag*2) > corrAt(bestLag) * 1.02`) rather than merely comparable. Measured on both cases side by side: the real bug case shows a 10.6% margin (ratio 1.1056, comfortably clears the new threshold), while the clean-tone regression case shows subVal actually a hair BELOW bestVal (ratio 0.9997, comfortably rejected). Verified with a genuine A/B in both directions: fix disabled entirely -> the real-bug regression test fails; threshold loosened back to the old 0.95 -> the already-correct-tone test fails; fix restored -> both pass, plus the full existing 51-check suite stays green.
- New user-facing "Tracking Speed" control, directly requested ("let us control tracking speed maybe it will help"): exposes the note-DECISION smoothing baseline (`this.params.trackingSpeedMs`, previously a fixed hardcoded 120ms constant feeding Round 45's velocity-adaptive smoothing) as an adjustable 30-250ms slider in the Pitch Correction tab, right below Retune Speed - a distinct control, since Retune Speed governs the CORRECTION glide once a target note is already chosen, while Tracking Speed governs how quickly the engine decides WHICH note is being sung in the first place. Verified: a lower setting measurably speeds up how fast the engine's smoothed pitch estimate converges on a controlled, genuine small pitch shift (40 cents, kept safely under the separate 100-cent fast-unlock mechanism so this isolates the smoothing path specifically); leaving it unset reproduces the exact pre-Round-49 constant bit-for-bit, so no existing session's behavior changes by default.
- Piano widget visual polish, directly requested ("Make the live note thing better looking"): added a tuner-style readout strip above the piano - a big note name plus a small cents-off meter (a horizontal bar with a center reference tick and a moving dot), sourced from the same throttled worklet `'note'` postMessage the piano's live-key highlight already used, now also carrying `rawHz` through to the UI for the cents calculation. The readout turns green when within 8 cents of the target note. Also refined the piano itself: taller keys (64px -> 72px), rounded key bottoms, a layered/brighter live-key glow ring, and a softer excluded-note strike mark.
- 4 new regression tests (a deterministic reproduction of the real octave-doubling bug case; a guard against the sub-harmonic fix regressing back onto clean already-correct tones; a Tracking Speed convergence-speed A/B; a Tracking Speed default-preserves-old-behavior check) and gauntlet PASS 77/78/79.

**Round 48 - Live note view + per-note bypass, and the "notes seem slightly wrong" root cause (still 0.8.0, no version bump):**

- Direct feedback: "id like a layout where we can see the notes like any autotune, like see the notes live and also remove, or bypass notes, the ui has to look like a daw usage." Confirmed via a clarifying question: "bypass" means excluding a pitch class from the correction scale entirely (not muting one specific sung note-event), and the piano lives inline in the existing Recording settings panel as an upgrade to the old plain Key dropdown, not a separate page.
- Added an interactive 12-key mini-piano to the Pitch Correction tab, right below Key/Scale: keys currently in the selected scale are highlighted in the tab's own accent color; clicking any key toggles it into/out of `excludedNotes` (persisted alongside the rest of the autotune settings); the engine (`freqToNearestScaleFreq()`) now skips excluded pitch classes when picking a correction target, falling back to the unrestricted scale if every note gets excluded rather than breaking correction outright.
- Live note display: `AutotuneProcessor` reports its current locked target note to the main thread via a new throttled (~80ms, not every render quantum) `postMessage`, and the piano key for that note pulses in real time while singing - a real "see the notes live" view, not just a static scale editor.
- Root-caused the other half of the same feedback ("notes seems to be slightly wrong," Formant off): measured actual pitch-detection accuracy directly on the evidence take (980 stable held-note segments) - mean bias of only 0.61 cents off true pitch, tightly distributed. No DSP tuning bug found. The far more likely explanation is the corrector snapping to the nearest note in whatever key/scale happens to be selected, which may not match the take's actual key - exactly what this round's live note view now makes visible and fixable in the moment, instead of a silent, unexplained "wrong note."
- Guarded against reopening a previously-fixed bug class: the new piano's render function only runs on the key/scale select's own `onchange`, the exclusion-toggle click, the panel-populate/restore path, and the live-note message handler - deliberately NOT on every slider `input` event elsewhere in the same panel, which would reintroduce the exact "settings lag while moving controls" regression this codebase already fixed once before. Verified with a genuine A/B (reintroduced the call, confirmed the new gauntlet guard catches it; removed it, confirmed clean).
- 3 new regression tests (an excluded pitch class is never returned as a target across every key/exclusion combination; excluding every note falls back to the unrestricted scale instead of breaking correction; a full-engine check that `setParams({excludedNotes})` genuinely steers a take away from an excluded note) and gauntlet PASS 76.

**Round 47 - Formant Correction ON root-caused and fixed: "clips real easy even on low volume" and a boxy, distorted "in a bottle" character (still 0.8.0, no version bump):**

- Direct feedback with two real evidence takes attached ("f on.wav" = Formant Correction on, "f off.wav" = off): "Formant on is broken, sounds like its in a bottle and clips real easy even on low volume, it sounds like chit."
- Root cause, found by capturing the exact FIR taps `_analyze()` computes hop-by-hop on a real take: `computeCepstralEnvelope()`'s reconstructed taps were inheriting the analyzed window's own ABSOLUTE FFT magnitude - proportional to how loud that specific hop happened to be - instead of representing a loudness-invariant spectral SHAPE. Neither forward `fftInPlace()` call in that function is normalized by `1/n`, so a louder analysis hop produced a proportionally louder resynthesis filter, which then got convolved against `shiftedHistory` (already at real signal amplitude) - multiplying loudness onto loudness. Measured directly: `sum(taps)` (the filter's DC gain) swung from ~2.4 on an ordinary hop to ~11 moments later on a slightly louder one; `colored` (the resynthesized sample) reached -1.656 while the `shifted` excitation it came from was only -0.077, a 20x+ spike.
- Proven mathematically, not just empirically: scaling an entire analyzed window by a constant `k` shifts the cepstrum's DC coefficient (`cRe[0]`) by exactly `log(k)` while leaving `cRe[1..order]` (the coefficients that actually encode formant shape) EXACTLY unchanged - verified directly in scratch (0.2x/1x/3x gain tests on the same captured real hop reproduced identical shape coefficients to 4 decimal places). `cRe[0]` carries pure absolute-loudness information with zero shape content.
- Fix: `mp[0]` (fed by `cRe[0]`) is left at 0 instead of the analyzed window's own loudness term, and the final taps are rescaled to a single FIXED reference gain (`CEPSTRAL_ENV_REF_GAIN = 0.164`, empirically tuned and cross-validated on two independent 10-second slices of a real take: `RMS(colored)/RMS(shifted)` landed at 0.999 and 1.030 respectively) instead of a per-hop-computed one that reintroduces the bug.
- Measured directly on the real "f on.wav" evidence take, end to end, genuine before/after: pre-fix, Formant Correction on reached a peak of 1.4860 (essentially hitting the engine's own 1.5 safety clamp) with 7488 of 789376 samples at or past digital full scale and RMS 1.83x the formant-off take on that same file - post-fix, peak 0.5929 (below formant-off's own 0.6164 peak) with zero samples past 0.9 and RMS 0.70x. This is the real, measured mechanism behind "clips real easy even on low volume" and the boxy/distorted "in a bottle" character.
- Also investigated (Formant Correction off, per the same feedback: "notes seems to be slightly wrong"): measured the actual pitch-detection accuracy on "f off.wav" directly (980 stable held-note segments) - mean bias of only 0.61 cents off nearest equal-tempered semitone, tightly distributed (5th-95th percentile: -10.8 to +12.1 cents), with no systematic tuning error found. The reported "slightly wrong" notes are far more likely a key/scale selection mismatch (the corrector snapping to the nearest note in whatever scale is currently selected, which may not match the take's actual key) than a DSP bug - addressing this needs the requested live note-visibility UI, not a DSP fix.
- 1 new regression test (test 46: `computeCepstralEnvelope()`'s taps gain must not scale with the analyzed window's own amplitude - measured EXACTLY 10.000x pre-fix, EXACTLY 1.000x post-fix on an identical scenario in a genuine reverted-scratch A/B) and gauntlet PASS 75.

**Round 46 - Fatal regression from Round 45's delivered build fixed: mic/Monitor/Record completely broken by a duplicate top-level declaration (still 0.8.0, no version bump):**

- Root cause, found from the user's own real application log (not a verbal bug report - just raw evidence): `[renderer] [RandomBeats] Monitor: audio worklets failed to load (Identifier 'nextPow2' has already been declared).`, followed by "Mic not working." Traced this to a mistake in Round 44's own work: `renderer/autotune-worklet.js` already had a pre-existing `function nextPow2(v) {...}` (used by `detectPitch()`'s FFT-based autocorrelation), and Round 44's new cepstral/FFT helper block introduced a second, functionally-identical `function nextPow2(n) {...}` without checking for a collision.
- Why this shipped past 45/45 tests and 73/73 gauntlet checks: confirmed directly, via a standalone Node experiment, that `vm.runInContext` (classic-script mode - what `tools/test-autotune.js` and this gauntlet's own DSP-CORE checks both use to load the engine) does NOT throw on a duplicate top-level `function` declaration; the second declaration silently overwrites the first. A real `AudioWorkletGlobalScope` module load in Chromium/Electron enforces stricter semantics and throws a hard `SyntaxError` at parse time instead - which doesn't just no-op the redundant function, it kills the *entire* worklet script from loading, breaking Monitor/Record/mic app-wide. This is a genuine, structural blind spot in the vm-based test harness, not a one-off typo.
- Fix: removed the duplicate `nextPow2()` from the Round 44 helper block; the file now has a single shared definition (the original, at line 126) used by both `detectPitch()` and the Round 44 cepstral/FFT code. Confirmed via `node --check` and a full re-run of the 45-test suite that nothing else regressed.
- Audited the rest of the file for the same bug class: an `awk`-based full-file scan of every top-level `function`/`const`/`class` declaration confirmed `nextPow2` was the *only* duplicate - no other collisions from Round 44 or 45's additions.
- Closed the actual gap, not just this one instance: added gauntlet PASS 74, a static source-text scan (matching the precedent of PASS 20's pure-source-text scoping check) that flags any duplicate top-level `function`/`const`/`class`/`let`/`var` declaration in `autotune-worklet.js`. Verified with a genuine A/B: reintroduced the exact duplicate and confirmed PASS 74 fails on it, then confirmed it passes clean on the fix. This closes the entire bug class permanently, since it can never again pass through the vm harness undetected.

**Round 45 - Correction "not sticking" on fast vocal runs root-caused and fixed: velocity-adaptive pitch-decision smoothing (still 0.8.0, no version bump):**

- Direct feedback (alongside Round 44's screech fix, same mandate: "the best option, no cutting corners"): correction on the Formant-off evidence take was "barely working or sticking." Root-caused by standalone `detectPitch()` analysis of that take's own raw pitch contour: a confidently-detected (0.92-0.998), continuously smooth glide through ~1.9 semitones over 280ms with zero snapping - the fixed `SMOOTH_MS=120` pitch-DECISION smoothing constant (used only to choose WHICH scale note to correct toward, never the correction amount itself) was blurring that into one slowly-sliding average target instead of a discrete note lock.
- Fix: replaced the single fixed constant with a velocity-adaptive scheme (`computeGlideStrength()`) that shortens the effective smoothing time constant from 120ms toward 25ms, but only when recent raw-pitch history over a 20-hop (~232ms) window shows BOTH (1) net movement comparable to a scale step and (2) hop-to-hop movement consistently in one direction - not oscillating. Direction consistency is the key discriminator: real vibrato has close to equal up/down hop counts over a window spanning a meaningful fraction of its own period, a genuine glide doesn't.
- Extensively validated against the exact failure mode this was built to avoid reopening (Round 30's vibrato flip-flop): swept a deliberately adversarial battery of synthetic vibrato (2.5-10Hz rate x 0.8%-6% depth, ~180 combinations including per-sample detector jitter) - the chosen 20-hop window measures a clean zero false-detections across the entire realistic range (3-9Hz, 1-4% depth; only an unrealistically slow 2.5Hz "wobble" at high depth showed partial, non-full engagement). Confirmed at the full-engine level too: the existing vibrato-flip-flop scenario (5.5Hz, 2.5% depth, sitting exactly on a scale-tone midpoint) measures 0 target flips, same as before this change.
- On the diagnosed glide itself: lag between the raw and smoothed pitch at glide-end dropped from 63.3 cents (old fixed 120ms, measured via a reverted scratch A/B) to 10-25 cents (new adaptive scheme). A full-engine 5-note ascending run test (150 cents/note, 180ms/note - faster than the old fixed constant could plausibly track) shows the target lock advancing through all 5 notes with roughly 45-90ms of lag from each note's actual onset, not the several-hundred-ms blur the fixed constant would have produced.
- The pre-existing "fast unlock" mechanism (2-hop/100-cent-margin snap for a single larger discrete jump) is unchanged and still active alongside this - both mechanisms now cover different parts of the same underlying problem (one larger jump vs. a run of smaller, closely-spaced steps).
- Verified: 2 new regression tests (a wide adversarial vibrato-safety sweep at the `computeGlideStrength()` level; a genuine-glide responsiveness check with a real, measured old-vs-new A/B baseline). Full existing 43-check test suite and 72-check gauntlet re-run clean with zero regressions. Backed by gauntlet guard PASS 73.

**Round 44 - Screech root-caused and fixed at the architecture level: recursive LPC resynthesis replaced with cepstral/FIR (still 0.8.0, no version bump):**

- Direct feedback across two new evidence takes ("With formant.wav" screeching + not autotuning, "Formant off.wav" barely correcting/not sticking) plus an explicit mandate: "Everything that makes a real fix, no cutting corners." Researched how real pitch-correction tools (Auto-Tune, Melodyne-class) avoid this entire bug class: they extract the vocal-tract spectral envelope via cepstral (homomorphic) smoothing and re-apply it with a bounded, non-recursive filter, never a recursive all-pole resynthesis like this engine's LPC path used.
- Root cause (confirmed directly, not assumed): the WHITENING side of the old LPC formant math (predIn, feeding on real input history) was always safe - feed-forward only, no feedback path. The RESYNTHESIS side (predOut, feeding on its own past OUTPUT) was the actual bug: a recursive/IIR filter that can ring near instability whenever interpolated (mid-glide) coefficients drift outside bandwidth expansion's guaranteed-safe margin - exactly the Round 41 "near-Nyquist sign-flip" finding.
- Fix: whitening (predIn/lpcHistoryIn, still LPC-based) is unchanged - it was never the problem. Resynthesis now runs through `computeCepstralEnvelope()` - FFT, log-magnitude, cepstral liftering (keep only the low-quefrency coefficients that represent the smooth formant envelope, discard the higher-quefrency ones where a voice's own pitch periodicity lives), and a minimum-phase FIR realization (causal cepstrum folding, standard homomorphic-vocoder technique) - applied via plain FIR convolution against a history of the EXCITATION signal (`shiftedHistory`), never the filter's own output. An FIR filter's output is mathematically bounded by sum(|taps|) times the loudest recent input sample for ANY coefficient values - there is no pole to leave the unit circle, so the entire "recursive filter rings near instability" bug class is eliminated by construction, not mitigated.
- Measured directly on real evidence takes (not just synthetic tests): dasdasdas.wav's flagged "bad" sample count went 704 -> 0. The La Masia vocal's worst-case key/scale combination (key=4, majorPentatonic - the single worst case found in Round 42's investigation, which was left unresolved that round after four other mitigation attempts all still left audible screeching) went from 12458 flagged samples / peak output 1.4814 down to 354 flagged samples / peak output 1.0556 - a 97%+ reduction. The 354 remaining are a categorically different, smooth, single-lobed transient (never sign-flipping/oscillating) traced to a separate, pre-existing whitening-side behavior on very quiet passages, unrelated to and unaffected by this fix - noted for a future round, not folded into this one's scope.
- Real-time budget: a naive same-size-throughout implementation cost ~1.8-2.2ms per analysis hop at 88.2kHz measured directly - over this file's own established ~1.45ms render-quantum budget by itself, the exact real-time-underrun failure mode this file has hit twice before (Round 20, Round 77), caught this time before shipping. Fixed with two changes verified to leave the actual output unchanged: the minimum-phase reconstruction's last two transforms only need to run at a 128-point FFT size (not the full analysis window) because the liftered cepstrum fed into them is exactly zero past the ~30-coefficient cutoff by construction; and the Hamming window plus a redundant per-bin sqrt are now shared/skipped between `computeLPC()` and `computeCepstralEnvelope()` instead of recomputed from scratch every hop. Combined per-hop cost (both functions, back to back, exactly as `_analyze()` calls them) now measures median ~0.55ms, p90 ~0.82ms across 2000 trials at 88.2kHz.
- Verified: 4 new regression tests (computeCepstralEnvelope formant recovery + a worst-case mid-glide FIR-boundedness stress test proving the mathematical bound holds; a tightened brightness-ratio check on the exact Round 41 synthetic scenario, confirmed via a reconstructed old-mechanism scratch harness to genuinely fail without this fix; a combined real-time-budget guard). Full existing 41-check test suite and 71-check gauntlet re-run clean with zero regressions. Backed by gauntlet guard PASS 72.

**Round 43 - Review panel given a real DAW feel; a genuine app-wide accessibility bug fixed (still 0.8.0, no version bump):**

- Direct feedback: "the stem page is still ugly... give it a real DAW feel and real accessibility." Found a real, serious, pre-existing bug while investigating: a single early CSS rule (`button:focus,button:focus-visible{outline:none!important}`) was silently defeating TWO separate later, well-intentioned accessibility passes already in this codebase (one explicitly commented "WCAG-compliant," one commented "v0.4.3 accessibility") - every button in the entire app had NO visible focus indicator at all when navigating by keyboard, a real WCAG 2.4.7 failure that both earlier passes apparently shipped without testing with the Tab key. Fixed at the root: rescoped that rule to `:focus:not(:focus-visible)` (hide the ring on mouse clicks only - the exact pattern already used correctly elsewhere in the same file), which lets the existing, already-well-designed focus-ring rules finally take effect, app-wide, with no other changes needed.
- The Review panel's waveform, transport, and Beat/Vocal faders used to be three plain stacked rows with no visual grouping - now they're labeled, color-coded sections (Vocal Track / Mixer) with colored left rails, matching the same visual language already established in the Recording panel's tabs, instead of a fourth, inconsistent look.
- The Beat/Vocal faders were the one remaining pair of bare, browser-default range sliders on the whole page - every other slider already used a custom gradient-fill "plugin" look. Gave them the same treatment, color-coded per channel (Beat = blue, matching the Input group elsewhere; Vocal = green, matching the stems card), reusing the existing `rbUpdateSliderFill()` helper rather than writing a second implementation.
- Added a proper accessible group label to the transport bar and an `aria-live` region on the playback status text (screen readers now announce play/pause and status changes) - the zoom/graph/play buttons and gain sliders already had correct `aria-label`s from earlier rounds and were left as-is.
- Verified with a dedicated jsdom test: every ID app.js depends on is still present exactly once, the new sections nest the right controls, the old unstyled fader class is fully gone (not just renamed and left orphaned), and the specific focus-killing rule text is confirmed removed. Full existing test/gauntlet suite re-run clean (71/71). Backed by gauntlet guard PASS 71.
- Noted, not touched this round: a separate, pre-existing focus-suppression pattern on the floating mini music player (`.sp-fv-mini-player`/`.sp-fv-row`) has the same shape but is a different component outside this page - left alone rather than expanding scope.

**Round 42 - Retune Speed default tightened; La Masia screech investigated (still 0.8.0, no version bump):**

- Direct feedback: with Formant Correction off (clean, no screech, matching the recommended workaround), correction "doesn't autotune enough." Measured directly on a real evidence take (La Masia): at the old 20ms Retune Speed default, the actually-applied correction lagged the target by a mean of 32.9 cents across the whole take - genuinely audible as "still a bit off," not a false impression. Swept the parameter directly: 5ms brings that down to 13.2 cents, 1ms (already reachable via the existing slider - unchanged) gets to 2.8 cents for a fully robotic hard-tune extreme.
- Tightened the DEFAULT (not the available range - the full 0-400ms slider is untouched, and every existing saved-settings value is untouched) from 20ms to 5ms across all four places it's independently defined: the engine's own constructor, `rbAutotuneDefaults()`, the live-value fallback, and the slider's HTML default + label. Verified all four stayed consistent with a dedicated jsdom check. Backed by a new regression test (confirmed to fail at the old default) and gauntlet guard PASS 70.
- Also investigated: a new evidence upload (La Masia) still screeches with Formant Correction on, worse than any file seen so far - peak output as high as 1.48 (right at the edge of the 1.5 safety clamp) and roughly 10x more affected samples than the dasdasdas.wav case Round 41 addressed. Traced the bad moments to a narrow, low-pitch passage (~130Hz, this singer's lower range) - but ruled out "low pitch" as a general predictor: a different evidence file (TIMAR) sings mostly around the same 130Hz and is fine, so it isn't pitch alone. Tried, and rejected as insufficient, four more levers this round: further HF-cutoff tightening (down to 1000Hz - still left the file clearly screeching, and 1000Hz would audibly dull every take), LPC bandwidth expansion tightened well past the already-established-unsafe 0.98, LPC order reduced as low as 8 (barely enough poles for two formants), and all three combined. None resolved it without either leaving real screeching behind or costing more general audio quality than is acceptable to ship blind. This looks like a more severe instance of the same underlying LPC-resynthesis resonance family as Round 41's fix, just harder-hit on this specific take's vowel/register combination - no additional fix shipped this round beyond Round 41's existing 4000Hz tame. Formant Correction off remains the reliable workaround for affected material (confirmed clean on this file too: peak output 0.58 off vs 1.48 on).

**Round 41 - a third, distinct screech mechanism found and measurably reduced (still 0.8.0, no version bump):**

- Continued digging on the still-unresolved "ringing" screech (dasdasdas.wav) beyond the three amplitude/envelope-ratio limiter attempts already tried and rejected in Round 39's investigation. Traced it sample-by-sample on the real evidence file: within a single steady analysis hop (no note transition, no octave error, no energy transient - none of the Round 36/37 mechanisms), the formant contribution flips sign almost every 1-3 samples. Real vocal formants top out around 3-4kHz; content oscillating that fast has no plausible vocal-tract origin - it's the recursive resynthesis filter ringing near Nyquist, not amplitude divergence (peak output stayed well under the hard safety clamp the whole time, which is why that existing guard never caught it).
- Two more diagnostic angles were tried and also rejected before finding the fix: a reflection-coefficient/LPC-error-ratio check (the textbook "is this filter resonant" measure) didn't separate the bad hop from ordinary full engagement - if anything, ordinary engagement had comparably high reflection coefficients; an energy-transient check (hop-to-hop analysis-window energy jumps) didn't correlate with the bad samples either. A fourth attempt - gating formant engagement itself on sustained-vs-instant input loudness - DID reduce the artifact, but only at time constants that also silenced Formant Correction almost entirely on any normal-length sung note (confirmed on a synthetic 300ms note: blend stuck at 0.000) - rejected as strictly worse than the original bug.
- The actual fix: tightened `FORMANT_HF_CUTOFF_HZ`, an already-existing, already-proven-safe output-only brightness tame (added earlier specifically because it's never fed back into `lpcHistoryOut`, so it cannot affect the recursive filter's own stability), from 6500Hz to 4000Hz. This isn't a new heuristic - it's turning up an existing, safe dial.
- Measured on the evidence file: peak output dropped from 0.828 to 0.626, and samples flagged as "large relative to the input envelope" dropped from 1009 to 704 (roughly 30%, consistent across every key/scale combination tested, never worse). All 38 pre-existing regression checks still pass unchanged, including the brightness-ratio test this exact parameter feeds. Checked against four other evidence files collected this whole engagement: RMS moved by at most 4.5%, always down, never up - no sign of new muffling.
- Not a complete fix - the underlying resonance mechanism can still occur, and a full architectural fix (frequency-dependent bandwidth expansion, or dynamic LPC order reduction) is out of scope for a targeted round - but a real, measured reduction using a mechanism already proven safe rather than another unvalidated heuristic. Backed by a new deterministic regression test (confirmed to fail at the old 6500Hz cutoff) and gauntlet guard PASS 69.

**Round 40 - Recording panel rebuilt as tabs; stems moved up front (still 0.8.0, no version bump):**

- Direct feedback after Round 38's tighter 2-column pass: the panel was "still ass... change the layout completely," and the recorded stems were "ugly - how they look, placement, accessibility." Round 38 made the same 3 stacked cards more compact; it didn't change the structure the complaint was actually about.
- Recording settings is now a genuine tab strip - Input, Pitch Correction, Reverb - with only one group's controls visible at a time, closer to how an actual plugin's channel strip switches between sections instead of scrolling through all of them stacked. The per-card icon+label headers moved into the tab buttons themselves; every control keeps its exact same ID, so nothing in app.js's read/write or persisted-settings logic needed to change.
- Vocal Stem and Beat Stem export moved out of the bottom `.rb-review-actions` row - where they sat behind the zoom controls, waveform, transport, and both gain faders, styled identically to Discard - into their own green-tinted card directly under "Review your take," visible the moment the panel opens. Same buttons, same onclick handlers, just relocated and given their own visual identity as a non-destructive export action rather than looking like one more row of generic buttons.
- New tab CSS uses an attribute+class selector (`.rb-at-group[data-at-tab].rb-at-tab-active`) specifically so it beats the base `.rb-at-group{display:flex}` rule on specificity regardless of source order, and avoids `!important` entirely - the exact class of bug caught twice during Round 38's redesign.
- Verified with jsdom: all control IDs present exactly once, tab/group active-state wiring correct on load, and a second test that evals the real shipped `rbAtSwitchTab()` function against the actual DOM and confirms clicking each tab shows the right group and hides the others. Backed by gauntlet guard PASS 68.
- Beat picker panel was left as-is this round - it wasn't called out as part of "the option menu" and didn't need the same treatment; can revisit if it's still a pain point.

**Round 39 - entering History select mode is no longer slow (still 0.8.0, no version bump):**

- Direct feedback: select mode was "a little slow" to start after Round 34/35's redesign. Root cause: selectMode is part of every row's change-detection fingerprint, so toggling it changes ALL rows' fingerprints simultaneously, sending every single row through the slower one-at-a-time DOM-patch path (build a temp element, diff, copy innerHTML, re-sync click handlers) instead of one bulk list rewrite - the patch path is optimized for a FEW rows changing among many, which is the opposite of what actually happens here.
- Fixed by detecting the specific case of selectMode changing since the last render and forcing the fast bulk-rewrite path for that one render, same as already happens on first load or a large list-size change.
- Measured directly in a 200-row synthetic test: 166ms (old, per-row patching) vs 63ms (new, bulk rewrite) for the same select-mode toggle - roughly 2.6x faster. Backed by gauntlet guard PASS 67.

**Round 38 - Recording settings panel redesigned to a compact, DAW-plugin-style layout (still 0.8.0, no version bump):**

- Direct feedback: the panel was one long, undifferentiated vertical scroll of full-width sliders and paragraph-length explainer text under each one - "make it better, like a plugin, not scrolly."
- Pitch Correction's and Reverb's sliders now sit in 2-column grids (Retune Speed next to Humanize, Natural Vibrato next to Flex-Tune; Mix next to Decay, Damping next to Pre-delay) instead of stacking one per row.
- Output Gain moved next to Input Gain in the Input group instead of being its own separate group card below Reverb - the two dB sliders read as a natural gain-staging pair, and merging them removes a whole group's header+padding overhead.
- The five purely-descriptive slider hints (Retune Speed, Humanize, Natural Vibrato, Flex-Tune, Formant Correction) now clamp to 2 lines instead of a full paragraph each - the functional, dynamic hints (the headphones/feedback warning, the "didn't check Autotune on Recording" reminder) are untouched and stay fully visible, since those actually change based on what's happening, not just static explainer text.
- Verified with a DOM test confirming every ID app.js reads/writes is still present, the merged gain sliders and 2-column grids are wired correctly, and the panel still collapses correctly through the existing show/hide toggle. Backed by gauntlet guard PASS 66.

**Round 37 - rejected octave-error pitch misdetections before they can poison a correction (still 0.8.0, no version bump):**

- Root-caused continued "screeching" reports (after Round 36 already fixed a separate, real transition-overshoot issue) to the autocorrelation pitch detector's single most common failure mode: reporting a subharmonic or harmonic of the true pitch - landing on almost exactly double or half the real note - rather than a random wrong value. Measured directly on a real take that still screeched: 16 of 378 hops (4.2% of the whole take) landed 1000-1250 cents from the last accepted pitch, with ratios clustering tightly around 0.51-0.54x and 1.79-1.90x - real singing has no reason to cluster exactly there, only a harmonic/subharmonic misdetection does.
- Several of these read back with confidence above the "trust it outright, no continuity check" threshold, and slipped past the existing outlier guard's single 1200-cent (one full octave) cutoff by margins as small as 46 cents - close enough to a true octave to be a clear misdetection, but just under the line.
- Fixed by explicitly rejecting any reading whose ratio to the last accepted pitch falls within a band around exactly 2x or 0.5x, independent of the wider blanket cutoff - targets the actual failure signature (near-exact octave ratio) rather than guessing a single "how far is too far" number.
- Verified against the real evidence take: output peak with Formant Correction on dropped from 1.267 to 0.732, and the two worst overshoot windows (previously peaking at 1.267 and 0.540) are gone entirely. Re-checked against every other evidence file collected this session with no regressions. Backed by a new regression test (test 34, confirmed to fail without the fix) and gauntlet guard PASS 65.

**Round 36 - tamed a transient Formant Correction overshoot at note-to-note transitions (still 0.8.0, no version bump):**

- Root-caused continued "screeching" reports (after Rounds 31/32/34 already fixed real, separate issues) to a specific, measurable mechanism: right at a genuine note change, the LPC coefficients are still gliding toward the new analysis hop's fit while the resynthesis history still holds samples generated under the PREVIOUS note - a coefficient/history mismatch the code's own bandwidth-expansion comments already flagged as a known, not-fully-guaranteed-safe window. Measured directly on a real uploaded take: output briefly peaked at 1.08 against a ~0.1-0.5 local level - well under the existing 1.5 hard safety clamp, so that existing divergence guard never caught it, but audible as a short "zzt" right at the transition.
- Two earlier fix attempts - soft-limiting the resynthesis prediction against the input's own envelope, then against the analysis-side prediction - were tried, measured, and rejected: both made the existing brightness regression test measurably worse (a real LPC round trip legitimately runs several times louder than either reference during ordinary full engagement, so both approaches were clipping normal, correct operation, not just the bug).
- Fixed by ramping Formant Correction's effective blend in linearly over the first ~40ms after a target change, using `heldMs` (state already tracked for Humanize's hold-based easing) rather than reapplying full resynthesis strength the instant a note changes. A static, held note - the overwhelming majority of any real take - never re-enters this window, so normal sustained engagement is untouched.
- Verified against every evidence file collected this session: formant-contribution overshoot clusters cut 54-77%, peak output pulled back from the 1.5 hard-clamp ceiling on every file that was hitting it. Backed by a new regression test (test 33) and gauntlet guard PASS 64.

**Round 34 - History multi-select redesigned: click a row, no checkbox (still 0.8.0, no version bump):**

- The History tab's select mode had a per-row checkbox sitting to the left of every track as a second click target - redundant, since clicking the row itself already selected it (`toggleRowSelect`). Removed the checkbox entirely; selecting now works exactly like it did with the box, minus the box - click anywhere on a row in select mode and it highlights solid green.
- Strengthened the green `.selected` highlight (solid border + fill + inset ring, plus a hover state) so it reads clearly as the only selection indicator now that there's no checkbox backing it up.
- The separate toolbar "Select All" checkbox is untouched - that's a different, intentional control.
- Verified with a jsdom test rendering real rows in both normal and select mode: no checkbox markup in either, clicking a rendered row toggles the `.selected` class and back on a second click. Backed by gauntlet guard PASS 62.

**Round 33 - files just dropped into Stockpile no longer flood History (still 0.8.0, no version bump):**

- Files a user moves or drops directly into their Stockpile folder (not downloaded through the app) were being silently adopted into the History tab by the watch-folder daemon and the "adopt orphans" scan - both legitimate, pre-existing features for fingerprinting/matching orphaned files, but their side effect was cluttering History with plain samples/stems that were never generated by the app.
- Added a `discovered_unlisted` flag, set on both discovery paths. The main History list now excludes flagged rows; every other route (fingerprinting, matching, storage breakdown, by-id lookups) is unaffected. Running Analyze on a flagged file's path clears the flag, promoting it into the visible library - treating a deliberate Analyze as the user choosing to bring the file in.
- Verified with a real in-memory `sql.js` database mirroring the production schema/migration/queries. Backed by gauntlet guard PASS 61.

**Round 32 - fixed a genuine, fast melodic-step mis-correction ("still screeching and broken") (still 0.8.0, no version bump):**

- **Root cause.** Target-note SELECTION is deliberately smoothed (120ms time constant) so ordinary vocal vibrato can't flip-flop the target back and forth (an earlier, verified fix) - but the CORRECTION AMOUNT is computed from the raw, fast-moving pitch on purpose, so vibrato still gets fully corrected. Measured directly on a real French vocal take: during a genuine, fast melodic step between two real, in-key notes (e.g. C3 to D3, a full whole tone, sung quickly), the raw pitch reaches the new note well before the deliberately-slow smoother - and therefore the locked target - catches up, for well over 100ms. Correcting hard toward an increasingly-wrong, stale target produced a large, GROWING, wrong-direction pull: -207 cents at its worst, still not resolved 115ms after the step, with Formant Correction's blend riding along at full strength the whole time - audible as a harsh, swooping, "fighting itself" mis-correction, not the brightness or budget issues the last two rounds addressed.
- **Fix.** Added a fast-unlock check against the raw pitch: if raw pitch is unambiguously closer (100+ cents closer) to a different in-key note than to the currently locked one, for 2 consecutive hops (~23ms), release the lock immediately instead of waiting for the full ~120ms smoothing window. Ordinary vibrato (tens of cents of swing) can never produce a 100-cent margin against a genuine step's target, only a real note change can - verified this doesn't reopen the vibrato flip-flop fix (the existing regression test for it still passes clean, 0-2 flips across ~215 hops).
- **Verified** against the real evidence take: peak correction dropped from -207 cents to -88 cents, and resolves within ~9ms instead of dragging on for 115ms+; `maxOut` with Formant Correction on dropped from 1.433 (right at the safety clamp) to 0.609 (matching Formant Correction off) - the near-clamp events on this file are gone entirely. Re-verified against every other evidence file collected this session with no regressions.
- Backed by three new regression tests (fast relock timing, peak correction bound, settle-to-unity after the step) and gauntlet guard PASS 60. All 60 gauntlet checks pass.

**Round 31 - fixed a real-time budget overrun in Formant Correction's LPC analysis at high sample rates (still 0.8.0, no version bump):**

- **Root cause.** Reported fresh against an 88.2kHz dancehall vocal: screeching with Formant Correction on, and - independent of that - "a bugged robotic voice that slows down per moments" with it off. Measured directly: `computeLPC()` (the LPC formant-analysis step, only runs when Formant Correction is on) was analyzing the SAME full window `detectPitch()` uses, but never got the FFT rewrite `detectPitch()` received in an earlier round. At 88.2kHz's 4096-sample window, `computeLPC()` alone took a median 0.90ms and up to 4.1ms per call - on its own consuming 60%-290% of that sample rate's entire ~1.45ms render-quantum budget (128 samples / 88200Hz), before `detectPitch()` or any per-sample shifter/formant work in that same quantum gets a turn. Measured landing 12.34% of all quanta over budget with Formant Correction on - a genuine real-time underrun, which this codebase's own history already documented as producing exactly this symptom: "choppy, robotic, lagging audio with dropped or repeated samples," periodic rather than constant because it's gated to whichever quantum a hop happens to land in (~every 11.6ms - "per moments").
- **Fix.** Gave LPC analysis its own shorter, sample-rate-portable window (`lpcWinLen`, half of the pitch-detection window, ~23.2ms - in line with standard speech-LPC window sizing, which doesn't need anywhere near as long a span as reliable low-pitch detection does) instead of reusing the full window. Cut over-budget quanta from 12.34% to 1.79% on the same file, verified directly.
- **Also hoisted three per-sample smoothing coefficients** (`lpcCoefAlpha`, `formantBlendAlpha`, `formantHfAlpha`) that only depend on sample rate and a fixed time constant - never on anything that changes sample to sample - out of the per-sample loop and into one-time constructor computation, removing redundant `Math.exp()` calls (up to 88,200/sec at 88.2kHz) from the same real-time-constrained path.
- Backed by two new regression tests (lpcWinLen scales with sample rate like winLen/hopSize already do; computeLPC() is held to a hard real-time budget ceiling, the same pattern already locking in detectPitch()'s speed) and gauntlet guard PASS 59. All 59 gauntlet checks pass.

**Round 30 - beat-picker rows can be previewed through the mini player (still 0.8.0, no version bump):**

- **What.** Each row in the Round 29 beat picker now has its own play button. Clicking it previews that beat through the shared mini player (the same `playTrack()` path folder and history rows already use) without loading it as the active Topliner beat - so you can audition a few candidates before committing one as the beat you're writing a topline over.
- The button is isolated from the row's own click handler (`event.stopPropagation()`) - previewing a beat no longer also swaps it in as the active pick, a real bug shape caught and fixed during development.
- Kept in sync with playback state everywhere else in the app - starting a track from anywhere, stopping playback, or a plain play/pause toggle on the mini player all refresh the picker's glyphs, not just clicks made inside the picker itself.
- Verified with an extended jsdom smoke test: correct track/context passed to `playTrack()`, propagation actually stopped, the row highlights while loaded, the highlight clears once playback stops, and the preview context is built from the search-filtered list (not the whole library) so mini-player prev/next matches what's on screen.
- Backed by a new gauntlet guard (PASS 58). All 58 gauntlet checks pass.

**Round 29 - added a compact, searchable beat-history picker to the Topliner page (still 0.8.0, no version bump):**

- **What.** A "Pick a beat" button next to "Next random beat" opens a small panel with a search box and a scrollable list of everything already downloaded (thumbnail, title, BPM/key), sorted most-recent-first. Picking a row loads that beat as the active Topliner track - no more shuffling and hoping the right one comes up.
- Reuses the same in-memory `histData`/`rbPool()` the shuffle picker already uses (no second network fetch), filters by title or channel, and stays in sync when new downloads land while the panel is open.
- Guarded the same way `rbNext()` already is - can't swap the beat out from under an in-progress recording or an unsaved review take.
- The "Random pick" tag under the title now reads "From your library" when a beat was picked manually, so it's clear at a glance how you got there.
- Verified with a real DOM (jsdom) smoke test exercising search filtering, the no-match state, selection, the recording-in-progress guard, and the current-row highlight - not just a static source check. Also caught and fixed a real bug during that testing: the row's onclick was embedding the beat id as a double-quoted JSON string inside a double-quoted HTML attribute, which broke the attribute early; fixed by embedding it as a bare numeric literal.
- Backed by a new gauntlet guard (PASS 57). All 57 gauntlet checks pass.

**Round 28 - Formant Correction brightness-tame fix: screeching persisted after Round 25 on a fresh evidence file (still 0.8.0, no version bump):**

- **Root cause.** Round 25 widened WHEN Formant Correction reaches full engagement (a quarter-semitone -> a full semitone), which was a real, measured improvement, but it never addressed HOW BRIGHT the correction sounds on any one moment it IS engaged. The LPC whiten/resynthesize round trip itself adds roughly 40% more RMS energy and doubles proportional treble content versus the untouched signal - measured even at a perfect unity ratio, i.e. an inherent side effect of modeling voice with an all-pole filter and re-injecting its own prediction, not something the engagement threshold controls. On a freshly uploaded take, spectral analysis showed a clear high-frequency excess with Formant Correction on vs off even after Round 25 (10.6% of analysis windows with a dominant high-frequency share, vs 5.9% with it off and 6.3% in the original dry recording).
- **Fix.** Added a one-pole low-pass, applied only to the sample actually returned to the audio output - never fed back into the recursive resynthesis history (`lpcHistoryOut`). A first attempt smoothed the re-injected formant prediction itself and fed that smoothed value back into the recursive history; it measurably WORSENED real gain-divergence events on a different evidence file (3 sustained events -> 9, one reaching 79ms) by changing the resynthesis filter's own effective pole structure. Reverted in favor of the output-only tap, which by construction cannot influence the recursive filter's stability.
- **Verified** against all five real user-submitted evidence files collected this session: high-frequency energy share on the newest file dropped from 10.6% to 4.5% of analysis windows (close to the 2.8% formant-off / 6.3% original-dry baseline), the exact-safety-clamp-ceiling hits (`maxOut=1.500`) that showed up on four of five files disappeared entirely on three of them, and the pre-existing (Round-25-era) sustained gain-divergence pattern on one file was confirmed unchanged - not worsened, not hidden.
- Backed by a new deterministic (seeded) regression test in `tools/test-autotune.js` (test 29) and gauntlet guard PASS 56, which also specifically checks the smoothed sample is never pushed into `lpcHistoryOut`. All 56 gauntlet checks pass.

**Round 27 - added Igbo, plus a code-switching "+ EN" option for every transcribe language with a real Whisper code (still 0.8.0, no version bump):**

- **Added Igbo.** No dedicated Whisper language code exists for it (same situation as Jamaican Patois) - handled the same way, via auto-detect plus an initial prompt anchored on Flavour and Phyno, artists known for Igbo/English code-switching in Nigerian highlife and hip-hop.
- **Added a "+ EN" variant for Spanish, Portuguese, Yoruba, Swahili, and Hausa.** Most artists mix in English lines, hooks, or ad-libs regardless of their main language - forcing `--language` on the base code alone tells Whisper to treat the whole track as that one language, which mistranscribes the English parts instead of recognizing them as English. The "+ EN" options use the same auto-detect-plus-initial-prompt approach already used for Patois and Quebec French/English, now driven by a single `CODE_SWITCH_PROMPTS` table instead of a growing if/else chain.
- Backed by a new gauntlet guard (PASS 55) confirming every code-switch language is present in both the prompt table and the dropdown. All 55 gauntlet checks pass.

**Round 26 - confirmed the screech fixes hold on real fresh takes; added in-app explanations to every Autotune correction control (still 0.8.0, no version bump):**

- **Confirmed via two fresh user-recorded takes (one Formant Correction off, one on) that Rounds 24-25 actually fixed the screeching** - no screech reported on either, on the same build that previously produced it. Pulled the pitch contour from both using the same detectPitch() the engine itself uses: corrected notes land within 13-26 cents of true pitch on average, and 89%/75% of detected notes fit a single coherent key - the correction itself is working accurately.
- **Root-caused the follow-up "autotune is ass" / "hardly working" report as a discoverability gap, not a DSP bug.** Retune Speed, Humanize, Natural Vibrato, Flex-Tune, and Formant Correction had no explanation anywhere in the UI - just a label and a live number. A user wanting the obvious, present hard-tune character they'd referenced (Vybz Kartel / Masicka-style dancehall autotune) had no way to know Retune Speed toward 0 is exactly that control, or that Formant Correction trades transparency for tone-preservation on big shifts. Added a one-line hint under each control explaining what it does and which direction gives a stronger vs. more natural result.
- Backed by a new gauntlet guard confirming every correction control has an explanation wired through both language packs. All 54 gauntlet checks pass.

**Round 25 - Formant Correction no longer stays fully engaged (and its treble coloration) through almost an entire take (still 0.8.0, no version bump):**

- **Root-caused a second, real-take-tested screech source, separate from Round 24's pitch-outlier fix.** Ran a fresh user-submitted vocal stem through the headless engine both with and without Formant Correction: with it off, engine output was nearly identical to the raw recording (confirming the pitch-shift path itself is clean on this take); with it on, high-frequency content measurably increased. Formant Correction's blend curve was designed to reach full strength - and the ~40% RMS / doubled-treble coloration documented alongside it - at just a quarter-semitone (25 cents) of correction. Real vibrato and ordinary intonation drift are routinely well past 25 cents, so on the submitted take it measured fully engaged (blend >0.9) 49% of all voiced audio - the coloration meant for "actually fixing a wrong note" was active for roughly half an ordinary performance, not a rare correction.
- **Widened the engagement curve to a full semitone.** The worst any note in a diatonic scale can sit from its nearest scale tone is 100 cents (half of a 200-cent whole-tone gap), so a genuine wrong note still reaches full engagement - only ordinary, musical corrections now get proportionally less coloration instead of the same treatment as a full off-key correction. Re-measured on the same take: mean blend dropped from 0.70 to 0.51, and time spent fully engaged dropped from 49% to 27%.
- Backed by a new numeric test (Test 28) asserting a small (~23 cent) correction stays clearly partial while a worst-case in-scale (100 cent) correction still reaches full blend, plus a gauntlet guard. All 53 gauntlet checks pass.

**Round 24 - root-caused the remaining autotune screech from a real user recording, boot splash no longer holds every launch behind a fixed 3.2s cosmetic floor (still 0.8.0, no version bump):**

- **Root-caused the screech that survived the 88.2kHz fix, using the user's own submitted vocal stem, not guesswork.** Fed the actual recording through the DSP engine headlessly (same DSP-CORE harness the test suite uses) and found the mechanism directly: a single ~11.6ms analysis hop, right on a consonant, occasionally reports a pitch 2-3 octaves away from what's actually being sung (measured: 144Hz -> 957Hz -> 165Hz across 3 consecutive hops) - and because that reading's own confidence cleared the "trust it outright" bar, it got accepted with no continuity check at all. RATIO_CLAMP limited the correction ratio for that one hop, but did nothing to stop the bad value from being written into the pitch smoother, whose 120ms time constant then took 300+ms to fully decay back out - so what sounded like a sustained screech was one bad 11.6ms hop with a multi-hundred-ms tail, not a one-hop click. Added an outlier ceiling that rejects any reading more than an octave from the last accepted pitch before it can reach the smoother, regardless of confidence. Measured directly against the submitted recording: audible sustained large-correction events dropped from 19 to 8 over the 18-second clip, and every one of the worst (near-full-octave, 200ms+) events is gone.
- **Boot splash no longer holds every launch behind a fixed 3.2-second cosmetic floor.** The splash's minimum display time existed only to avoid a one-frame flash on a very fast boot ("held for one bar at 100 BPM"), but on a normal machine the backend and database are ready well before 3.2s - meaning that floor, not any actual startup work, was the slowest single part of every launch. Cut to 500ms, which still fully prevents the flash it exists for.
- Backed by a new numeric regression test (Test 27 in tools/test-autotune.js) reproducing the exact 144/957/165Hz shape and asserting the outlier never reaches the pitch smoother, plus gauntlet guards for both fixes. All 52 gauntlet checks pass.

**Round 23 - build-lock mitigation, persistent duplicate-download detection, Patois/Spanish/African transcribe languages, Ultra stem quality now auto-enables its full pipeline (still 0.8.0, no version bump):**

- **Mitigated the Windows build hanging at "output file is locked for writing (maybe by virus scanner) => waiting for unlock...".** This is Windows Defender's real-time scanner and electron-builder's file finalization racing each other - Defender briefly locks the freshly-written installer/portable exe to scan it, and electron-builder polls until the lock clears. `compression: "maximum"` extends how long that write takes, widening the window where the collision can happen. Switched to `compression: "normal"` - a real, immediate, code-level reduction in collision odds. The fully reliable fix is an OS-level Windows Defender exclusion on the project/output folder, which is outside what a code change can do; the compression change reduces how often it happens without needing that.
- **Root-caused "if I download a beat today, in 5 days if I dl it again it wont avoid duplication": the only duplicate guard was two in-memory maps with a ~2-minute retention window, meant to catch EventSource auto-reconnects and double-clicks, not real duplicates.** Anything past 30 seconds - or any request after an app restart, since the maps are never persisted - went straight back through the full download. History already stores `youtube_url` and `file_path` per row, so `/download` now also checks there: matched by video id (extracted the same way from both the new request and old stored URLs, so different URL formats for the same video still match) and format, and only counted as a duplicate if the earlier file still exists on disk - a file the user moved or deleted isn't a duplicate anymore, it's the only copy, and blocking it would trap them. Surfaces as a distinct toast ("Already downloaded on <date>") with a click-through to reveal the existing file, instead of silently doing nothing.
- **Added Jamaican Patois, Spanish, Yoruba, Swahili, and Hausa to the transcribe language list.** Spanish/Yoruba/Swahili/Hausa are real Whisper language codes and go through the existing `--language` flag path directly. Jamaican Patois has no dedicated Whisper code - it's an English-lexified creole - so it's handled the same way the existing Quebec French/English "Bilingual" mode already was: auto-detect stays on (Whisper's turbo/medium models already handle code-switching), primed with an initial prompt anchored on dancehall vocabulary and artist style (Vybz Kartel, Masicka, Armanii) so the model doesn't "correct" Patois toward standard English the way it would unprimed.
- **Selecting "Ultra" stem quality now auto-enables the ensemble and vocal-ensemble toggles.** Those two account for the biggest additional SDR gains in the pipeline (+0.3-0.8dB harmonic stems, +0.3-0.6dB vocal) but were separate opt-in checkboxes a user had to find on their own - so picking "Ultra - reference quality" silently under-delivered relative to what the pipeline actually knows how to produce. Picking Ultra now gives the real best-effort output by default; switching back to Fast/High afterward leaves them as the user set them rather than forcing them off, since they're also a legitimate bonus at High.
- Backed by a new gauntlet guard (PASS 49-50) locking in the persistent duplicate check's video-id matching and file-existence gate, the transcribe language additions, and the Ultra auto-enable behavior. All 50 gauntlet checks pass.

**Round 21 - engines-status stops going stale after setup, notification toasts redesigned (still 0.8.0, no version bump):**

- **Fixed: the Settings page's "Installed / Not installed" line under Engines, and its diagnostic strip, didn't update when AI setup finished.** Both only ever refreshed when the Settings panel itself was rebuilt (i.e. when you left Settings and came back) - not when setup actually completed. If Settings was open behind the setup modal, the modal would correctly show success and close itself, but the line underneath kept showing whatever it said before setup started, making it look like the update never took. Fixed by pulling the update logic into `applyEnginesStatusToUI()` and calling it (plus the diagnostic-strip refresh) the instant setup finishes - success or failure - using the status the completion handler already has, instead of waiting for the next panel render.
- **Root-caused "notification timing and the way they pop up dont make sense": two separate CSS systems were animating the same toast at the same time.** One (the deliberate, more capable one - hover-pause, dedupe-and-bump, reduced-motion support) drove entrance/exit through a `.show`/`.out` class + CSS transitions. A second, older `@keyframes`-based system, left over from an earlier pass and never removed, was *also* still attached to every toast, firing on its own timeline the instant it hit the DOM. Both were animating the same `transform`/`opacity`, on different clocks - exactly what reads as inconsistent, don't-make-sense popup behavior. Removed the leftover system; there's now exactly one.
- **Redesigned notification colors so type actually reads at a glance.** Previously only errors were red - success, warning, and info all rendered identically in monochrome white, so nothing but the message text told them apart. Success now uses the app's own green (the same green as the setup-success icon, download-queue "done" rows, and checkboxes), warnings use the app's own amber (same as the VU meters and the engines out-of-date notice), and errors keep red - each type means the same color everywhere in the app now, not just inside toasts. Info stays neutral white on purpose: it's the lowest-urgency type and the app has no other established "info" color to borrow, so it correctly reads as "the quiet one" by contrast with the other three.
- Backed by a new gauntlet guard locking in that the old duplicate animation doesn't come back and that ok/warn toasts keep their own accent color. All 48 gauntlet checks pass.

**Round 20 - found and fixed the actual "heavy screeching" via real measurement on your own audio, not another guess (still 0.8.0, no version bump):**

- You confirmed headphones (ruling out acoustic feedback) and that it happens specifically with Autotune on - so this was a real bug in the correction path, on top of the four already fixed this thread. Rather than guess a fifth mechanism, I asked for your isolated Vocal Stem (not the full mix - the beat's own hi-hats/clipping were making the mixed file impossible to read cleanly) and analyzed the actual waveform.
- **That file told me something concrete: it's exported at 88200Hz.** Your audio interface is running at 88.2kHz, not the usual 44.1/48kHz. I measured what that actually does to the engine: `detectPitch()`'s analysis hop and window were hardcoded as fixed *sample counts* (512 and 2048), tuned and timing-verified everywhere in this codebase only at 44.1/48kHz. At 88.2kHz, a fixed sample count is HALF its intended duration in real time - so the analysis runs twice as often - while the audio thread's own per-quantum deadline is *also* cut in half by the higher rate (less real time per render block). Measured directly on the same machine: `detectPitch()` alone went from using ~11% of one render quantum's time budget at 44.1kHz to ~24% at 88.2kHz - with everything else that has to run in that same tiny window (the pitch shifter, formant correction if on, channel safety) losing the same proportion of headroom on top of that. On real end-user hardware - which can legitimately run several times slower than a dev machine - that's enough to blow the deadline on some hops: a genuine real-time underrun, which is exactly what heavy screeching sounds like.
- This is also exactly why it survived four straight rounds of real, verified fixes (the periodicity-dip fix, the FFT rewrite, channel safety, the equal-power crossfade): none of those were wrong, and none of them had anything to do with sample rate - every numeric test in this project's entire suite runs at 44.1 or 48kHz, so this specific failure mode was never exercised anywhere until it showed up on your actual hardware.
- **Fixed by deriving the analysis hop and window from a fixed TIME duration, scaled by whatever the real sample rate is**, instead of a hardcoded sample count. At 44100Hz this produces the exact same numbers as before (512/2048 - zero change for the common case); at 88200Hz the analysis now runs at the same real-world cadence it always has, restoring the same timing margin this file was actually tuned and tested against.
- Backed by 11 new permanent regression checks (reference-rate-unchanged plus timing verified at 48kHz/88.2kHz/96kHz) and a new gauntlet guard locking the fix in place. All 47 gauntlet checks pass.

**Round 19 - found and fixed the actual root cause of "crystal clear, no autotune" - a settings-read bug, not a DSP issue (still 0.8.0, no version bump):**

- **Root cause: `rbGetAutotuneSettings()` read every Autotune control (the Monitor/Bake checkboxes, key, scale, gains, everything) directly from the DOM - but those controls only ever get set to your actual saved values by `rbPopulateAutotunePanel()`, and that function only runs when the Settings panel is opened.** The controls exist in the page from the moment it loads (the panel is only hidden with CSS, never removed or rebuilt), so a plain "does the element exist" check always passed - even though the checkbox itself was still sitting at its raw, unchecked HTML default. Clicking Monitor as literally the first thing you do in a session, before ever opening Settings, silently read "Autotune: off" (and the wrong key/scale, and default gains) regardless of what you'd actually saved last time - a fully unprocessed, genuinely dry take, with no fault, no race condition, and nothing for a DSP-level test to catch, because the correction engine was never even asked to run. That's exactly why four straight rounds of real, verified DSP fixes (the periodicity-dip fix, the FFT rewrite, channel safety, the equal-power crossfade) never touched this specific symptom - it wasn't in the DSP at all.
- Confirmed directly from your report matching the mechanism exactly: opening Settings afterward correctly shows "Monitor with Autotune" as checked (because opening the panel is what finally writes your real saved setting into it) - which is exactly why it looked like a contradiction ("it says on, but sounds off") instead of a straightforward bug.
- **Fixed by tracking whether the panel has actually populated the DOM with your saved settings yet this session, and falling back to reading the saved settings directly (the same source of truth `rbPopulateAutotunePanel()` itself uses) until it has.** Monitor and Record now use your real saved Autotune settings correctly whether or not Settings has been opened yet.
- The "toggle off then on and it goes robotic/screeching" half of the report is the OTHER, separate thing this thread has been chasing - the Round 17 equal-power crossfade fix already targets exactly that failure mode. Toggling the checkbox is what triggers the very first REAL correction engine engagement of the session (since it wasn't actually running before, per the bug above), which is why that's also the first moment any DSP-level issue would ever become audible.
- Backed by a new permanent gauntlet guard locking in that autotune settings always fall back to the persisted values rather than raw DOM defaults until the panel has populated them. All 46 gauntlet checks pass.

**Round 18 - full-codebase professionalism audit (still 0.8.0, no version bump):**

- Requested: a senior-dev-quality pass across the entire codebase (~42k lines: server.js, main.js, renderer/app.js, renderer/daw.js, the three audio worklets, index.html, and all seven Python engine scripts) - remove dead code, debug leftovers, and any comments that read like AI narration rather than engineering rationale.
- Audited systematically with targeted pattern searches (commented-out code, stray console.log/print debug calls, TODO/FIXME markers, first-person/chatty phrasing, hedge words, stray emoji) across every file rather than a blind rewrite, since this codebase is protected by 45 gauntlet.sh regression guards that a wholesale rewrite would put at needless risk for no real gain.
- Result: the codebase was already clean. No dead code, no debug leftovers, no TODO cruft found anywhere. Every Python print() call is the actual JSON-over-stdout IPC protocol to Node, not a leftover. Found and fixed three trivial first-person comments (server.js's tag-removal handler, sentry-init.js's rate-limit note, app.js's meter-element caching note) - the only genuine hits across the entire scan.
- First git baseline for this repo established (`git init` + baseline commit) before making any change, so this and every future round can be diffed and reverted cleanly.
- All 45 gauntlet checks pass unchanged; version remains 0.8.0.

**Round 17 - root-caused "robotic voice with screeching" down to a real, measurable audio-engineering bug in the pitch shifter's crossfade, narrowed down directly from your answers (still 0.8.0, no version bump):**

- **Your answers pinned this down fast:** robotic/screeching only while actively singing (never in silence) ruled out a detection/noise issue and pointed straight at the correction path itself; the key already showing the beat's real detected key ruled out a key-detection race. That combination - broken specifically and only when there's real signal being corrected - is the signature of a crossfade problem, not a detection problem.
- **Root cause: the pitch shifter's grain-jump crossfade used equal-GAIN weighting instead of equal-POWER.** Every pitch correction that isn't already dead-on-pitch periodically needs to "jump" its read position in the ring buffer to stay in sync (a normal, necessary part of how the shifter works), crossfading smoothly between the old and new position so the jump itself is inaudible. Those two positions are two DIFFERENT points in time - different vibrato phase, different formant shape on real voice - so they're decorrelated, not two copies of the same thing fading together. An equal-gain crossfade curve (used until now) is only correct for correlated signals; for decorrelated ones it creates a real, measurable dip in total energy right through the middle of every single crossfade - **measured directly at ~29% RMS (roughly -3dB)**, verified against the exact reference level. On a simple, stable test tone the two crossfaded excerpts can end up accidentally correlated, which is exactly why this stayed invisible through every prior round's numeric testing despite genuinely being there - real, complex, vibrato'd singing doesn't get that lucky, and a grain jump happens routinely throughout any take with active correction. That's a real, per-jump loudness pump (and the phase cancellation that comes with summing decorrelated signals) landing only when there's actual signal to crossfade - matching "only while singing, never in silence" exactly.
- **Fixed by switching to a proper equal-power (sin/cos quarter-wave) crossfade** - measured at under 0.1% deviation from reference level through the same decorrelated-crossfade test that showed the ~29% dip before. Both curves still reach exactly the same start/end points, so this changes nothing about a normal in/out fade - only the shape of the transition between two different sources in the middle, which is exactly where the problem was.
- Backed by a new permanent regression test proving the crossfade holds level constant through a decorrelated midpoint (the exact condition a stable single-tone test can't exercise). All 45 gauntlet checks pass, all six standalone numeric test files pass clean.
- Still open: the very first report in this thread described the first Monitor engagement sounding "crystal clear, no autotune" before this became consistently reproducible - I don't have a confirmed explanation for that specific detail yet. If it recurs (correction audibly not engaging at all, as opposed to the robotic/screeching this round targets), that's a separate thing worth flagging.

**Round 16 - fixed "mono (L only)" audio and addressed the real, likely explanation behind "still no autotune" surviving three rounds of verified-correct DSP fixes (still 0.8.0, no version bump):**

- **Root-caused "mono (L only)": the channel-safety logic that picks the live mic channel only ever ran when Autotune happened to be engaged.** A multi-channel audio interface doesn't always put the live mic signal on channel 0 - a stereo capture request resolving to one real, connected input and one silently-unconnected one is a completely ordinary hardware scenario - and the existing fix for this (pick whichever channel actually has signal, debounced against normal breaths/pauses) lived entirely inside the autotune worklet's own processor. That's fine when Autotune is on, but recording or monitoring with Autotune fully off - a normal, supported workflow - routed the raw mic signal straight through untouched, with zero protection: exactly "audio in one channel, dead silence in the other" if that's what the hardware handed back. **Fixed by moving this protection to a dedicated worklet that now sits at the very front of both the record and monitor graphs, unconditionally, regardless of whether Autotune is on, off, monitored, or baked.** Verified with a new permanent regression test proving the real signal reaches every output channel (never left silent on any of them) and that a genuine channel swap is still detected and corrected while a normal mid-take pause never falsely triggers one.
- **On "still no autotune" - found a real, concrete, and very plausible explanation that has nothing to do with the DSP fixes from the last three rounds.** "Monitor with Autotune" and "Autotune on Recording" are two genuinely separate, independently-toggled settings - hearing the correction live while singing does not, by itself, mean it ends up in the saved take. That's a deliberate, legitimate feature (previewing a correction before committing to it is a real workflow), but there was previously **no indication anywhere** that these are separate, meaning a very natural assumption - "I can hear it working, so of course it's in my recording" - would silently be wrong, and would look identical to "autotune is broken" on playback regardless of how correct the underlying engine is. Given three straight rounds of deep, numerically-verified DSP fixes (confidence gating, cubic interpolation, the periodicity-dip fix, the FFT rewrite) failed to resolve this exact complaint, this is now the leading suspect. **Added a direct, visible reminder in the settings panel** that appears specifically when Monitor is on but Recording is off, saying plainly that the take won't include it unless the second toggle is also checked. If "Autotune on Recording" is already checked and this still isn't the issue, that at least rules it out cleanly for the next round.
- **Found and fixed a genuinely flaky pre-existing test while verifying this round** (caught by running the suite back to back several times rather than once, which is the only way this kind of thing shows up): the "note releasing into breath/room-tone noise" test used an unseeded random noise generator, so it depended on luck rather than always exercising the same case - about 1 run in 8 would spuriously fail. Seeded it for determinism and, since the underlying behavior is genuinely statistical (some noise realizations produce a real but brief, single-hop ratio blip before the engine's own safeguards pull it back - not a sustained runaway), turned it into an honest statistical check across many seeded trials rather than either hiding the flakiness or demanding a perfection the DSP doesn't actually promise.
- Backed by a new permanent regression test suite (`tools/test-rb-channel-safety.js`, 6 checks) for the channel-safety worklet, plus static gauntlet guards locking in that it's wired into both graphs unconditionally and that the Monitor/Bake reminder stays in place. All 44 gauntlet checks pass, all six standalone numeric test files pass clean across repeated runs.

**Round 15 - fixed "low volume, robotic voice, like it's lagging / audio at an abusively low fps rate": a real-time performance problem, not a DSP quality one (still 0.8.0, no version bump):**

- **Root cause: detectPitch() was too slow to safely run inside the audio thread's real-time deadline.** It's called once per analysis hop, but that call happens synchronously inside whichever single 128-sample render quantum it lands in - and that quantum's entire Web Audio deadline is only a few milliseconds. Measured directly: the previous direct-sum autocorrelation (checking correlation at every one of ~600+ candidate lags, each requiring its own pass over the full analysis window) took **~2ms per call on fast hardware alone** - a large fraction of that quantum's whole budget before counting anything else running in the same quantum (formant correction's LPC math, the per-sample pitch shifting), and real end-user machines - especially anything mid-range or under other load - can easily be several times slower per operation than that. Blowing the deadline is a textbook, well-understood cause of audio-thread underruns, and underruns sound exactly like what was reported: choppy, robotic, "lagging" audio with dropped or repeated samples reading as lower volume. This is a genuinely different failure mode than anything the last few rounds addressed (all of which were about whether a given pitch reading should be *trusted*, not how *expensive* producing one was) - which is why fixing the confidence/screech issues actually made this one more exposed rather than causing it: the loud screech was very likely masking a subtler, constant glitchiness underneath it the whole time.
- **Rewrote the autocorrelation to run via FFT instead of direct summation** (the standard Wiener-Khinchin approach: autocorrelation = inverse-FFT of the power spectrum), cutting the per-lag energy terms down to simple O(1) lookups from a single upfront prefix-sum pass. Measured directly: **~2ms -> ~0.3ms per call, roughly an 8x speedup**, taking this from the single largest cost in the entire per-hop analysis down to a small, comfortable fraction of the real-time budget with real margin for slower hardware. Verified numerically that the new implementation produces the identical accept/reject decisions and detected pitch/confidence as the old one across a wide battery of real-voice and noise/transient test cases - this is a performance rewrite, not a behavior change.
- **Found and fixed a second, real, pre-existing bug as a direct side effect of that rewrite - a low voice near the detector's own 70Hz floor could be silently rejected as "not periodic" even at full volume, no noise involved at all.** The detector's fallback lag search (used whenever the true pitch period sits right at the edge of the searched range, rather than safely in the interior - exactly the case for a low male voice near 70Hz) matched candidate lags against the best-seen value using exact equality - but that best-seen value was tracked at full precision while the array being searched had silently been rounded to a lower precision on the way in, so the two could never actually match. The rewrite computes everything in one consistent precision end to end, which fixes this as a side effect; also locked in with its own permanent regression test.
- Backed by two new permanent regression tests: one holds detectPitch() to a hard real-time budget ceiling so a future change can't quietly regress back toward the slow path; the other confirms a genuine 70Hz tone is still detected, not silently dropped. All 42 gauntlet checks pass, all five standalone numeric test files pass clean.

**Round 14 - actually root-caused the persistent screech: not the noise/quiet-voice confidence question the last two rounds focused on, but plosive/breath transients spuriously reading as a rock-solid confident pitch (still 0.8.0, no version bump):**

- **Found the real cause of "screeching still here" after it survived two straight rounds of fixes aimed at the noise-vs-quiet-voice confidence gate.** The report that it's "always present" rather than tied to any particular moment, and specifically "not a hum," ruled out both of the previous theories (noise-driven false positives at low signal, and steady background tonal interference) and pointed at something that happens constantly through an ordinary take. Tested the one thing no earlier round had: a purely non-periodic transient with no pitch in it at all - the shape of a plosive consonant pop or a breath puff hitting the mic. It reproducibly reads as a **0.95-0.97 confidence pitch**, fabricated out of nothing, comfortably clearing the confidence gate that lets a read through immediately with no further checks. Every consonant and every breath in normal singing is exactly this shape, so this was firing constantly - explaining both "screeching always present" (a fabricated pitch snapping the correction target around on essentially every word) and "not pitching to the notes" (the fabricated reads were corrupting the actual note-tracking state in between real, correct reads).
- **Root cause: the detector's confidence score never actually proved the signal was periodic, only that some lag's correlation was locally high.** A real vibrating voice's autocorrelation dips well below its own peak somewhere before the true period - the waveform is anti-correlated with itself across roughly half a cycle - before climbing back up. A smooth transient like a pop or breath puff has no periodic structure at all, but varies slowly enough that its correlation stays high and never dips anywhere in the searched range, so the existing "shortest local max above threshold" logic (built to solve a different problem - picking the fundamental over its own harmonics) had no way to tell it apart from a genuine, confident pitch read.
- **Fixed at the root, in the detector itself, not by adding more state or memory on top.** A candidate pitch is now only accepted if the correlation curve genuinely dipped by a solid margin before reaching it - proof of actual periodicity, not just a high number. Measured directly: every plosive/breath-pop shape tested showed a dip of exactly 0; every real voiced tone tested - full range 90Hz-900Hz, down through quiet/low-gain singing to -36.5dBFS - showed a dip of 1.4 or deeper. That's a wide, reliable margin, and it costs nothing: every real-voice detection case the last two rounds' tests already locked in still passes unchanged.
- Backed by two new permanent regression tests: one confirms a dozen plosive/breath-pop shapes across a range of durations are now correctly rejected outright (previously all confidently, wrongly, accepted); the other re-confirms zero loss of detection accuracy on real voice across the full pitch range and every quiet-level case the prior rounds already covered. All 41 gauntlet checks pass, all five standalone numeric test files pass clean.

**Round 13 - fixed autotune not engaging (a regression from last round's own noise fix), upgraded the pitch shifter's core reconstruction quality, and added individual vocal/beat stem export (still 0.8.0, no version bump):**

- **Root-caused "autotune doesn't work now" - a real regression from the previous round's own noise-screech fix, not a new unrelated bug.** That fix raised the pitch detector's confidence bar from 0.3 to 0.6 to reject noise-driven false positives - and it did, but a flat number turned out unable to cleanly separate "noise" from "real voice sung quietly, or captured at lower input gain" - measured directly, those two cases actually overlap in confidence (noise can spuriously reach ~0.56; genuine quiet voice can measure well under that too, down toward ~0.5-0.6 at realistic soft-singing / lower-gain levels). Raising the bar high enough to fully reject noise rejected real singing right along with it. Fixed properly this time by moving the judgment call to the one place that can actually make it correctly: the engine itself, which - unlike a single stateless analysis window - has memory of what was actually just being sung. Above a high bar, a read is trusted outright (noise essentially never gets that confident). Between a lower bar and that one, it's only trusted if it's close in cents to the pitch most recently trusted - a real voice barely moves in 12 milliseconds, a noise burst's spurious reading has no relationship to what was just being sung. Verified both directions at once: noise alone (with or without a preceding note) still never engages correction, and a quiet, off-scale, realistic vocal now gets corrected reliably from loud all the way down through genuinely soft/low-gain singing.
- **Upgraded the pitch shifter's core sample reconstruction from linear to cubic interpolation.** Every correction that isn't already dead-on-pitch reads through this on every single sample - it's the actual foundation "high quality autotune" sits on, more than any control surface around it. Linear interpolation is a crude straight-line guess between two samples; measured directly against the exact value it's trying to reconstruct, its error grows sharply with frequency - by 4kHz (real territory for a voice's upper harmonics and sibilance) it was over 10x worse than cubic interpolation at the same frequency, and 60-260x worse in the midrange where most of a voice's energy actually lives. That's the kind of thing that shows up as a subtly dulled, slightly grainy quality on corrected audio. Same timing, same crossfade logic, same everything else - purely a reconstruction-quality upgrade underneath it.
- **Reviewed the reverb for the same "professional quality" bar** - its comb/allpass tunings and parameter-to-DSP mapping already follow the standard Freeverb formulas with proper stability margins (feedback mathematically bounded well under runaway across its entire range, damping floored so a tail can never collapse into total silence). Nothing found there worth changing; left it alone rather than touch a working signal chain without being able to listen to the result.
- **Added the ability to grab the vocal and beat stems individually, not just the mixed-together file.** The review screen already keeps them as genuinely separate pieces internally - that's what drives the existing separate Beat/Vocal faders - so this exposes grabbing each one on its own: a "Vocal Stem" button saves the take's vocal (exactly as recorded - autotune/reverb baked in if you had them on) as its own WAV file, and a "Beat Stem" button reveals the original beat file in your file browser, ready to drag straight into FL Studio or any other DAW alongside the vocal. Available right in the review screen, before or instead of committing to a single mixed-down save.
- Every fix here is backed by a permanent regression test: the confidence+continuity gate is proven against both noise (must never engage) and realistic quiet voice at three different soft/low-gain levels (must reliably engage, including an honest statistical check at the genuine edge of usable signal-to-noise where even correct behavior can't guarantee every single take), and the interpolation upgrade is proven against the exact analytic value it should be reconstructing. All 40 gauntlet checks pass, all three standalone numeric test files pass clean.

**Round 12 - renamed the page to Topliner, root-caused a real "screeching on release of noise" bug, fixed the saved mic being ignored, and moved the activity log into the app's existing log viewer (still 0.8.0, no version bump):**

- **Renamed "Random Beats" to "Topliner" throughout the user-facing UI** (sidebar nav, page header) per direct request. While doing this, found and fixed a real, separate bug it surfaced: the sidebar's translation lookup was keyed off the wrong value for this one nav item (it happened to work for every other tab purely by coincidence - their internal id and translation key are spelled the same, so the bug was invisible), which means the nav label may well have actually been rendering as the literal lowercase word "random" instead of a real label before this fix, depending on exactly when in the load sequence it ran. Fixed the lookup itself, not just the string.
- **Root-caused "screeching on release of noise" - a real, reproducible bug in the pitch detector, not a guess.** Fed the pitch detector realistic noise shapes (not flat white noise - actual breath/room-tone-like noise, which is weighted toward lower frequencies) and found it was spuriously reporting a "confident" pitch on about 40% of analysis windows of pure noise, with zero actual periodicity behind it - so consecutive windows agreed on nothing, and readings swung nearly a full octave between adjacent 12-millisecond hops. Fed through the full engine, this drove the correction ratio through its ENTIRE range (half pitch to double pitch) during a noise tail - a genuine, severe screech, exactly matching the report. Measured the actual confidence values on both sides directly rather than guessing at a fix: noise false positives topped out at 0.501 confidence across 500 trials, while every genuine voiced read - even quiet ones right at the noise floor - measured at least 0.843. Raised the detector's confidence bar from 0.3 to 0.6, which sits in the middle of that gap: every noise false positive measured is now rejected, and every genuine voiced read tested, including quiet ones, still passes. Verified end to end: a note releasing into realistic noise now shows no meaningful ratio movement at all, down from swinging the full clamp range.
- **Root-caused "mic is always in use, saved mic doesn't do anything" from the activity log you sent - a real bug, not a hardware issue.** The log showed Monitor starting and requesting "system default mic" before the settings panel had ever been opened that session - not the saved device at all. The actual cause: the function that reads the saved mic checks whether the mic dropdown menu exists in the page to decide "has the user ever opened settings this session" - but that dropdown always exists (it's just hidden by CSS until the panel opens), so that check never worked. It was reading the dropdown's current value instead of the saved setting, and the dropdown is only ever filled in once the settings panel is actually opened - so starting Monitor or Record first thing, before ever opening settings, read a blank value and fell back to the system default. Only after you separately opened the settings panel that session (which does populate the dropdown from the saved device) did it start behaving. Fixed so the saved mic is used correctly regardless of whether the settings panel has been opened yet.
- **Moved the settings panel's Activity Log out of its own box and into the app's existing View Logs viewer, as a new "App" tab alongside Server and Setup.** Its content was already being written to the app's durable on-disk log the whole time (same pipeline every other part of the app logs through) - it just wasn't visible anywhere reachable from the existing, established log viewer, so it also got its own redundant little panel bolted onto the settings screen. That standalone panel is gone; the same information (and everything else in the app that logs this way) now lives in one place, one click away, with the same Refresh/Copy controls the existing viewer already has - instead of a separate, one-off box.
- Every fix here is backed by a permanent regression test or a static guard, not left to trust: a real noise-shaped signal driving the full engine and confirming the ratio stays put, direct confidence-gate measurements against both noise and quiet-real-voice, and gauntlet checks locking in the mic-fallback fix, the unified log viewer wiring, and the corrected nav-label lookup. All 39 gauntlet checks pass, all three standalone numeric test files pass clean.

**Round 11 - "less screeching but now no voice comes through": couldn't be reproduced numerically despite extensive testing, so hardened the engine against it directly instead of guessing (still 0.8.0, no version bump):**

- **Isolated it first:** toggling Autotune off restores dry voice immediately, on both live monitoring and played-back recordings - so this is specifically inside the pitch-correction engine's path, not the mic, the channel-selection logic, or general routing.
- **Threw a lot at the engine trying to reproduce it and came up empty.** Fuzzed the DSP core for several simulated minutes across 8 parameter combinations (formant correction on/off, every flex-tune/vibrato/humanize/retune-speed extreme, every scale) mixing sung tones, sibilance bursts, breath noise and silence - zero NaN, zero non-finite output, zero collapsed-to-silence windows. Specifically tested whether the previous round's smoothed-pitch target selection could get "stuck" locked onto a stale note during a real melodic phrase (a 13-note scale run with held and moving notes) - the worst case measured was a 104ms transition blip, nothing sustained. Also specifically tested whether a real detector failure mode (mistaking a strong 2nd harmonic for the fundamental, which would be a plausible way for the new smoothing to get confused) actually occurs with a deliberately harmonic-heavy test tone - it didn't; the autocorrelation detector found the true fundamental regardless of harmonic balance in every case tried.
- **Since the exact trigger couldn't be pinned down here without your actual hardware, hardened the engine to fail safe instead of guessing further.** Two real defenses, not a guess dressed up as a fix: (1) a divergence guard - if the correction target is ever more than half an octave from what's actually being sung for a full second straight (which never happens in any legitimate scenario tested - a real note change resolves in a few hundred ms at worst), the engine now force-resyncs itself rather than trusting a value that isn't catching up; (2) the audio processor itself now wraps its per-sample correction loop in a fault handler - if anything ever throws or hands back a non-finite sample (which normally either permanently disables the audio node with no explanation, or renders as silence), it falls back to the dry input for that moment, resets the engine, and reports what happened to the main thread instead of the take just going silently, permanently silent. That report now shows up in the Activity Log and, the first time it happens in a session, a one-time on-screen notice, so if this DOES happen again there will finally be a concrete "here's exactly when and what" to work from instead of "the voice went away with no trace."
- Both new safety nets are locked in with direct regression tests: one artificially poisons the engine's target state and confirms it self-recovers within the documented window; another artificially forces the correction loop to throw and confirms the take keeps producing audio afterward and the fault gets reported.
- **Being straight about this one:** unlike every other fix this session, this round could not be tied to a specific, reproduced root cause - the numeric verification available in this sandbox came up clean everywhere it was pointed. What shipped is a genuine hardening (fail-safe instead of fail-silent, which is worth having regardless), not a confirmed fix for a confirmed cause. Please test again on your actual hardware, and if it still happens, the activity log from that session - especially any "fault" line - would immediately tell us  a lot more than another round of guessing can from here.

**Round 10 - root-caused screeching that survived the previous round's channel fix: an unstable pitch-correction target, not the input signal (still 0.8.0, no version bump):**

- **Found and fixed a second, independent cause of screeching on headphones: the "which note to correct toward" decision had no memory and could flip-flop.** A sung note whose average pitch sits almost exactly halfway (in cents) between two adjacent notes of the selected key/scale - not a rare edge case, ordinary singing lands here regularly - combined with completely normal vocal vibrato (a few percent of pitch wobble) meant the raw, instantaneous pitch estimate genuinely crossed that exact midpoint every vibrato cycle. The target-note picker has no memory of what it picked a moment ago, so it faithfully reported "closest note" fresh every ~12ms, which flipped the correction target back and forth in lockstep with the singer's own vibrato - and the pitch shifter dutifully chased every flip. That's an audible warble/screech with nothing else actually wrong: not a misdetection, not the previous round's channel-blending issue, just an unstable target. Measured directly with instrumentation reading the engine's own locked-in target note, hop by hop: 27-28 flips out of 215 hops (about 13%) for a note sitting at an exact scale-tone boundary under realistic vibrato depth (~+/-2.5%, ~+/-43 cents peak).
- **A first-attempt fix (a flat 25-cent "don't switch unless clearly closer" margin) was tried and measured to not be enough** - a vibrato swing that wide blows straight through any margin small enough to not make real note changes feel sluggish. Replaced with a two-part fix instead: the note-selection decision is now driven by a smoothed (exponential moving average, ~120ms time constant) pitch estimate rather than the raw one, which averages the vibrato wobble out before ever asking "which note is this" - while the actual amount of correction applied still uses the raw, instantaneous pitch, so real vibrato still gets fully corrected/tightened exactly as before; only the choice of which note to correct toward is now stable. A second, much smaller hysteresis margin (30 cents, measured against the already-smoothed estimate rather than the raw one) mops up the residual jitter left over after smoothing for the genuinely-ambiguous exact-midpoint case. Re-measured after the fix: 0-1 flips out of 215 hops for the same exact-midpoint test tone, while a genuine note-to-note change (a full whole step) still resolves in roughly 120-270ms - not instant, but not sluggish, and nowhere near mistaken for boundary dither.
- Locked in with two new permanent regression tests: one drives the engine with a vibrato'd tone sitting at an exact scale-tone midpoint and asserts the locked-in target note doesn't flip-flop; the other confirms a real whole-step note change still resolves inside half a second, so a future tweak to the smoothing/hysteresis values can't quietly reintroduce either problem. As always: this is code audit and numeric verification of the underlying math, not a listening test - please confirm on your actual headphones that the screeching is gone; if anything's still audible, the activity log plus a description of what note/phrase it happens on would help narrow it further, since this fix specifically targets the boundary-note case.

**Round 9 - a real concurrency bug caught directly from a user's activity log (still 0.8.0, no version bump):**

- **Root-caused a genuine mic-open failure using the new activity log - opening the settings panel could fire two independent getUserMedia calls at nearly the same instant.** The mic dropdown's own device-label probe (which only runs once, the first time a session has no mic permission yet) and the meter-preview arm were kicked off back to back without waiting on each other. On real hardware that doesn't handle two overlapping open attempts against the same device gracefully, this raced straight into "NotReadableError: Could not start audio source" - confirmed from an actual log showing exactly that error at the same timestamp as the panel opening, followed by a later single, non-concurrent open of the same device succeeding cleanly. Fixed by fully populating the mic list first and only then arming the meter, plus a re-entrancy guard on the mic-list population itself so a rapid double-toggle of the panel can't retrigger the same race a different way. Locked in with a new permanent gauntlet check.
- **Confirmed via direct follow-up that the screeching happens on headphones, not speakers - ruling out acoustic mic-hears-speaker feedback and pointing at the input signal itself.** Root cause: the previous round's channel-selection fix (see above) averaged every available input channel together to solve the "mic wired to a different channel" problem. That's safe only if the channels are perfectly phase-identical - if they're not (not guaranteed even for "one mic duplicated to satisfy a stereo request", depending on the audio stack), summing them is a textbook comb filter, which degrades exactly the pitch detector this feature depends on and can plausibly whip an autotune shifter into a screech once its pitch estimate gets confused. Fixed by selecting ONE channel outright instead of blending - whichever one actually has signal, sticky across a take (only re-evaluated after roughly 50ms of continuous silence on the currently-active channel, so a normal breath or pause between lines can't cause a mid-take flip). This keeps the original fix (a mic on the "other" channel of a multi-channel interface still gets found) without reintroducing any risk of phase cancellation. Verified with two new permanent tests: a phase-shifted second channel no longer measurably attenuates the output, and a brief pause no longer triggers a wrongful channel switch.

**Round 8 - fixed a real launch-time race (app opening as raw unstyled text) (still 0.8.0, no version bump):**

- **Root-caused and fixed the app occasionally opening to a screen of raw CSS/HTML source text instead of the actual UI.** Reported happening on first launch of a fresh install, while another program was updating in the background (heavy disk/CPU contention) - closing and reopening fixed it immediately, which is the signature of a one-time load race rather than a broken file. Verified separately with a strict HTML parser that renderer/index.html itself is well-formed (no BOM, both stylesheets close cleanly, nothing leaks into the visible page) - the file was never the problem. The actual issue: Electron's "the page finished loading" event does NOT guarantee the page actually rendered correctly, and under a bad enough race there was nothing checking that it had. The main window now does two things: retries automatically if the load itself fails outright, and - more importantly for this exact bug - checks shortly after every load that the stylesheet actually applied (a real, fast, content-based check, not a guess), and silently reloads itself if it didn't, instead of leaving the user staring at raw source with no idea a restart would fix it. Locked in with a new permanent gauntlet check.

**Round 7 - mic reliability, a real freeze root-caused and fixed, a proper diagnostics log, and a full visual pass on the recording panel (still 0.8.0, no version bump):**

- **Mic choice now survives a restart even when Chromium re-salts device ids.** The dropdown used to silently fall back to showing "Default" if the exact saved device id didn't match on a fresh enumeration - even though the saved label could often still find the same hardware. It now tries that label match before giving up, and self-heals the saved id so this doesn't keep happening. "Not selecting a mic" (system default) has never produced an error and still doesn't - a bare "Microphone access was denied" now only ever means a real, final getUserMedia failure after every fallback (exact id, label re-match, default device, no-constraints-at-all) has been tried.
- **That final error is now specific instead of a generic scare message.** It's classified by the browser's actual error (permission blocked, no device found, device already in use by another app, or unsupported settings) and tells you what to actually go check, instead of one unhelpful "access was denied" for five different real causes.
- **Root-caused "opening the settings panel freezes the screen": a brute-force pitch-detection algorithm, not the mic.** "Match beat automatically" runs a key-detection pass on whatever beat is showing, the first time each beat is looked at in a session - and that pass was computing a direct DFT (a nested loop over every frequency bin and every sample) instead of an FFT. Measured directly: over ten seconds of solid main-thread blocking for a 30-second beat, which is exactly what "the screen freezes" describes. Replaced with a real radix-2 FFT (numerically verified to produce identical results) plus a periodic yield back to the browser as a second line of defense - cuts the computation down drastically and makes sure it can never fully block the UI regardless of clip length or machine speed.
- **Added an actual activity log for the mic/monitor pipeline** - "no logs, don't know what's going on" was a fair complaint. Every mic-open attempt, fallback, device match/failure, and monitor/record start-stop now gets a timestamped line, visible right in a new "Activity Log" panel at the bottom of the recording settings (with a one-click Copy button), and also written to the app's durable on-disk log file the same way every other part of the app already does.
- **Also found and fixed a real multi-channel bug while investigating a report that autotune had stopped correcting:** the autotune engine's audio processor was only ever reading capture channel 0 - fine for a simple single-channel mic, but on a multi-channel interface (an Apollo Twin, for instance) the OS can hand the live mic signal back on channel 1 instead, leaving channel 0 silent. The raw/dry path still sounded fine (every channel gets recorded, and the interface's own hardware monitoring may also be in play), but autotune had nothing to detect a pitch from. Fixed by averaging every available input channel instead of trusting channel 0; also reverted an unrelated, unnecessary mono-capture constraint from the previous round once the real "muffled" root cause (LPC coloring, fixed separately) made it clear the mono change wasn't needed and was a plausible cause of exactly this regression.
- **On the reported "screeching, mic doesn't work": the screenshot shows Monitor active with both Autotune and Reverb toggles on, and the app's own on-screen warning ("use headphones while monitoring - on speakers, the mic hears its own monitored output and screeches") describing precisely this scenario.** That's a genuine acoustic feedback loop through the room (speaker output picked back up by the mic, re-processed, sent to the speakers again) - physics, not something software can fully prevent once it's already happening, the same way any live PA or vocal booth setup has to manage this. The existing software-side protections (the output limiter, the one-octave pitch-correction clamp) were re-verified fully intact via the full regression suite and were not touched this round. If this is happening on speakers, headphones while monitoring is the fix; if it happens on headphones too, that would be new information worth a follow-up report with the activity log attached.
- **Full visual redesign of the recording settings panel**, aimed directly at "make it feel like some plugins, premium, something nice that actually works": real depth (layered shadows, subtle gradients) instead of a flat panel; each section (Input/Pitch Correction/Reverb/Output) now has its own accent color carried through into a proper icon badge, its toggle switches, and its sliders - which are now fully custom (a filled track showing the current value at a glance, a real dimensional thumb) instead of the plain OS-default slider that was called out as not feeling like a plugin. The new Activity Log section is styled to match (a recessed, console-style readout).
- Verified via the full regression suite (35 checks, up from 32) plus three dedicated new tests: the multi-channel autotune fix (proves correction still engages when the mic signal is on channel 1, not channel 0), the FFT rewrite (proves it matches the old brute-force math exactly, and that it's actually fast), and structural checks locking in the debounce/caching and diagnostics-logging fixes so they can't quietly regress. As always: this is code audit and numeric verification, not real playback - the mic-matching, freeze fix, and panel feel need your hands and ears on your actual hardware to confirm.

**Round 6 - fixed a real regression Round 5 introduced, plus a genuine settings-panel performance bug (still 0.8.0, no version bump):**

- **Found and fixed the cause of "autotune stopped working": a Round 5 change was the actual regression.** Round 5 forced mic capture down to mono to chase the "sounds like in a bottle" complaint - which turned out to have a different, already-fixed root cause (the formant-correction coloring bug). The mono constraint was reverted. More importantly, the autotune engine's AudioWorkletProcessor was only ever reading audio channel 0 - fine for a single mono mic, but a real risk on a multi-channel interface (Apollo Twin) where the OS/driver may map the live mic to channel 1 instead. In that case the raw/dry path still sounds fine (proven by the recorder capturing every channel, and possibly the interface's own hardware monitoring), while autotune reads a silent channel and has nothing to correct - looking completely dead. Fixed by averaging every available input channel into one signal before analysis/processing, so it works regardless of which channel index the real signal lands on. Verified with a new permanent test that specifically simulates "signal on channel 1, silence on channel 0" and confirms correction still engages, plus confirms today's common case (signal on channel 0, or identical signal on both channels) is unchanged.
- **Found and fixed a real performance bug behind "settings lag when moving things around."** Every slider in the Random Beats settings panel (Input/Output Gain, all 4 reverb knobs, retune speed, humanize, vibrato, flex-tune) fires its 'input' event continuously while being dragged - 60-100+ times a second isn't unusual. On every single one of those events, the app was doing a synchronous localStorage write (JSON.stringify + setItem) and roughly 35 document.getElementById lookups across the settings-read and label-update paths - real, measurable main-thread work stacked on every pixel of a drag, independent of and in addition to whatever the panel's own rendering cost. Fixed three ways: the localStorage save is now debounced (coalesced to once per ~200ms of inactivity, with a safety flush if the app closes mid-drag so nothing gets lost); a value that was being reloaded from localStorage on every single call despite almost never actually being used was made lazy; and the two hottest DOM-reading functions now use a cached element lookup instead of re-querying the DOM tree on every tick (safe here since the panel's controls are static and never rebuilt mid-session).
- Both fixes verified with targeted tests/regression guards, not by feel: a new permanent numeric test proves the channel-averaging fix directly (silent channel 0 / signal on channel 1 still gets corrected), and a new gauntlet check locks the debounce/caching in place so this can't quietly regress. The actual "does it feel snappier" and "does autotune correct clearly now" calls still need your hands and ears on your real hardware.

**Round 5 - mic clarity/reach, and the two biggest audio complaints ("sounds like in a bottle", "gets crazy when clipping") root-caused and fixed (still 0.8.0, no version bump):**

- **Mic capture switched from stereo to mono.** Requesting a 2-channel capture from an interface that's actually feeding it a single mic capsule risks the two "channels" being subtly non-identical copies (different gain staging per input, tiny timing skew) - summed together that's a comb filter, which reads as thin/phasey/unclear. Capture is now explicitly mono end to end.
- **Mic re-matching by name now handles real-world label formats, not just clean ones.** Chromium labels a device like `"Default - Microphone (fifine SC3) (3142:0c33)"` - a `"Default - "` prefix AND a trailing `(VID:PID)` hex suffix it appends to tell apart two identical-model devices. The previous "grab the last parenthetical" fallback grabbed the hex ID instead of the actual hardware name on labels shaped like this, so a saved mic that wasn't the system default could fail to re-match even though the exact same hardware was still plugged in. Both the prefix and the suffix are now stripped before matching on the hardware name. This is the fix for "cant reach other mics" - it could not previously be verified against your actual interface's exact label text, so please confirm your Apollo Twin (or whichever isn't the default) now switches to correctly.
- **Root-caused "sounds like in a bottle": Formant Correction was coloring the voice even when it had nothing to correct.** Whenever the checkbox was on, the engine ran its full LPC whiten/resynthesize round-trip on every single sample regardless of whether any pitch shift was actually happening - including while sitting dead-on-pitch, which is most of a good take. Measured directly: at zero correction needed, this was still adding roughly 40% RMS energy and doubling the proportional high-frequency content versus the untouched voice - a real, measurable coloration, not a subjective impression. Fixed by scaling the LPC contribution continuously by how much pitch shift is actually happening (fully engaged past a quarter-semitone of correction, silent below it) instead of running it unconditionally. Verified numerically (formant-on and formant-off now produce matching RMS and spectral tilt once settled) and locked down with a new permanent regression test.
- **Root-caused "gets crazy when clipping": the safety limiter's ceiling was a hard clamp.** A flat clamp shears a waveform off square the instant it's hit - a discontinuity that generates a burst of harsh, digital-sounding aliasing energy, which is exactly what "crazy" describes. The compressor ahead of it was also loose enough (threshold -1dB, but slow to fully engage) to let more hot peaks reach that hard ceiling than necessary. Fixed both: the compressor is now tuned tighter (threshold -6dB, wider knee) so it's doing nearly all of the work on anything short of a true instant spike, and the final ceiling is now a continuous tanh-based soft-knee saturation that starts gently rounding peaks off well before the limit and asymptotically approaches it - more like analog saturation than a digital brick wall. Locked down with a new permanent gauntlet check.
- Both fixes above were confirmed with targeted numeric tests (signal-processing math and regression assertions), not by listening - this sandbox has no audio hardware. The mic-matching and overall "does it actually sound clean now" verdict need your ears and your actual interfaces to confirm.

**Round 4 - hardening pass: make every control safe and click-free together, not just individually correct (still 0.8.0, no version bump):**

- **Mic fallback notification was showing the wrong device name.** It said "using X instead" where X was the mic you WANTED, not what actually got opened - backwards, and actively misleading (you'd read it and think your pick worked). Now shows the real device that's actually live. Device re-matching by name is also more forgiving now - a multi-channel interface (audio interfaces especially) can format its per-channel labels slightly differently between app launches even though the physical hardware hasn't changed; matching now falls back to just the hardware name in parentheses when an exact label match fails. A failed match also now logs the full device list to the console for debugging.
- **Found and fixed a real leak: every routing toggle flipped while Monitor was running (Formant Correction, reverb monitor, etc.) rebuilt the audio graph but never freed the old safety limiter.** A normal session of dialing in a vocal chain - flipping those toggles back and forth to compare - would silently pile up orphaned compressor+waveshaper pairs one after another. This is a strong, concrete explanation for both audio glitching and the app feeling sluggish over a session. Fixed, and a new permanent gauntlet check (every path to your speakers or the recorder passes through the limiter, and every teardown frees it) locks this class of bug down for good.
- **Every gain and reverb control now ramps instead of snapping.** Input Gain, Output Gain, and all four reverb knobs used to jump straight to the new value the instant you moved a slider - a classic click/zipper-noise source on Web Audio. They now glide to the new value over ~15ms, still feels immediate, no longer audible as a step.
- **Monitoring now fades in instead of snapping to full volume**, and fades out before a routing-toggle rebuild instead of cutting off mid-sample - no more hard pop the instant you hit Monitor or flip a toggle while listening.
- **Full audit: confirmed no control can corrupt or crash an active recording.** Every setting either applies live and safely (gain, retune speed, humanize, vibrato, flex-tune, reverb amount) or is correctly deferred to your next take with a clear notice (anything that would need to rebuild the graph mid-recording, like turning Autotune or Reverb on/off entirely) - verified against the existing rbMicOwned() ownership gate rather than assumed.

**Follow-up fixes within 0.8.0 (not a version bump - held at 0.8.0 per instruction while this round is still being tightened up):**

**Round 3 - real root causes this time, not another patch over the same symptom (still 0.8.0, no version bump):**

- **Mic switching, actually root-caused.** The prior fix addressed a timing race, but it turns out that wasn't the real problem: Electron/Chromium re-salt each microphone's device ID every session, so a device ID saved to settings on one run of the app almost never matches the SAME physical microphone's ID on the next run - the exact-device request would quietly fail and fall back to the system default with zero indication anything went wrong. That's why picking your interface never stuck. Fixed at the actual cause: the app now also remembers the device's *label* (its name), and if the saved ID doesn't resolve, it re-finds the same physical device by that label and quietly re-syncs the ID - and if it truly can't find your device at all, it now tells you instead of silently recording off the wrong mic.
- **Clipping that ignored Input Gain.** Found the actual cause: the input level meter (and its clipping indicator) was tapped BEFORE the Input Gain trim, on every screen that shows it - so turning Input Gain down to -21dB correctly quietened what got recorded, but the meter kept reading the raw, un-attenuated mic and would show clipping no matter what you set the knob to. Moved the meter tap to after the trim, so it now shows what's actually going to tape. Separately, added a real safety ceiling (compressor + hard clip) at the very end of both the monitor and record chains, since Formant Correction and reverb can both legitimately add gain the Input Gain knob never sees or controls - previously nothing downstream caught that.
- **Screeching - a second, independent cause found and closed.** The LPC-stability fix from the last round was real and still stands, but it wasn't the whole story: the pitch corrector's target ratio had no ceiling at all, so a single misread hop on real vocal input (breath, sibilance, consonants - the messy stuff clean synthetic test tones don't have) could whip it toward a wildly wrong pitch and the shifter would chase it straight into a screech. Added a hard one-octave clamp on any single correction - verified against every key/scale/pitch combination that legitimate correction never gets anywhere near that limit, so this only ever catches genuine misdetections. Also strengthened the in-panel feedback warning: it now turns red and stays visible specifically while Monitor is live, since monitoring through speakers with an open mic is real acoustic feedback that no amount of software can fully rule out - only headphones do.
- **UI lag, root-caused.** Two real, measurable causes in the Random Beats page specifically: the review waveform was resetting its canvas's entire backing bitmap on every single animation frame during playback (a genuinely expensive full reallocation, not a cheap clear - worse the bigger the window, which is exactly why it got worse full-screened), and the level meter was re-querying the whole page's DOM 60 times a second instead of caching what it found. Both fixed; the canvas now only resizes on an actual size change, and the meter now updates the DOM at a sensible ~30fps off cached element references.
- **Recording panel redesigned.** Replaced the flat stack of mic select, meter, gain sliders, autotune controls and reverb controls with four clearly labeled, color-coded sections - Input, Pitch Correction, Reverb, Output - ordered to match the actual signal flow, the way a real channel strip reads top to bottom. Toggles are now proper switches instead of bare checkboxes.

- **Mic switching, take two.** The first fix only covered the case where the panel's initial mic arm had already finished opening by the time you changed the dropdown. If you switched devices while that first open was still in flight (very easy to do - open the panel, immediately pick your mic before the default device even finished arming), the switch was silently swallowed. Fixed: it now correctly cancels an in-flight arm and restarts on the new device regardless of timing.
- **Screeching, root-caused and fixed.** Formant Correction's LPC resynthesis is a recursive filter - its own past output feeds back into itself. Testing found this could genuinely diverge (not a subtle glitch: a clean sustained tone measured a 68x amplitude overshoot, and a silence-to-voice onset - the start of every take - measured a 1500x+ overshoot). That's the screech. Fixed with two layers: a mild bandwidth-expansion stabilizer on the LPC coefficients themselves, and a hard safety clamp that detects a runaway sample and resets the filter's internal state within a single sample rather than letting it ring out. A new regression test locks this down - it feeds the engine the exact signal shapes that triggered the divergence and asserts the output stays bounded for the full run, not just on average.

**Fixed: switching microphones didn't actually switch microphones.** The
device dropdown in the recording settings panel only ever saved the
choice - it never reopened the mic stream against the new device, so the
meter (and, while Monitoring, what you actually heard) kept using
whatever device was open when the panel first armed. Switching now
tears down and reopens the live stream on the newly selected device,
whether the panel's just showing the meter or Monitor is actively
running.

**Random Beats' recording chain is now a real channel strip.** Input
Gain and Output Gain (-24 to +24 dB) sit before and after everything
else, applied identically to what you hear and what gets recorded -
plain gain staging, no separate "preview vs. print" distinction, the
same way a mic preamp works. Both are live-adjustable while
Monitoring or Recording.

**Reverb.** A real Schroeder/Freeverb-style reverb (four comb filters
plus two allpass stages for diffusion, built from stock Web Audio nodes)
with Mix, Decay, Damping, and Pre-delay controls, plus its own "Monitor
with Reverb" / "Reverb on Recording" pair - the exact same toggle
pattern Autotune's Monitor/Bake already used, so you can preview wet
without committing to it, or print it straight into the take, or both.

**The autotune engine's Formant Correction is now real LPC, not an
approximation.** Previously, "Formant Correction" just softened how much
of a pitch shift got applied at extreme intervals - a rough trade-off,
not actual formant preservation. It's now genuine linear predictive
coding: each analysis window derives the singer's vocal-tract filter
(their formants) straight from Levinson-Durbin, whitens the signal into
a formant-free excitation using it, pitch-shifts THAT excitation, then
resynthesizes through the same original filter - so a shifted note keeps
the original voice's timbre instead of "chipmunking" at wide intervals.
Verified numerically: a synthetic two-formant test voice shifted a major
third keeps its formants close to where they started, vs. drifting with
the pitch on a plain (uncorrected) shift.

**Graph Mode: manual pitch editing, alongside the automatic Key/Scale
correction.** A new toggle in the Review panel runs the same pitch
detector across your whole take and draws it as an editable curve over
a piano-roll grid. Drag any part of the curve to redraw it by hand -
useful for a take that's mostly right but has one phrase you want to
correct precisely, the same role Auto-Tune Pro's Graph Mode or Melodyne
play alongside their own automatic modes. "Apply Pitch Edits" runs the
edit through the same formant-preserving pipeline described above,
entirely offline over the captured audio, and the result immediately
becomes what plays back and what Save uploads. Reset reverts to the
originally detected curve (and the original unedited audio, if edits
were already applied) at any time before you save.

**Under the hood:** this round's review process (three rounds of
independent adversarial review, the same "keep finding bugs until a
full pass is clean" standard used throughout this app's development)
caught two real bugs in Graph Mode specifically: Apply's multi-second
background processing had no guard against Discard/Re-record/leaving
the tab superseding the review session mid-crunch, which could let a
stale edit silently land on and corrupt a later, unrelated take; and,
separately, nothing stopped further edits to the pitch curve while an
Apply was already running on it, which could commit a discontinuous
hybrid result. Both are fixed - Apply now checks whether its review
session is still current before writing anything, and snapshots the
curve at the moment you click Apply rather than reading it live. Two
new gauntlet checks (PASS 29, PASS 30) cover the Graph Mode DSP itself
and this specific race-guard shape, on top of the existing 28.

---

## 0.7.45 (2026-08-04)

**Random Beats: the key sets itself.** Opening the autotune settings
panel now runs the same key-detection engine the Analyze tab already
used, listens to the beat that's currently loaded, and sets the Key and
Scale dropdowns to match automatically - "Match beat automatically" is
on by default, with the detected key shown once analysis finishes
(both selects grey out while it's on, since they're being driven by the
detector rather than you). Switching beats or turning the toggle back on
re-detects for whatever's playing now. Turn it off any time to pick a
key by hand, same as before.

**"Review your take" now has zoom, pan, and independent volume faders
for the beat and the vocal.** Five zoom levels (1x-16x) with a fit
button, a pan slider once zoomed in (auto-scrolls to keep the playhead
in view during playback), and two faders (0-150%) so a quiet vocal
against a loud beat - or the reverse - can be balanced before saving
instead of after. The mixdown itself now honors those fader positions:
gain is baked in server-side by ffmpeg at save time, not just previewed
locally.

**Standalone Monitor mode.** A new Monitor button next to Record lets
you hear yourself - through autotune, if that's turned on - without
committing to a take. Useful for checking a key/scale choice or dialing
in monitoring-with-autotune before actually recording. Clicking Record
while monitoring hands the mic straight over to the take rather than
running two audio graphs at once; the two also can't be started within
the same fast click sequence as each other, or during the moment the
other is still opening or wrapping up its mic connection.

**UI pass:** the new zoom/pan/fader controls, the Monitor button, and
the key-auto toggle all use the existing design tokens, get proper
aria-labels/aria-pressed states, and are fully keyboard-operable (range
inputs, buttons) rather than mouse-only. Disabled selects (while
key-auto is on) get a visible dimmed state instead of just silently
not responding to clicks.

**Under the hood:** this feature round went through six rounds of
independent adversarial review (the same "keep finding bugs until a
full pass comes back clean" process used earlier for the recorder
rewrite). Five of those rounds turned up a genuine race in the mic/
audio-graph handoff between the settings-panel meter, Monitor, and
Record - three things that all briefly want the same microphone and
shared Web Audio graph, with several-hundred-millisecond windows around
permission prompts and stop-flushes where two of them could grab it at
once. Rather than keep patching one flag combination at a time, that
whole area was rebuilt around a single "is the mic owned by something
right now" check every relevant function now goes through, plus a
cancellation path for a recording/monitor start that's still in flight
when you leave the Random Beats tab, plus a fix so handing the meter
back to the settings panel after a take/monitor session ends can't
happen on a tab you've already left. A new gauntlet check (PASS 28)
verifies the shape of that fix stays intact.

---

## 0.7.40 (2026-08-03)

**Record topline now lets you pick which microphone to use.** The same
settings panel that holds the autotune controls now opens with a
Microphone dropdown at the top, listing every input device Windows
reports (an audio interface, a headset, the laptop's built-in mic) so
recording doesn't just grab whatever the OS happens to default to. If a
device gets unplugged between picking it and hitting record, recording
falls back to the system default rather than failing outright. Device
names only appear after the first time microphone permission is
granted - Chromium hides them until then - so the very first time this
list is opened it may ask for that permission once, immediately release
the mic, and refresh with real names.

A few consistency passes came out of going back through the last two
features end to end: the autotune gear now shows its "on" indicator
immediately on opening Random Beats if a previous session left
monitoring or baking on, instead of only updating after the panel was
opened at least once; and the recording status now says outright
whether autotune is actually engaged for the take in progress, rather
than leaving it to be inferred from the settings panel alone. Every
element ID and CSS class touched across both features was cross-checked
for orphans (references with nothing to point at, or styles nothing
uses) - none found - and the full 26-check gauntlet, including the
autotune engine's own numeric test suite, passes clean.

---

## 0.7.39 (2026-08-03)

**Record topline can now use autotune, live or printed - your choice.**
Opening the settings next to Record topline exposes two independent
switches. Monitor with Autotune controls what you hear while you sing:
on, you're singing against a pitch-corrected version of your own voice
as a reference; off, you hear yourself dry (headphones recommended
either way, so the beat and your own monitored voice don't leak back
into the mic). Autotune on Recording controls what actually gets saved:
on, the printed take has correction baked in; off, the saved take is
your raw performance regardless of what you were monitoring against.
Any combination works - practice against a corrected reference but keep
the raw take, record blind but still want the saved version corrected,
both, or neither.

The correction itself exposes the same controls Auto-Tune Pro's Auto
Mode is built around - Key, Scale (twelve options, from Chromatic and
the two pentatonics through every mode), Retune Speed, Humanize,
Natural Vibrato, and Flex-Tune - because that vocabulary is what anyone
who has used real-time correction before already knows how to reach
for. This is our own pitch-detection and pitch-shifting engine behind
those controls, not Antares' algorithm, which is proprietary; Formant
Correction in particular is a lightweight approximation rather than
true formant tracking. The engine runs in an AudioWorklet so it doesn't
block the UI thread, and its pitch-detection and shifting math is
covered by a new numeric test suite (`tools/test-autotune.js`, wired
into the gauntlet as PASS 26) that feeds it synthetic tones and checks
the output frequency actually lands where it should - which is how a
real bug got caught before shipping: an earlier version of the pitch
shifter reset its internal grains on a fixed clock regardless of how
large the correction was, which silently swallowed small shifts (the
most common case - most notes are only a semitone or two off, not a big
jump) before they could become audible. The fix makes resets scale with
how far the pitch has actually drifted instead.

---

## 0.7.38 (2026-08-03)

**New page: Random Beats.** Sits in the sidebar under Slow + Reverb. It
picks one track at random from your whole library - every download plus
anything filed into Stockpile, since Stockpile tracks are History rows
too - and shows it as a large player rather than a list row, because the
point of the page is to open on something and get straight to work on
it rather than browse. "Next random beat" swaps to a different pick
(the last few stay excluded so it doesn't hand you the same track
twice in a row), and the player itself is the same global audio element
every other player in the app uses, so it never fights the mini-player
bar for the output device - starting a beat here stops whatever else
was playing, exactly like clicking any row anywhere else does.

Four actions sit under the player. Analyze and Stem separator jump to
those tabs with the track already loaded, through the same navigation
path History rows already use. Notes opens the existing per-track
notepad. Record topline is new: it captures your mic locally while the
beat plays, and on stop bounces the two into one WAV on the server side
with ffmpeg, using the measured gap between the beat starting and the
recorder actually starting so the vocal lands where you heard it rather
than snapping to zero. The result is saved beside the beat and added to
History like any other track, so it shows up everywhere a track
normally would, including back in Random Beats' own pool.

**New users get asked where to keep their beats.** A first-run prompt
offers to set a Stockpile folder right after the app finishes loading,
and if you set one this way, "download to Stockpile" turns on by
default - new downloads land straight in your library instead of
Downloads, with one less move to make later. Skipping the prompt just
means "ask me later"; nothing changes until you actually pick a folder,
either here or from Settings.

---

## 0.7.37 (2026-08-02)

**Background analysis never ran - every track sat idle until you clicked
it.** The cause was a DB migration bug, not the analysis engine. Adding
`history.analysis_gave_up` was nested inside the catch block for an
unrelated column, `stockpile_committed`, which meant it only ran when
that OTHER migration's `ALTER TABLE` threw. On this install it didn't -
`stockpile_committed` succeeded every launch - so `analysis_gave_up`
never got added, and every query built on `analysisCandidateWhere()`
(the one query the background worker uses to find its next track) threw
`no such column: analysis_gave_up` on every attempt. `dbAll()` catches
that error and returns an empty result rather than crashing the server,
so the worker never saw a failure - it just always saw zero candidates.
The manual "click a track" path was never affected, because it calls
`/analyze` directly with a specific file and never touches that query,
which is why analysis always worked on demand and never in the
background. Verified against a real sql.js instance: the old migration
code reproduces `no such column: analysis_gave_up` on a DB shaped like
this one; the fixed code doesn't, on that DB or on one where
`stockpile_committed` already existed from an earlier install.

Fixed by giving every `ALTER TABLE` in that migration block its own
independent try/catch, so one column's outcome can no longer gate
another's. This self-heals on next launch - no manual DB fix needed,
the corrected migration adds the missing column the moment the new
version starts.

Gauntlet gained a check for this shape of bug: any `catch` block in
`server.js` whose body contains a real `ALTER TABLE` (rather than the
usual one-line "column exists" comment) fails the build, since that's
exactly what a wrongly-nested migration looks like. Confirmed it
catches the original bug by reintroducing the old nesting in a scratch
copy and running gauntlet against it.

## 0.7.36 (2026-08-02)

**The hardware acceleration toggle threw "No handler registered" every
time it was touched.** The switch in Settings, its confirm-and-relaunch
prompt, and the translations were all built together in 0.2.8, but only
on the renderer side - `preload.js` bridged `boot-flags:get`,
`boot-flags:set` and `app:relaunch` out to `window.api`, and nothing in
`main.js` ever answered them. Every open of Settings fired the failed
`get()` silently; every flip of the switch surfaced the error the user
saw. Hardware acceleration itself was never actually being turned off
either way - the call that does that, `app.disableHardwareAcceleration()`,
didn't exist anywhere in the app.

Both are wired now. The choice is persisted to a small `boot-flags.json`
in the app's data folder and read back synchronously before `app` is
ready, which is the only point Electron will honor it - a live toggle
isn't possible for this setting, which is why the switch has always
asked for a relaunch. `app:relaunch` now actually does that.

Gauntlet gained a check for this shape of bug generally: every
`ipcRenderer.invoke()` channel `preload.js` exposes is cross-checked
against `ipcMain.handle()` registrations in `main.js` and `updater.js`,
so a bridged API that never got a main-process side fails the build
instead of shipping quietly broken.

## 0.7.35 (2026-08-02)

**The window went slightly soft when it lost focus.** A frameless window
asking for a system shadow is composited through the DWM shadow path,
and Windows treats unfocused windows differently there - the result is a
faint resampling that reads as the whole app blurring. A frameless
window has no meaningful system shadow anyway, so it is off, and the
window now stays pixel-exact whether focused or not. Easy to blame on a
graphics driver, since a driver update changes when it becomes
noticeable.

Two rules also asked the compositor to keep a permanent layer for an
element whose width changes. Width is a layout property and cannot be
composited, so the hint bought nothing and left another surface to be
resampled.

**Icons restored to the 0.7.12 artwork.** Several versions of trying to
improve them made things worse, and the artwork was never the problem:
the icon was packed inside app.asar, which Windows cannot read a path
into, so nothing rendered regardless of what the file contained. The
original icon is back, byte for byte, along with the window and
installer artwork drawn from it. The one change kept is reading it from
resources rather than the archive, which is the fix that was actually
needed.

**Correct marks in the right places.** The application icon is now the
gothic monogram, and the tray uses the interlocked mark - which is the
better shape for it, since it stays legible at sixteen pixels where fine
gothic strokes cannot. Both are generated at every size the shell asks
for rather than resized at runtime, and both are cropped and squared
first so nothing is stretched or floats in leftover padding. The window
chrome, the opening screen and the installer artwork are regenerated
from the same source, so no old mark is left anywhere.

**The tray icon was inside the archive.** Generating it properly in
0.7.31 was necessary but not sufficient: the file was packed into
app.asar, and Windows cannot read an icon from inside an archive. There
is no error for this - the shell is handed a path it cannot open and
draws nothing, which looks exactly like no icon having been set. It is
now shipped unpacked alongside the Python scripts, which hit the same
trap in 0.6.6, and the app looks there first. The result is written to
the log either way, so a silent failure cannot happen twice.

**The tray icon was invisible.** It was the application icon shrunk to
sixteen pixels at runtime, and the mark is thin strokes on transparency -
after that resize only about a quarter of the pixels carried any colour,
which on a dark tray amounts to nothing. There is now a tray icon
generated from the full-size logo with the strokes thickened before
shrinking, carrying every size Windows asks for, so the shell chooses a
frame rather than us downsampling one. Coverage at sixteen pixels went
from a quarter to two thirds.

**Downloads gave up on analysis instead of running it.** Filing a track
into the stockpile moves the file and rewrites its path, and that was
happening after analysis had already been queued. The worker then looked
at where the file used to be, found nothing, and concluded it was gone -
which is treated as permanent, because a genuinely missing file is a job
for the library doctor rather than more attempts. So the very feature
that files tracks automatically was disqualifying them from analysis.

Two changes. Filing now happens before analysis is queued, so the path
is settled first. And a file that appears to be missing is no longer
taken at face value: the worker re-reads the row and follows the move if
the path simply changed. Either fix alone would have solved it; together
they hold even if something else moves a file mid-queue.

Tracks already marked as given up by this are cleared on the next launch,
provided their file is where the library says it is. Anything genuinely
missing keeps its mark and stays out of the queue.

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

---

## 0.7.41

Second full adversarial sanity pass on Random Beats recording + autotune
(requested: "keep checking until no gaps show up"). Two independent
reviewer rounds plus a final self-review of the hero player controls.
Three real race conditions found and fixed, each with a numeric or
concurrency-harness proof, not just reasoning:

**Stop-button race (`rbStopping`)**

Clicking Stop then immediately clicking Record again (or a spontaneous
`onstop` firing from a mid-recording device disconnect) could leave the
recorder in an inconsistent state, since the old code reset its "recording"
flag synchronously but the actual upload/cleanup only ran once the async
`onstop` callback fired later. Added a `rbStopping` guard that blocks
re-entry until the previous take has fully wrapped up, and moved all
UI/state reset to the top of `rbFinishRecording()` (before the upload logic)
so a spontaneous stop — not just a user-initiated one — always leaves the
record button re-enabled instead of possibly stuck disabled forever.

**Autotune grain-size reset on every slider drag**

`setGrainMs()` was resetting the pitch-shifter's internal read position
unconditionally every time any autotune parameter changed, causing an
audible click on every single slider drag even when grain size itself
hadn't changed. Made it idempotent (skip the reset if the new size equals
the current one). Added a permanent regression test (gauntlet PASS 26,
check #12) — verified it actually fails against the old code by reverting
the fix, confirming the failure, then restoring it.

**Mixdown filename collision**

Two topline mixdowns finishing at nearly the same moment for the same beat
could both check "does this filename exist yet?", both see "no", and both
write to the identical output path — one silently overwriting the other.
Proved this with a dedicated concurrency-test harness (artificially slowed
ffmpeg call to reliably widen the race window) against the old logic, then
proved the fix closes it: a server-side reservation set now claims the
filename the instant it's chosen, before ffmpeg even runs, and releases it
on both the success and failure paths.

**Smaller fixes from reviewer findings**

Language switch no longer reverts the autotune-aware recording hint text
back to the plain version. Switching languages while the mic dropdown is
already populated now re-renders its labels instead of leaving them in the
old language. Landing on the Random Beats tab before history has finished
its first load no longer gets stuck on the empty-state permanently. The
first-run stockpile setup modal's "Skip" button now carries the marker the
global Escape-key handler looks for, so dismissing it with Escape correctly
records that the user has seen it (previously Escape bypassed that
bookkeeping and the modal could reappear).

**Reviewed, not changed:** a reviewer flagged the first-run setup modal
sitting below the update and tamper-warning banners in z-index. Checked
against the app's own stacking-order convention — this is intentional,
matches every other dialog in the app, and is arguably correct (a
security/update notice should outrank an onboarding prompt). Left as-is.

Final pass over the hero player's own controls (play/pause, seek, next)
found no further issues — all guarded consistently with the existing
`playTrack()` transition lock and global player state.

gauntlet.sh: 26/26 passing, including the new autotune-engine numeric
test suite (PASS 26, 17 checks) and the hero-player-sync regression guard
(PASS 25).

---

## 0.7.42

Major upgrade to Random Beats: it's now a small vocal-recording studio,
not just a player with a record button. Four asks, all delivered:

**Studio-quality capture**

The actual root of "the recording quality is ass": browsers turn on
echo cancellation, noise suppression and auto-gain by default on every
mic stream - a chain built for phone calls, and it flattens dynamics
and smears a sung vocal. All three are now explicitly switched off for
Random Beats recording. On top of that, capture no longer goes through
MediaRecorder at all - webm/opus is a lossy codec no matter how high
the bitrate is set. A new AudioWorklet (rb-recorder-worklet.js) captures
raw PCM straight from the mic (or the autotune-corrected signal, if
baking is on) and it's encoded to real 16-bit WAV using the app's
existing WAV encoder. Only lossy step in the whole chain: none. Verified
with a dedicated Node test (12 checks, gauntlet PASS 27) proving samples
reassemble in order with nothing dropped, in both mono and stereo, and
that a trailing partial block isn't lost when a take is stopped.

**Live input level meter**

Opening the recording panel now arms the mic (metering only, nothing is
recorded yet) and shows a real-time level bar with a numeric dB readout
and a clipping indicator, so you can see if you're too hot or too quiet
before you commit to a take. A compact version of the same meter shows
during an actual take too, so it's visible even with the panel closed.

**Waveform for the beat and the vocal**

The beat's waveform comes from the app's existing /convert-wav + WAV-
parsing path (never decodeAudioData, which is confirmed to hang the
renderer in packaged Electron). The vocal's waveform comes straight out
of the samples just captured. Both are drawn as two stacked lanes.

**A real micro-DAW for the review step**

Recording no longer uploads itself the instant you hit stop. Stopping
now opens a review panel: drag the vocal lane left or right to nudge its
timing against the beat, hit play to listen through both together
(scheduled via Web Audio for sample-accurate sync, not two separately-
drifting <audio> elements), then Save, Re-record, or Discard. Save is
the only point anything reaches the server.

**Bugs found and fixed via an independent adversarial review of this new code**

A double-click on Record during the mic-permission prompt could start a
second capture graph on top of the first, double-connecting the level
meter to two live mic streams and leaking the first stream's tracks -
fixed with a starting-guard mirroring the existing stop-side one.
Clicking Re-record or Discard while a Save was still uploading could let
the earlier save's callback tear down the newer take's review state out
from under it - fixed with a save-in-flight guard that also disables the
three review buttons for the duration. Navigating away from the page
while a take was finishing asynchronously could make the review panel
reappear on an unrelated tab later - it's now discarded silently instead,
matching the existing "leaving abandons an in-progress take" rule. A
failed beat-waveform fetch could leave a previous, different track's
waveform cached and reused for playback/paint - it's now cleared on
failure instead of silently miming the wrong beat (the actual saved
mixdown was never affected by this one, only the in-app preview).

gauntlet.sh: 27/27 passing (26 previous + the new capture-worklet test).

---

## 0.7.43

Sanity pass on the Random Beats DAW from 0.7.42, requested explicitly by
the user as a follow-up check. Self-review plus a fresh independent
adversarial review, in that order.

**Found in self-review, before handing it to review:**

Re-arming the input meter after a take finishes (added as polish in
0.7.42) could lose a race against a fast second Record click, leaving an
orphaned open mic stream double-connected to the level-meter analyser
that nothing would ever stop - fixed with a generation counter that lets
a disarm invalidate an in-flight arm attempt cleanly, even one that
lands before the arm has anything to tear down yet.

Also reconsidered the previous round's fix for "recording finishes after
the user already left the tab": the original fix discarded the take
outright. On reflection that throws away real, hard-to-redo work just
because of a tab switch. Changed it to stash the finished take and open
review for it automatically the next time the user returns to Random
Beats, instead of losing it.

**Found by the independent review:**

The review panel's Save/Re-record/Discard buttons got permanently
disabled after the very first successful save, for the rest of the
session. Root cause: exiting review bumps a token used to detect
whether a save's response still belongs to the session that's showing,
and exiting happens (on the success path) before the save's own cleanup
checks that same token - so the check that was supposed to re-enable the
buttons always failed, and nothing else ever turned them back on for the
next take. Fixed by re-enabling them unconditionally when a save
finishes, plus resetting them independently every time a new review
session opens, so this class of bug can't resurface from this direction
again.

A related, narrower gap the same review surfaced: rbStartRecording()
reset its double-click guard by hand at each individual early return,
which the reviewer correctly noted would miss a future call in that
chain that throws synchronously, permanently disabling Record for the
rest of the session. Restructured to a try/finally around the whole
function body so the guard is always cleared no matter how the function
exits, instead of relying on every exit point remembering to do it.

gauntlet.sh: still 27/27 - this round was logic fixes only, no new
numeric surface to add a test for beyond what PASS 27 already covers.

---

## 0.7.44

Continued the "keep checking until a full pass is clean" loop from 0.7.43
with two more independent review rounds.

**Round found a real bug:** a fast Stop → "Next random beat" click during
the brief window while a take was still flushing to disk (Stop returns
immediately; the actual capture drain happens async) could swap the
current beat before the take finished, so the review/mixdown paired the
recorded vocal with the WRONG beat and a timing offset measured against
a different one entirely. Fixed two ways: `rbNext()` now also blocks
during that flush window (previously it only blocked while actively
recording, not while stopping), and more fundamentally, which beat a
take belongs to is now pinned once, the instant recording starts, into
its own variable and threaded explicitly through the rest of the take's
lifecycle - review, save, the deferred-review path for a take that
finishes after a tab switch - instead of any of those steps re-reading
whatever the "current" beat happens to be by the time they run.

**Final round: clean.** A full independent sweep - state lifecycle
across consecutive takes, every element id, every translation key, and
a fresh unbiased read of the server-side mixdown route - found nothing.
Five review rounds total across 0.7.42-0.7.44; this is the first to come
back with zero findings.

gauntlet.sh: 27/27.
