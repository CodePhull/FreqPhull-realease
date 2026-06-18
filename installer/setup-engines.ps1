# Freq.Phull -- Engines Setup
# Installs the Freq.Phull engine runtime stack and pre-downloads
# all model weights so the user never sees a "downloading model..." wait at runtime.
#
# Emits one JSON line per status update on stdout for the Electron app to parse.
# Errors are logged to %TEMP%\freqphull-setup.log AND emitted as JSON.

$ErrorActionPreference = "Continue"
$logFile = "$env:TEMP\freqphull-setup.log"

# Reset log file each run so users don't see ancient errors
if (Test-Path $logFile) { Remove-Item $logFile -Force -ErrorAction SilentlyContinue }

# ============================================================================
# Helpers
# ============================================================================

function Log($msg) {
    try {
        $ts = Get-Date -Format "HH:mm:ss"
        Add-Content -Path $logFile -Value "$ts  $msg" -Encoding utf8 -ErrorAction SilentlyContinue
    } catch {}
}

function Emit($obj) {
    try {
        $json = $obj | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
        Log "EMIT: $json"
    } catch {
        Log "Emit failed: $_"
    }
}

function EmitStatus($step, $progress, $msg, $detail = "") {
    Emit @{ type = "status"; step = $step; progress = $progress; message = $msg; detail = $detail }
}

function EmitError($message, $hint = "") {
    Emit @{ type = "error"; message = $message; hint = $hint }
    Log "FATAL: $message"
    exit 1
}

function EmitDone() {
    Emit @{ type = "done"; progress = 100 }
    Log "Setup complete."
}

Log "=== Freq.Phull Engines Setup ==="
Log "PSVersion: $($PSVersionTable.PSVersion)"
Log "OS: $([System.Environment]::OSVersion.VersionString)"

# Wrap everything in a try block so any unexpected error becomes a clean JSON message
try {

# ============================================================================
# Step 0: Pre-flight environment checks
# ============================================================================
# These run BEFORE anything that takes time so we fail fast with actionable
# messages instead of crashing 10 minutes into a pip install. Every one of
# these was added in response to a specific class of "setup failed mid-way"
# report from users on fresh machines.
EmitStatus "preflight" 1 "Checking system requirements..."

# OS version: PyTorch 2.x wheels need Windows 10+. Windows 7/8 will silently
# fail at C extension load time with cryptic errors. Refuse upfront.
try {
    $osVer = [System.Environment]::OSVersion.Version
    if ($osVer.Major -lt 10) {
        EmitError "Windows 10 or newer is required (detected Windows $($osVer.Major).$($osVer.Minor))" "Upgrade Windows, or run Freq.Phull on a different machine."
    }
    Log "OS check passed: Windows $($osVer.Major).$($osVer.Minor) build $($osVer.Build)"
} catch {
    Log "OS version check threw (continuing): $_"
}

# 64-bit check: torch only ships 64-bit Windows wheels. 32-bit hosts (rare
# but they exist on old netbooks) cannot install torch and will burn 20
# minutes downloading wheels before failing.
try {
    if (-not [System.Environment]::Is64BitOperatingSystem) {
        EmitError "A 64-bit version of Windows is required" "PyTorch only ships 64-bit Windows packages."
    }
    Log "Architecture check passed: 64-bit OS"
} catch {
    Log "Arch check threw (continuing): $_"
}

# Disk space check: torch (~250MB), models (~970MB), pip cache (~200MB) +
# headroom = need ~1.5GB free on the user profile drive. Anything less and
# pip will crash partway through, often without a clear error.
try {
    $userDrive = (Get-Item $env:USERPROFILE).PSDrive.Name
    $drive = Get-PSDrive -Name $userDrive -ErrorAction Stop
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    Log "Disk space on ${userDrive}: $freeGB GB free"
    if ($drive.Free -lt 1.5GB) {
        EmitError "Not enough free disk space (need 1.5 GB, have $freeGB GB on ${userDrive}:)" "Free up space and re-run setup."
    }
} catch {
    Log "Disk check threw (continuing): $($_.Exception.Message)"
}

# AppData writable check: Some heavily-locked-down corporate machines have
# %APPDATA% on a read-only redirect. Setup writes the engines-ready marker
# there, so test now instead of crashing at the end.
try {
    $appDataDir = Join-Path $env:APPDATA "freqphull"
    if (-not (Test-Path $appDataDir)) {
        New-Item -ItemType Directory -Path $appDataDir -Force | Out-Null
    }
    $probeFile = Join-Path $appDataDir ".write-probe"
    "ok" | Set-Content -Path $probeFile -Encoding ASCII -ErrorAction Stop
    Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    Log "AppData write check passed"
} catch {
    EmitError "Cannot write to %APPDATA%\freqphull (read-only?)" "Check folder permissions or your IT policy. Path: $env:APPDATA\freqphull"
}

# Cache directory writable check: ~/.cache/freqphull-models stores ~1 GB of
# downloaded weights. If this is locked we'd fail mid-download.
try {
    $cacheRoot = Join-Path $env:USERPROFILE ".cache"
    if (-not (Test-Path $cacheRoot)) {
        New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    }
    $probeFile = Join-Path $cacheRoot ".freqphull-write-probe"
    "ok" | Set-Content -Path $probeFile -Encoding ASCII -ErrorAction Stop
    Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    Log "Cache dir write check passed"
} catch {
    EmitError "Cannot write to $env:USERPROFILE\.cache" "Check folder permissions; this is where AI models cache."
}

# Network reachability check: hit python.org + pytorch.org so we catch
# offline / firewall / corporate-proxy situations before we try to download
# 250 MB of wheels.
EmitStatus "preflight_network" 2 "Testing network..."
$netOk = $false
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $req = [System.Net.WebRequest]::Create("https://www.python.org/")
    $req.Timeout = 8000
    $req.Method = "HEAD"
    $resp = $req.GetResponse()
    $resp.Close()
    $netOk = $true
    Log "Network reachable: python.org responded"
} catch {
    Log "python.org HEAD failed: $($_.Exception.Message)"
}
if (-not $netOk) {
    # Try pytorch as fallback - some networks block python.org but allow CDN
    try {
        $req = [System.Net.WebRequest]::Create("https://download.pytorch.org/")
        $req.Timeout = 8000
        $req.Method = "HEAD"
        $resp = $req.GetResponse()
        $resp.Close()
        $netOk = $true
        Log "Network reachable via pytorch.org fallback"
    } catch {
        Log "pytorch.org HEAD also failed: $($_.Exception.Message)"
    }
}
if (-not $netOk) {
    EmitError "Cannot reach the internet (python.org and pytorch.org both unreachable)" "Check internet/VPN/firewall. Corporate proxies often need configuration to allow pip downloads."
}

