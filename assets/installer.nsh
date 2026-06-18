; Freq.Phull - Custom NSIS branding (v0.2.8)
; oneClick mode: no wizard, just a progress dialog with the app icon.
; The few defines below tweak the small visible window during install.

; Window title that briefly appears
!define MUI_INSTALLER_TITLE "Freq.Phull"
!define MUI_PRODUCT "Freq.Phull"

; If oneClick is ever flipped off, these are the wizard texts we want
!define MUI_WELCOMEPAGE_TITLE "Welcome to Freq.Phull"
!define MUI_WELCOMEPAGE_TEXT "Tired of using 100 websites as a solo artist?$\r$\n$\r$\nIt's ok - just use Freq.Phull.$\r$\n$\r$\nDownload beats, get the BPM and key, transcribe your lyrics, and more - all in one app.$\r$\n$\r$\nClick Install to continue."

!define MUI_FINISHPAGE_TITLE "Freq.Phull is ready"
!define MUI_FINISHPAGE_TEXT "Your artist toolkit is installed.$\r$\n$\r$\nFreq.Phull will open in a moment."
!define MUI_FINISHPAGE_RUN_TEXT "Launch Freq.Phull now"
