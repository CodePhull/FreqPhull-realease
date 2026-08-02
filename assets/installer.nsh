; Freq.Phull - installer wizard appearance and copy.
;
; The pages only appear because build.nsis.oneClick is false. With
; oneClick on, NSIS skips to a progress dialog and every string below
; is discarded.
;
; Only settings electron-builder does not already write belong here.
; The sidebar bitmap and the icons come from installerSidebar,
; uninstallerSidebar and installerHeaderIcon in package.json, and
; redefining them makes makensis abort with "already defined".

; ---- Dark theme ------------------------------------------------------
; NSIS ships a light grey wizard, so a dark app arrives inside a white
; window that looks like it belongs to something else. MUI_BGCOLOR
; covers the page surface; the labels and the header need repainting
; individually because MUI creates them before these take effect.
!ifndef MUI_BGCOLOR
  !define MUI_BGCOLOR "101010"
!endif
!ifndef MUI_TEXTCOLOR
  !define MUI_TEXTCOLOR "E8E8E8"
!endif
!ifndef MUI_HEADERIMAGE_UNBITMAP_NOSTRETCH
  !define MUI_HEADERIMAGE_UNBITMAP_NOSTRETCH
!endif
!ifndef MUI_HEADERIMAGE_BITMAP_NOSTRETCH
  !define MUI_HEADERIMAGE_BITMAP_NOSTRETCH
!endif

; ---- Header image on the inner pages ---------------------------------
; No package.json equivalent, so it is set here. !ifndef keeps it safe
; if a future electron-builder starts writing it too.
!ifndef MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE
!endif
!ifndef MUI_HEADERIMAGE_RIGHT
  !define MUI_HEADERIMAGE_RIGHT
!endif
!ifndef MUI_HEADERIMAGE_BITMAP
  !define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\installer-header.bmp"
!endif

; ---- Welcome ---------------------------------------------------------
; What the app does, in the user's terms. No size: a number reads as a
; cost before anyone knows what they are getting.
!ifndef MUI_WELCOMEPAGE_TITLE
  !define MUI_WELCOMEPAGE_TITLE "Everything a solo artist needs, in one place."
!endif
!ifndef MUI_WELCOMEPAGE_TEXT
  !define MUI_WELCOMEPAGE_TEXT "Pull beats straight from YouTube.$\r$\n$\r$\nRead their tempo and key automatically.$\r$\n$\r$\nSplit them into stems and transcribe your lyrics.$\r$\n$\r$\nInstalls to your user folder - no administrator rights needed."
!endif

; ---- Finish ----------------------------------------------------------
; Saying the engine download is coming stops it feeling like a second,
; unannounced installer once the app opens.
!ifndef MUI_FINISHPAGE_TITLE
  !define MUI_FINISHPAGE_TITLE "Freq.Phull is installed."
!endif
!ifndef MUI_FINISHPAGE_TEXT
  !define MUI_FINISHPAGE_TEXT "When it opens, Freq.Phull will offer a one-time download of the AI engines behind stem separation and transcription.$\r$\n$\r$\nDownloading beats and reading tempo and key work straight away, while that runs in the background."
!endif
!ifndef MUI_FINISHPAGE_RUN_TEXT
  !define MUI_FINISHPAGE_RUN_TEXT "Open Freq.Phull now"
!endif

; ---- Repaint the parts MUI builds before the colours apply -----------
; The header strip and its two labels are created by MUI_HEADERIMAGE with
; system colours baked in, so they stay light unless repainted. 1034,
; 1035 and 1037 are the header text, subtext and background; 1256 and
; 1028 are the branding line at the foot.
;
; NSIS keeps the installer and uninstaller in separate namespaces and
; requires every uninstaller function to be named with an "un." prefix.
; A single shared callback therefore cannot serve both - the uninstaller
; aborts with "Call must be used with function names starting with un.".
; Hence the pair below: identical bodies, two namespaces.
!macro FP_DARKEN_HEADER
  GetDlgItem $R1 $HWNDPARENT 1037
  SetCtlColors $R1 E8E8E8 101010
  GetDlgItem $R1 $HWNDPARENT 1034
  SetCtlColors $R1 E8E8E8 101010
  GetDlgItem $R1 $HWNDPARENT 1035
  SetCtlColors $R1 AAAAAA 101010
  GetDlgItem $R1 $HWNDPARENT 1256
  SetCtlColors $R1 6A6A6A 101010
  GetDlgItem $R1 $HWNDPARENT 1028
  SetCtlColors $R1 6A6A6A 101010
  SetCtlColors $HWNDPARENT E8E8E8 101010
!macroend

!ifndef MUI_CUSTOMFUNCTION_GUIINIT
  !define MUI_CUSTOMFUNCTION_GUIINIT FP_GuiInit
!endif
Function FP_GuiInit
  !insertmacro FP_DARKEN_HEADER
FunctionEnd

; electron-builder compiles the installer and the uninstaller in two
; separate passes and defines BUILD_UNINSTALLER only for the second.
; Uninstaller code left visible to the installer pass produces NSIS
; warning 6020 - "uninstaller script code found but WriteUninstaller
; never used" - which electron-builder treats as an error.
!ifdef BUILD_UNINSTALLER
  !ifndef MUI_CUSTOMFUNCTION_UNGUIINIT
    !define MUI_CUSTOMFUNCTION_UNGUIINIT un.FP_GuiInit
  !endif
  Function un.FP_GuiInit
    !insertmacro FP_DARKEN_HEADER
  FunctionEnd
!endif