# Windows Defender / antivirus hint: PowerShell can't disable AV but real-time
# scanning on the user profile drive can make pip installs 5-10x slower or
# trigger false positives on torch's native binaries. Log a hint to the file
# so support can recommend an exclusion if setup times out.
Log "HINT: If setup is slow or fails, add C:\Users\$env:USERNAME\AppData\Local\Programs\Python and ~\.cache to Windows Defender exclusions."

# ============================================================================
# Step 1: Find or install a COMPATIBLE Python (3.9 - 3.12)
# ============================================================================
# Why constrained: the runtime stack only ships pre-built wheels for
# Python 3.9-3.12 right now (as of mid-2026). Python 3.13/3.14 will pip-install
# but the installs are broken in subtle ways - imports succeed but tensor ops
# fail at runtime. Hard requirement: pick a version with real wheel coverage.
EmitStatus "checking_python" 3 "Checking for Python..."

# Returns 0 if version compatible, 1 if too old, 2 if too new, -1 if unparseable
# ================================================================
# Robust download with retries + integrity check (v0.2.5)
# ================================================================
# Wraps Invoke-WebRequest with: TLS 1.2, silent progress, configurable
# retries with exponential backoff, minimum-size sanity check, and
# multi-mirror fallback. Returns $true on success, $false on exhaustion.
# Used by every download in this script so transient network blips,
# CDN hiccups, and slow connections never crash the whole setup.
function Invoke-RobustDownload {
    param(
        [string[]] $Urls,            # one or more mirrors, tried in order
        [string]   $OutFile,
        [int]      $MinSize = 1000000,
        [int]      $Retries = 4,
        [int]      $TimeoutSec = 300,
        [string]   $StepLabel = "download"
    )
    if (Test-Path $OutFile) {
        $sz = (Get-Item $OutFile).Length
        if ($sz -ge $MinSize) {
            Log "$StepLabel : output already exists with valid size ($sz bytes) - reusing"
            return $true
        } else {
            Log "$StepLabel : found partial file ($sz bytes), removing"
            try { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        foreach ($url in $Urls) {
            for ($attempt = 1; $attempt -le $Retries; $attempt++) {
                Log "$StepLabel : attempt $attempt/$Retries from $url"
                try {
                    Invoke-WebRequest -Uri $url -OutFile $OutFile -UseBasicParsing -TimeoutSec $TimeoutSec
                } catch {
                    Log "$StepLabel : attempt $attempt failed: $($_.Exception.Message)"
                    if ($attempt -lt $Retries) {
                        $backoff = [Math]::Min(30, 2 * $attempt)
                        Log "$StepLabel : backing off $backoff s before retry"
                        Start-Sleep -Seconds $backoff
                    }
                    continue
                }
                if (-not (Test-Path $OutFile)) {
                    Log "$StepLabel : file missing after download"
                    continue
                }
                $sz = (Get-Item $OutFile).Length
                if ($sz -lt $MinSize) {
                    Log "$StepLabel : downloaded file too small ($sz bytes, expected >= $MinSize) - retrying"
                    try { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue } catch {}
                    continue
                }
                Log "$StepLabel : success ($sz bytes from $url)"
                return $true
            }
            Log "$StepLabel : all $Retries attempts at $url failed - trying next mirror if any"
        }
    } finally {
        $ProgressPreference = $prevProgress
    }
    return $false
}

# ================================================================
# Try-Step: run an action that's allowed to fail without aborting
# the whole setup. Logs the failure, emits a non-fatal warning,
# and continues. Use for steps where partial setup is acceptable
# (model pre-caches, optional optimizations).
# ================================================================
function Try-Step {
    param(
        [string]   $Label,
        [scriptblock] $Action,
        [int]      $Retries = 2
    )
    for ($i = 1; $i -le $Retries; $i++) {
        try {
            & $Action
            return $true
        } catch {
            Log "$Label : attempt $i/$Retries failed: $($_.Exception.Message)"
            if ($i -lt $Retries) { Start-Sleep -Seconds (2 * $i) }
        }
    }
    Log "$Label : exhausted retries, continuing without it"
    EmitStatus "warning" 0 "$Label could not be completed - you can re-run setup later" ""
    return $false
}

function TestPythonVersion($versionStr) {
    if ($versionStr -match "Python (\d+)\.(\d+)") {
        $major = [int]$matches[1]
        $minor = [int]$matches[2]
        if ($major -ne 3) { return 1 }
        if ($minor -lt 9) { return 1 }
        if ($minor -gt 12) { return 2 }
        return 0
    }
    return -1
}

$pythonCmd = $null
$pythonVersionStr = $null
$incompatibleFound = @()  # list of (cmd, version) pairs we saw but rejected

# Probe both bare commands AND `py -3.11` style version-specific launchers
$probes = @(
    @{ cmd = "python";   args = @() },
    @{ cmd = "python3";  args = @() },
    @{ cmd = "py";       args = @() },
    @{ cmd = "py";       args = @("-3.12") },
    @{ cmd = "py";       args = @("-3.11") },
    @{ cmd = "py";       args = @("-3.10") },
    @{ cmd = "py";       args = @("-3.9") }
)

foreach ($p in $probes) {
    try {
        $checkArgs = $p.args + @("--version")
        $v = & $p.cmd $checkArgs 2>&1
        if ($v -is [System.Management.Automation.ErrorRecord]) { continue }
        $vStr = "$v".Trim()
        $compat = TestPythonVersion $vStr
        $cmdFull = if ($p.args.Count -gt 0) { "$($p.cmd) $($p.args -join ' ')" } else { $p.cmd }
        Log "Probed '$cmdFull' -> $vStr (compat=$compat)"

        if ($compat -eq 0) {
            $pythonCmd = $p.cmd
            if ($p.args.Count -gt 0) {
                # `py -3.11` launcher pattern - record the args too
                $script:pythonExtraArgs = $p.args
            }
            $pythonVersionStr = $vStr
            EmitStatus "python_found" 5 "Python detected" $vStr
            break
        } elseif ($compat -eq 1 -or $compat -eq 2) {
            $incompatibleFound += "$cmdFull -> $vStr"
        }
    } catch {
        Log "Probe failed for '$($p.cmd)': $_"
    }
}

# If no compatible Python found, install Python 3.11 ourselves
if (-not $pythonCmd) {
    if ($incompatibleFound.Count -gt 0) {
        Log "Found incompatible Python(s): $($incompatibleFound -join '; ')"
        EmitStatus "python_incompatible" 6 "Existing Python is too new/old. Installing Python 3.11..." "Adding 3.11 alongside; your other Python stays installed."
    } else {
        EmitStatus "downloading_python" 6 "Downloading Python 3.11..." "~30MB"
    }

    $pyInstaller = Join-Path $env:TEMP "python-installer.exe"
    $pyUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"

    # Robust download: 4 retries with exponential backoff, ~25MB
    # minimum-size check (the installer is ~30MB; anything tiny is a
    # redirect page or proxy intercept).
    $pyOk = Invoke-RobustDownload `
        -Urls @($pyUrl) `
        -OutFile $pyInstaller `
        -MinSize 25000000 `
        -Retries 4 `
        -TimeoutSec 600 `
        -StepLabel "python_installer"
    if (-not $pyOk) {
        EmitError "Could not download Python installer after 4 retries" "Check your internet connection and firewall, then retry the setup. The error log is at $logFile."
    } else {
        Log "Python installer downloaded successfully"
    }

    EmitStatus "installing_python" 12 "Installing Python 3.11 (silent)..."
    try {
        # Args explained:
        #   /quiet                       - no UI
        #   InstallAllUsers=0            - per-user install (no admin needed)
        #   InstallLauncherAllUsers=0    - the launcher (py.exe) also goes per-user;
        #                                  this is critical because the default is 1,
        #                                  which conflicts with InstallAllUsers=0 and
        #                                  causes exit code 5 on non-admin runs.
        #                                  This was the bug reported by users on Win11
        #                                  with the bundled installer.
        #   PrependPath=0                - don't touch user's PATH; we launch via py -3.11
        #   Include_pip=1                - we need pip
        #   Include_tcltk=0, Include_test=0 - trim install size; we don't use these
        #   Include_launcher=1           - we want py.exe so we can pick the version
        #   SimpleInstall=1              - skip the optional features picker
        $proc = Start-Process -FilePath $pyInstaller -ArgumentList @(
            "/quiet",
            "InstallAllUsers=0",
            "InstallLauncherAllUsers=0",
            "PrependPath=0",
            "Include_pip=1",
            "Include_tcltk=0",
            "Include_test=0",
            "Include_launcher=1",
            "SimpleInstall=1"
        ) -Wait -PassThru -ErrorAction Stop

        # Python installer exit codes worth handling specifically:
        #   0     = success
        #   1602  = user cancelled
        #   1603  = generic fatal error during install
        #   3010  = success but reboot required
        # Anything else = our problem. We treat 3010 as success (very common).
        if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 3010) {
            Log "Python 3.11 installed (exit $($proc.ExitCode))"
        } elseif ($proc.ExitCode -eq 1602) {
            EmitError "Python install was cancelled" "Re-run the setup."
        } else {
            # Provide a more useful hint based on common exit codes
            $hint = switch ($proc.ExitCode) {
                5    { "Permission denied. Try closing Freq.Phull and reopening it as Administrator, OR install Python 3.11 manually from python.org and skip this step." }
                1603 { "Python installer crashed. Check %TEMP%/Python*.log for details, or install Python 3.11 manually from python.org." }
                default { "Try running Freq.Phull as Administrator, or install Python 3.11 manually from python.org." }
            }
            EmitError "Python installer exit code: $($proc.ExitCode)" $hint
        }
    } catch {
        EmitError "Python install failed: $($_.Exception.Message)" "Try running as Administrator."
    }

    Remove-Item $pyInstaller -Force -ErrorAction SilentlyContinue

    # Refresh PATH for this session so we can find py.exe
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","User") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","Machine")

    # The Windows Python launcher (`py -3.11`) is the most reliable way to
    # invoke a specific Python version side-by-side with others. Try that first.
    foreach ($p in @(
        @{ cmd = "py"; args = @("-3.11") },
        @{ cmd = "python"; args = @() },
        @{ cmd = "python3"; args = @() }
    )) {
        try {
            $checkArgs = $p.args + @("--version")
            $v = & $p.cmd $checkArgs 2>&1
            if ($v -is [System.Management.Automation.ErrorRecord]) { continue }
            $vStr = "$v".Trim()
            if ((TestPythonVersion $vStr) -eq 0) {
                $pythonCmd = $p.cmd
                if ($p.args.Count -gt 0) { $script:pythonExtraArgs = $p.args }
                $pythonVersionStr = $vStr
                Log "Post-install: using $($p.cmd) $($p.args -join ' ') -> $vStr"
                break
            }
        } catch {}
    }

    # HARD-PATH FALLBACK: if neither `py -3.11` nor `python` resolved, the
    # launcher install probably failed (seen on some Win11 builds where the
    # py.exe ALLUSERS bit is set wrong). Scan known per-user Python 3.11
    # install locations directly and use the exe full-path.
    if (-not $pythonCmd) {
        $hardPaths = @(
            (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
            (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
            (Join-Path $env:LOCALAPPDATA "Programs\Python\Python310\python.exe"),
            "C:\Program Files\Python311\python.exe",
            "C:\Program Files\Python312\python.exe",
            "C:\Python311\python.exe"
        )
        foreach ($hp in $hardPaths) {
            if (Test-Path $hp) {
                try {
                    $v = & $hp --version 2>&1
                    $vStr = "$v".Trim()
                    if ((TestPythonVersion $vStr) -eq 0) {
                        $pythonCmd = $hp
                        $script:pythonExtraArgs = @()
                        $pythonVersionStr = $vStr
                        Log "Hard-path fallback: using $hp -> $vStr"
                        break
                    }
                } catch {
                    Log "Hard-path probe failed for $hp : $_"
                }
            }
        }
    }

    if (-not $pythonCmd) {
        EmitError "Compatible Python not found after install (3.9-3.12 required)" "Restart the app and retry. If the problem persists, install Python 3.11 manually from python.org and make sure to check 'Add Python to PATH' during install."
    }
}

if (-not $script:pythonExtraArgs) { $script:pythonExtraArgs = @() }
Log "Using python: $pythonCmd $($script:pythonExtraArgs -join ' ') ($pythonVersionStr)"

# Helper to invoke the chosen Python with its launcher args
function Invoke-Py {
    param([Parameter(ValueFromRemainingArguments=$true)]$rest)
    $allArgs = $script:pythonExtraArgs + $rest
    & $pythonCmd $allArgs
}

# ============================================================================
# Step 2: Upgrade pip
# ============================================================================
EmitStatus "upgrading_pip" 18 "Updating pip..."
try {
    Invoke-Py -m pip install --upgrade pip --quiet 2>&1 | ForEach-Object { Log "[pip] $_" }
} catch {
    Log "pip upgrade failed (non-fatal): $_"
}

# ============================================================================
# Visual C++ Redistributable preflight check
# ============================================================================
# PyTorch's CPU wheels are compiled against MSVC and dynamically link against
# the Visual C++ 2015-2022 Redistributable. Without it, torch_cpu.dll and
# c10.dll exist on disk but can't load (WinError 127 - "specified procedure
# not found"). Detecting this before the 250MB pytorch download saves the
# user ~5 minutes of retries.
#
# The runtime is installed as MSVCP140.dll + VCRUNTIME140.dll + others into
# System32. We check the registry key the installer creates, which is the
# canonical way to detect the redist independent of file presence.
EmitStatus "checking_vcredist" 20 "Checking Visual C++ runtime..."
$vcRedistFound = $false
$vcRedistVersion = $null
try {
    # The 14.x line covers VC++ 2015, 2017, 2019, and 2022 (all binary-compatible).
    $vcKey = "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
    if (Test-Path $vcKey) {
        $vcProp = Get-ItemProperty -Path $vcKey -ErrorAction Stop
        if ($vcProp.Installed -eq 1) {
            $vcRedistFound = $true
            $vcRedistVersion = "$($vcProp.Major).$($vcProp.Minor).$($vcProp.Bld)"
            Log "VC++ Redistributable detected: $vcRedistVersion"
        }
    }
    # Older registry location used by some VC++ 2017 versions.
    if (-not $vcRedistFound) {
        $vcKeyAlt = "HKLM:\SOFTWARE\Wow6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
        if (Test-Path $vcKeyAlt) {
            $vcProp = Get-ItemProperty -Path $vcKeyAlt -ErrorAction Stop
            if ($vcProp.Installed -eq 1) {
                $vcRedistFound = $true
                $vcRedistVersion = "$($vcProp.Major).$($vcProp.Minor).$($vcProp.Bld) (alt key)"
                Log "VC++ Redistributable detected via alt key: $vcRedistVersion"
            }
        }
    }
} catch {
    Log "VC++ Redist check threw: $($_.Exception.Message)"
}

if (-not $vcRedistFound) {
    # Auto-install path. The VC++ Redistributable is freely redistributable
    # from Microsoft (no license restrictions on download or silent install)
    # so we can fetch + run it ourselves instead of telling the user to do it.
    #
    # Sequence:
    #   1. Check if we have admin rights. The redist writes to System32 so
    #      a non-elevated install will fail with exit 1638 or similar.
    #   2. Download vc_redist.x64.exe from Microsoft's permanent CDN URL.
    #      `https://aka.ms/vs/17/release/vc_redist.x64.exe` is the official
    #      direct link - they've kept it stable for years across VC++ 2015
    #      through 2022.
    #   3. Run with /install /quiet /norestart. Quiet = no UI. Norestart =
    #      defer any required reboot (we never need to reboot for PyTorch
    #      to load - it picks up new DLLs immediately).
    #   4. Re-check the registry to confirm install took.
    #
    # If any step fails, we fall back to the manual instructions message
    # so the user still has a path forward.
    Log "Visual C++ 2015-2022 Redistributable not detected - attempting auto-install"
    EmitStatus "installing_vcredist" 20 "Installing Visual C++ runtime..." "~14MB download from Microsoft"

    $vcInstalledOk = $false
    $vcInstallStage = "init"
    try {
        # == Admin check ==================================================
        # If the user launched the engine setup from a non-elevated app
        # (which is the default), the redist install will fail. We can't
        # transparently elevate without a UAC prompt, so we detect non-admin
        # and fall back gracefully instead of attempting a doomed install.
        $vcInstallStage = "admin_check"
        $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
        $isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
        Log "Admin check: isAdmin=$isAdmin"

        # == Download =====================================================
        # Path under %TEMP% so it gets cleaned up by Windows / our own
        # sweeper eventually. ~14MB so the download is quick on most
        # connections (10-30 seconds).
        $vcInstallStage = "download"
        $vcUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
        $vcExe = Join-Path $env:TEMP "freqphull_vc_redist_x64.exe"
        Log "Downloading VC++ Redist from $vcUrl to $vcExe"
        # Force TLS 1.2 - some default PowerShell configs use SSL3/TLS1.0
        # which Microsoft's CDN now rejects.
        # Robust download with retries. Real redist is ~14MB; minimum-size
        # threshold catches redirect pages and proxy intercepts.
        $vcOk = Invoke-RobustDownload `
            -Urls @($vcUrl) `
            -OutFile $vcExe `
            -MinSize 5000000 `
            -Retries 4 `
            -TimeoutSec 300 `
            -StepLabel "vc_redist"
        if (-not $vcOk) {
            throw "VC++ Redist download failed after 4 retries"
        }
        $dlSize = (Get-Item $vcExe).Length
        Log "VC++ Redist download complete: $dlSize bytes"


        # == Install ======================================================
        # /install /quiet /norestart are the documented silent-mode flags.
        # The installer's exit codes:
        #   0    = success
        #   1638 = already installed (newer version present) - treat as OK
        #   3010 = success but reboot required (we accept; PyTorch doesn't
        #          need the reboot for DLLs to be picked up)
        #   1602 = user cancelled (UAC declined) -> fall through to manual
        #   1603 = generic fatal - fall through to manual
        $vcInstallStage = "install"
        Log "Running vc_redist.x64.exe /install /quiet /norestart"
        $proc = Start-Process -FilePath $vcExe -ArgumentList "/install","/quiet","/norestart" -Wait -PassThru -ErrorAction Stop
        $exitCode = $proc.ExitCode
        Log "vc_redist.x64.exe exited with code $exitCode"
        switch ($exitCode) {
            0    { $vcInstalledOk = $true; Log "VC++ Redist install succeeded" }
            1638 { $vcInstalledOk = $true; Log "VC++ Redist: newer version already installed (exit 1638)" }
            3010 { $vcInstalledOk = $true; Log "VC++ Redist install succeeded (reboot pending, but not required for PyTorch)" }
            1602 { Log "VC++ Redist install cancelled by user (exit 1602 - UAC declined?)" }
            1603 { Log "VC++ Redist install failed with generic fatal error (exit 1603)" }
            default { Log "VC++ Redist install exited with $exitCode (unknown - treating as failure)" }
        }

        # == Re-check the registry to be sure =============================
        # The exit code is a strong signal but not absolute proof. The
        # registry check is what actually matters for downstream PyTorch.
        if ($vcInstalledOk) {
            $vcInstallStage = "verify"
            try {
                $vcProp = Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" -ErrorAction Stop
                if ($vcProp.Installed -eq 1) {
                    $vcRedistFound = $true
                    $vcRedistVersion = "$($vcProp.Major).$($vcProp.Minor).$($vcProp.Bld)"
                    Log "Post-install verify: VC++ Redist now present at $vcRedistVersion"
                    EmitStatus "vcredist_installed" 21 "Visual C++ runtime installed" "$vcRedistVersion"
                } else {
                    Log "Post-install verify: registry says Installed=$($vcProp.Installed)"
                    $vcInstalledOk = $false
                }
            } catch {
                Log "Post-install verify: registry check threw: $($_.Exception.Message)"
                $vcInstalledOk = $false
            }
        }

        # Clean up the downloaded installer regardless of outcome.
        # The sweeper would catch it eventually but cleanup-on-success is
        # cleaner for the disk.
        try { Remove-Item $vcExe -Force -ErrorAction SilentlyContinue } catch {}
    } catch {
        Log "VC++ Redist auto-install failed at stage '$vcInstallStage': $($_.Exception.Message)"
    }

    if (-not $vcInstalledOk) {
        # Auto-install didn't work. Fall back to the warning + manual link
        # so the user still knows what to do. Don't fail setup outright -
        # PyTorch might still load if a partial install or a different
        # Visual Studio is providing the DLLs.
        if (-not $isAdmin) {
            Log "WARN: Auto-install likely failed because setup is not running with admin privileges"
            EmitStatus "vcredist_needs_admin" 21 "Couldn't auto-install VC++ runtime (admin required)" "If PyTorch fails: install https://aka.ms/vs/17/release/vc_redist.x64.exe manually and retry"
        } else {
            EmitStatus "vcredist_install_failed" 21 "Auto-install of VC++ runtime failed - proceeding anyway" "If PyTorch fails: install https://aka.ms/vs/17/release/vc_redist.x64.exe manually and retry"
        }
    }
} else {
    EmitStatus "vcredist_ok" 21 "Visual C++ runtime OK" "$vcRedistVersion"
}

# ============================================================================
# Step 3: Install PyTorch + torchaudio (CPU)
# ============================================================================
# We install torch and torchaudio TOGETHER from the same PyTorch index. They
# need matching versions and the engine package depends on torchaudio for I/O.
# Installing them separately invites version drift.
EmitStatus "installing_pytorch" 22 "Installing PyTorch + torchaudio..." "~250MB - this is the heaviest step"

# Two-stage validation: torch importable AND torchaudio importable AND a real
# tensor op succeeds. Catches partial installs where metadata is fine but
# native libs are broken.
$torchInstalled = $false
try {
    $check = Invoke-Py -c "import torch, torchaudio; t=torch.tensor([1.0]); print('OK', torch.__version__, torchaudio.__version__)" 2>&1
    if ("$check" -match "^OK ") {
        $torchInstalled = $true
        Log "PyTorch + torchaudio already installed: $check"
        EmitStatus "pytorch_cached" 35 "PyTorch + torchaudio already installed" "$check"
    } else {
        Log "PyTorch validation failed (will reinstall): $check"
    }
} catch {
    Log "PyTorch import threw: $_"
}

if (-not $torchInstalled) {
    # Retry the heavy download on transient failures (ConnectionResetError,
    # ReadTimeoutError, partial wheels). 3 attempts gives ~99% success rate
    # on flaky residential WiFi. The retry is cheap when it works the first
    # time (the loop exits immediately) and ~5 minutes amortized when it
    # doesn't.
    #
    # SPECIAL CASE: WinError 127 ("the specified procedure could not be
    # found") is NOT a network problem - it's a DLL dependency mismatch.
    # The torchaudio .pyd loaded but couldn't find a function in c10.dll
    # or torch_cpu.dll. Two known causes:
    #   1. Missing/old Visual C++ 2015-2022 Redistributable
    #   2. Stale broken install from a previous attempt that pip won't
    #      replace because it thinks the package is already there
    # Plain retry won't fix either, so when we see WinError 127 we
    # force-uninstall + purge the pip cache before the next attempt.
    $maxAttempts = 3
    $attempt = 0
    $succeeded = $false
    $sawWinError127 = $false
    while ($attempt -lt $maxAttempts -and -not $succeeded) {
        $attempt++
        try {
            if ($attempt -gt 1) {
                EmitStatus "installing_pytorch_retry" 22 "PyTorch install retry $attempt of $maxAttempts..." "Previous attempt failed; retrying"
                Start-Sleep -Seconds 5
                # If a previous attempt died with WinError 127, the existing
                # files on disk are broken and pip will skip reinstalling
                # them. Force-clean before retrying so the next install
                # writes fresh files.
                if ($sawWinError127) {
                    Log "Detected WinError 127 - uninstalling stale torch/torchaudio + purging cache before retry"
                    Invoke-Py -m pip uninstall -y torch torchaudio torchvision 2>&1 | ForEach-Object { Log "[uninstall] $_" }
                    Invoke-Py -m pip cache purge 2>&1 | ForEach-Object { Log "[cache] $_" }
                }
            }
            # Install both at once - guarantees compatible versions.
            # --retries 5 also handles within-pip transient errors.
            # --force-reinstall on attempt 2+ ensures we overwrite any
            # corrupt files left behind.
            $forceFlag = if ($attempt -gt 1) { "--force-reinstall" } else { "" }
            Invoke-Py -m pip install torch torchaudio $forceFlag --index-url https://download.pytorch.org/whl/cpu --retries 5 --timeout 120 --quiet 2>&1 | ForEach-Object { Log "[torch] $_" }
            if ($LASTEXITCODE -eq 0) {
                # Re-verify post-install - the pip install can return 0 but
                # leave a broken install if a wheel was corrupted in transit
                # or if a DLL dependency is missing system-wide.
                $reverify = Invoke-Py -c "import torch, torchaudio; t=torch.tensor([1.0]); print('OK', torch.__version__, torchaudio.__version__)" 2>&1
                if ("$reverify" -match "^OK ") {
                    $succeeded = $true
                    EmitStatus "pytorch_installed" 35 "PyTorch + torchaudio installed" "$reverify"
                    break
                }
                Log "Pytorch install attempt ${attempt}: verify failed: $reverify"
                # WinError 127 detection: the message comes through as
                # "[WinError 127]" in the captured output regardless of
                # the user's system locale (the number is always English
                # even when the description is localized e.g. French
                # "La proc?dure sp?cifi?e est introuvable").
                if ("$reverify" -match "WinError 127" -or "$reverify" -match "specified procedure could not be found" -or "$reverify" -match "proc.dure sp.cifi.e est introuvable") {
                    $sawWinError127 = $true
                    Log "WinError 127 detected - will force-uninstall before next retry"
                }
            } else {
                Log "Pytorch install attempt ${attempt}: pip exit $LASTEXITCODE"
            }
        } catch {
            Log "Pytorch install attempt ${attempt} threw: $($_.Exception.Message)"
        }
    }
    if (-not $succeeded) {
        # Pick the right error message based on what we actually saw.
        # WinError 127 = DLL issue -> point at VC++ Redistributable.
        # Otherwise -> generic network/AV message.
        if ($sawWinError127) {
            EmitError "PyTorch can't load its native libraries (WinError 127)" "This usually means the Visual C++ 2015-2022 Redistributable (x64) is missing or outdated. Download and install it from: https://aka.ms/vs/17/release/vc_redist.x64.exe - then re-run Freq.Phull's setup. If it still fails after installing VC++ Redist, check %TEMP%\freqphull-setup.log and consider adding C:\Users\$($env:USERNAME)\AppData\Local\Programs\Python and ~\.cache to your antivirus exclusions."
        } else {
            EmitError "PyTorch install failed after $maxAttempts attempts" "Check %TEMP%\freqphull-setup.log for details. Common causes: flaky network, full disk, antivirus blocking python.exe, or missing Visual C++ Redistributable (https://aka.ms/vs/17/release/vc_redist.x64.exe)."
        }
    }
}

# ============================================================================
# Step 4: Install separation engine
# ============================================================================
EmitStatus "installing_separator" 40 "Installing separation engine..." "~30MB"

# Two-stage validation: import works AND the Separator class is loadable
$sepInstalled = $false
try {
    $check = Invoke-Py -c "from audio_separator.separator import Separator; print('OK')" 2>&1
    if ("$check" -match "^OK") {
        $sepInstalled = $true
        Log "Separation engine validated"
        EmitStatus "separator_cached" 50 "Separation engine already installed"
    } else {
        Log "Engine validation failed, will reinstall: $check"
    }
} catch {
    Log "Engine import threw: $_"
}

if (-not $sepInstalled) {
    try {
        Invoke-Py -m pip install "audio-separator[cpu]" --quiet 2>&1 | ForEach-Object { Log "[audio-sep] $_" }
        if ($LASTEXITCODE -ne 0) {
            EmitError "Separation engine install failed (pip exit $LASTEXITCODE)" "See log for details."
        }
        # Re-verify post-install
        $reverify = Invoke-Py -c "from audio_separator.separator import Separator; print('OK')" 2>&1
        if ("$reverify" -match "^OK") {
            EmitStatus "separator_installed" 50 "Separation engine installed"
        } else {
            EmitError "Engine installed but failed to load: $reverify" ""
        }
    } catch {
        EmitError "Engine install threw: $($_.Exception.Message)" ""
    }
}

# ============================================================================
# Step 5: Install openai-whisper
# ============================================================================
EmitStatus "installing_whisper" 54 "Installing transcription engine..."

# Validate that whisper is importable AND the load_model function exists
$whisperInstalled = $false
try {
    $check = Invoke-Py -c "import whisper; assert hasattr(whisper, 'load_model'); print('OK')" 2>&1
    if ("$check" -match "^OK") {
        $whisperInstalled = $true
        Log "Transcription engine validated"
        EmitStatus "whisper_cached" 60 "Transcription engine already installed"
    } else {
        Log "Whisper validation failed (will reinstall): $check"
    }
} catch {
    Log "Whisper import threw: $_"
}

if (-not $whisperInstalled) {
    try {
        Invoke-Py -m pip install openai-whisper --quiet 2>&1 | ForEach-Object { Log "[whisper] $_" }
        if ($LASTEXITCODE -ne 0) {
            EmitError "Whisper install failed (pip exit $LASTEXITCODE)" "See log for details."
        }
        EmitStatus "whisper_installed" 60 "Whisper installed"
    } catch {
        EmitError "Whisper install threw: $($_.Exception.Message)" ""
    }
}

# ============================================================================
# Step 6: Pre-download model weights
# ============================================================================
EmitStatus "downloading_models" 65 "Pre-downloading AI models..." "~970MB total, runs once"

# Single-quoted here-string -- PowerShell does NO variable expansion, so the Python
# code below is passed through verbatim. This avoids any $var collisions.
$preloadScript = @'
import sys, os, time, json

def emit(step, progress, message=""):
    sys.stdout.write("::progress::" + step + "::" + str(progress) + "::" + message + "\n")
    sys.stdout.flush()

def warn(msg):
    sys.stdout.write("::warn::" + msg + "\n")
    sys.stdout.flush()

sep_cache = os.path.join(os.path.expanduser("~"), ".cache", "freqphull-models")
os.makedirs(sep_cache, exist_ok=True)

# ---- Stage 1 model: vocal isolation (~640MB) ----
try:
    from audio_separator.separator import Separator
    emit("dl_vocal", 65, "Downloading Stage 1 model (~640MB)...")
    sep = Separator(model_file_dir=sep_cache, log_level=30)
    try:
        sep.download_model_files("model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    except AttributeError:
        sep.load_model(model_filename="model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    emit("dl_vocal_done", 78, "Stage 1 model ready")
except Exception as e:
    warn("Stage 1 model download failed: " + str(e))
    emit("dl_vocal_skip", 78, "Will retry on first separation")

# ---- Stage 2 model: instrumental decomposition (~330MB) ----
try:
    from audio_separator.separator import Separator
    emit("dl_demucs", 80, "Downloading Stage 2 model (~330MB)...")
    sep = Separator(model_file_dir=sep_cache, log_level=30)
    try:
        sep.download_model_files("htdemucs_ft.yaml")
    except AttributeError:
        sep.load_model(model_filename="htdemucs_ft.yaml")
    emit("dl_demucs_done", 92, "Stage 2 model ready")
except Exception as e:
    warn("Stage 2 model download failed: " + str(e))
    emit("dl_demucs_skip", 92, "Will retry on first separation")

# ---- Whisper base (~150MB) ----
try:
    emit("dl_whisper", 94, "Downloading transcription model (~150MB)...")
    import whisper, socket
    cache_dir = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
    os.makedirs(cache_dir, exist_ok=True)
    model_file = os.path.join(cache_dir, "base.pt")
    if os.path.exists(model_file) and os.path.getsize(model_file) > 100 * 1024 * 1024:
        emit("dl_whisper_done", 99, "Whisper already cached")
    else:
        socket.setdefaulttimeout(60)
        whisper.load_model("base")
        emit("dl_whisper_done", 99, "Whisper ready")
except Exception as e:
    warn("Whisper model download failed: " + str(e))
    emit("dl_whisper_skip", 99, "Will retry on first transcription")

emit("all_models_done", 99, "All models ready")
'@

$tmpScript = Join-Path $env:TEMP "freqphull-preload-models.py"
# Write the Python file as plain ASCII to avoid any encoding surprises
Set-Content -Path $tmpScript -Value $preloadScript -Encoding ASCII

# Stream Python output line-by-line via the pipeline so we get progress in real time
# (Start-Process + RedirectStandardOutput is brittle when reading a file mid-write)
try {
    # Pipe stderr to stdout so warnings show up in the log
    Invoke-Py $tmpScript 2>&1 | ForEach-Object {
        $line = "$_"
        Log "[preload] $line"
        if ($line -match '^::progress::([^:]+)::(\d+)::(.*)$') {
            $step = $matches[1]
            $prog = [int]$matches[2]
            $msg = $matches[3]
            EmitStatus $step $prog $msg
        }
        elseif ($line -match '^::warn::(.+)$') {
            Log "WARN: $($matches[1])"
        }
    }
} catch {
    Log "Model preload pipeline error (non-fatal): $($_.Exception.Message)"
}

Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue

# ============================================================================
# Step 7: Write marker file
# ============================================================================
EmitStatus "finalizing" 99 "Finalizing..."

# Resolve the FULL PATH to the Python executable that just ran the install.
# Storing only "python" in the marker is unreliable - Windows can have multiple
# Python installations and `python` at runtime might resolve to a different one
# that does not have the engine package installed.
$pythonFullPath = $null
try {
    $resolved = Invoke-Py -c "import sys; print(sys.executable)" 2>&1
    if ($resolved -and (Test-Path "$resolved".Trim())) {
        $pythonFullPath = "$resolved".Trim()
        Log "Resolved Python full path: $pythonFullPath"
    } else {
        Log "Could not resolve Python full path; got: $resolved"
    }
} catch {
    Log "Python path resolution failed: $_"
}

if (-not $pythonFullPath) {
    EmitError "Could not resolve full path to the verified Python install" "Restart the app and try setup again."
}

# Verify imports work AND torch can do real tensor work (catches partial installs
# where `import torch` succeeds but the C extensions are broken). If anything
# fails we DON'T write the marker - better to leave it un-set so the user is
# prompted to re-run setup than to have a marker pointing to a broken install.
$importsOk = $false
$importError = ""
$verifyScript = @'
import sys
try:
    import torch
    # Real tensor op - if torch's native libs are broken this throws
    t = torch.tensor([1.0, 2.0, 3.0])
    _ = (t * 2).sum().item()
    # torchaudio is required by the engine package, must be importable
    import torchaudio
    # Actually load the Separator class - not just the module - to catch
    # broken sub-imports (this is what fails at runtime if anything's wrong)
    from audio_separator.separator import Separator
    import whisper
    assert hasattr(whisper, "load_model")
    print("IMPORTS_OK", torch.__version__, torchaudio.__version__, sys.version_info[0:3])
except Exception as e:
    print("IMPORT_FAIL:", type(e).__name__, str(e))
    sys.exit(1)
'@
$verifyTmp = Join-Path $env:TEMP "freqphull-verify.py"
Set-Content -Path $verifyTmp -Value $verifyScript -Encoding ASCII

try {
    # Use the resolved FULL PATH (not the launcher) to verify the exact install
    # we'll record in the marker
    $verify = & $pythonFullPath $verifyTmp 2>&1
    if ("$verify" -match "IMPORTS_OK") {
        $importsOk = $true
        Log "Final import verification: PASS ($verify)"
    } else {
        $importError = "$verify"
        Log "Final import verification FAILED: $importError"
    }
} catch {
    $importError = $_.Exception.Message
    Log "Final import verification threw: $importError"
}

Remove-Item $verifyTmp -Force -ErrorAction SilentlyContinue

if (-not $importsOk) {
    EmitError "Setup completed but imports failed. Details: $($importError -replace '\s+',' ' | Out-String -NoNewline)" "Try setup again. If the problem persists, check %TEMP%\freqphull-setup.log."
}

$markerDir = Join-Path $env:APPDATA "freqphull"
if (-not (Test-Path $markerDir)) {
    New-Item -ItemType Directory -Path $markerDir -Force | Out-Null
}
$markerData = @{
    python = $pythonFullPath          # Full path so runtime uses the SAME install
    python_short = $pythonCmd         # Backward-compat: the short command name
    python_version = $pythonVersionStr
    imports_verified = $true
    version = "2.0"
    date = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    engines = @("audio-separator", "openai-whisper", "torch")
}
$markerJson = $markerData | ConvertTo-Json
# Write WITHOUT BOM. Out-File -Encoding utf8 emits BOM on PowerShell 5.1, which
# breaks Node's JSON.parse. Use .NET's UTF8Encoding($false) instead.
$markerFile = Join-Path $markerDir "engines-ready.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($markerFile, $markerJson, $utf8NoBom)

EmitDone

}
catch {
    # Catch-all for any unexpected error that escaped the per-step handlers
    Log "FATAL UNHANDLED: $($_.Exception.Message)"
    Log "Stack: $($_.ScriptStackTrace)"
    EmitError "Setup hit an unexpected error: $($_.Exception.Message)" "Check %TEMP%\freqphull-setup.log for details."
}
