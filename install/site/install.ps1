# Open Sourcebook installer for Windows.
#
# Paste this one line into PowerShell:
#   irm https://opensourcebook.app/install.ps1 | iex
#
# It works in Windows PowerShell 5.1 and in PowerShell 7. It never asks for
# administrator rights. Everything goes into one folder in your user folder
# (.opensourcebook). Outside that folder it only adds one entry to your own
# Path and one Start-menu entry.
#
# Settings (all optional, read from the environment):
#   OPENSOURCEBOOK_HOME                the folder to install into
#   OPENSOURCEBOOK_PACKAGE             what npx runs (default opensourcebook@latest; a path to a .tgz works)
#   OPENSOURCEBOOK_NODE_DIST           where Node is downloaded from (default https://nodejs.org/dist/latest-v24.x)
#   OPENSOURCEBOOK_ARCHIVE             passed through untouched to the package
#   OPENSOURCEBOOK_ARGS                extra words for "opensourcebook install", split on spaces
#   OPENSOURCEBOOK_FORCE_PRIVATE_NODE  1 = do not use the Node found on the Path
#   OPENSOURCEBOOK_NO_PATH             1 = do not add the command to your Path
#   OPENSOURCEBOOK_NO_SHORTCUT         1 = do not add the Start-menu entry
#
# This file is plain ASCII on purpose, and it has no param() block and no
# top-level exit, so that it can be piped into iex.

function Install-OpenSourcebook {
    Set-StrictMode -Off
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    $needNode = 24

    # Stops the install with one sentence on what went wrong and one next step.
    function Stop-Book([string]$What, [string]$Next) {
        throw ('END:' + $What + '||' + $Next)
    }

    # The first number of a Node version (24 for v24.1.0), or 0 when it cannot be run.
    function Get-BookNodeMajor([string]$Exe) {
        $ErrorActionPreference = 'Continue'
        $major = 0
        try {
            $out = & $Exe --version 2>$null
            if (($LASTEXITCODE -eq 0) -and $out) {
                $first = [string](@($out)[0])
                if ($first -match '^v(\d+)\.') {
                    $major = [int]$Matches[1]
                }
            }
        } catch {
            $major = 0
        }
        return $major
    }

    $savedPath = $null
    $pathChanged = $false

    try {
        # ---- Is this Windows, and a PowerShell new enough? ----------------
        $onWindows = $true
        if ($PSVersionTable.PSEdition -eq 'Core') {
            $isWinVar = Get-Variable -Name 'IsWindows' -ErrorAction SilentlyContinue
            if ($isWinVar -and (-not $isWinVar.Value)) {
                $onWindows = $false
            }
        }
        if (-not $onWindows) {
            Stop-Book 'This installer is for Windows.' 'On a Mac or on Linux, paste this line into Terminal instead: curl -fsSL https://opensourcebook.app/install | sh'
        }
        if ($PSVersionTable.PSVersion.Major -lt 5) {
            Stop-Book 'This PowerShell is too old for the installer.' 'Install the Windows updates that are waiting, then paste the same line again.'
        }

        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch {
            # Newer PowerShell picks a safe setting by itself.
        }

        # ---- Where everything goes -----------------------------------------
        $bookHome = $env:OPENSOURCEBOOK_HOME
        if (-not $bookHome) {
            $profileDir = $env:USERPROFILE
            if (-not $profileDir) {
                $profileDir = [Environment]::GetFolderPath('UserProfile')
            }
            if (-not $profileDir) {
                Stop-Book 'Windows did not say where your user folder is.' 'Sign out of Windows, sign in again, then paste the same line again.'
            }
            $bookHome = Join-Path $profileDir '.opensourcebook'
        }
        $binDir = Join-Path $bookHome 'bin'
        $privateNodeDir = Join-Path $bookHome 'node'

        $package = 'opensourcebook@latest'
        if ($env:OPENSOURCEBOOK_PACKAGE) {
            $package = $env:OPENSOURCEBOOK_PACKAGE
            if (Test-Path -LiteralPath $package -PathType Leaf) {
                # npx runs a bare path as a program, so a local file is named the way npm names one.
                $package = 'file:' + (Resolve-Path -LiteralPath $package).ProviderPath
            }
        }

        $extraArgs = @()
        if ($env:OPENSOURCEBOOK_ARGS) {
            $extraArgs = @($env:OPENSOURCEBOOK_ARGS -split '\s+' | Where-Object { $_ })
        }
        $willStart = -not ($extraArgs -contains '--no-start')

        # ---- Say what will happen ------------------------------------------
        Write-Host ''
        Write-Host 'Open Sourcebook installer'
        Write-Host ''
        Write-Host 'This is what it will do:'
        Write-Host '  1. Use the Node 24 already on this computer. If there is none, it puts a'
        Write-Host '     private copy inside the folder below. Your own Node is never replaced.'
        Write-Host ('  2. Download Open Sourcebook into ' + $bookHome)
        Write-Host '  3. Make "opensourcebook" a command and add Open Sourcebook to the Start menu.'
        Write-Host '  4. Start it and open it in your browser.'
        Write-Host 'Nothing else on this computer is changed, and no administrator rights are asked for.'
        Write-Host ''

        try {
            [System.IO.Directory]::CreateDirectory($bookHome) | Out-Null
        } catch {
            Stop-Book ('The folder ' + $bookHome + ' could not be made.') 'Check that your disk has free space, then paste the same line again.'
        }

        # ---- Node 24: theirs, the private copy, or a fresh private copy ----
        $nodeDir = $null

        if ($env:OPENSOURCEBOOK_FORCE_PRIVATE_NODE -ne '1') {
            $found = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found -and $found.Path) {
                $foundDir = Split-Path -Parent $found.Path
                if ($foundDir -and (Test-Path -LiteralPath (Join-Path $foundDir 'npx.cmd') -PathType Leaf)) {
                    $major = Get-BookNodeMajor $found.Path
                    if ($major -ge $needNode) {
                        $nodeDir = $foundDir
                        Write-Host ('Using the Node ' + $major + ' already on this computer.')
                    }
                }
            }
        }

        if (-not $nodeDir) {
            $privateExe = Join-Path $privateNodeDir 'node.exe'
            if ((Test-Path -LiteralPath $privateExe -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $privateNodeDir 'npx.cmd') -PathType Leaf)) {
                $major = Get-BookNodeMajor $privateExe
                if ($major -ge $needNode) {
                    $nodeDir = $privateNodeDir
                    Write-Host ('Using the private Node ' + $major + ' in ' + $privateNodeDir)
                }
            }
        }

        if (-not $nodeDir) {
            $arch = $env:PROCESSOR_ARCHITEW6432
            if (-not $arch) {
                $arch = $env:PROCESSOR_ARCHITECTURE
            }
            $arch = ([string]$arch).ToUpper()
            $nodeArch = $null
            if ($arch -eq 'AMD64') {
                $nodeArch = 'x64'
            } elseif ($arch -eq 'ARM64') {
                $nodeArch = 'arm64'
            }
            if (-not $nodeArch) {
                Stop-Book 'Open Sourcebook needs 64-bit Windows, and this computer runs 32-bit Windows.' 'Use a computer with 64-bit Windows 10 or 11.'
            }

            $dist = 'https://nodejs.org/dist/latest-v24.x'
            if ($env:OPENSOURCEBOOK_NODE_DIST) {
                $dist = $env:OPENSOURCEBOOK_NODE_DIST
            }
            $dist = $dist.TrimEnd('/')

            # A work folder inside the home. A leftover from a stopped run is cleared first.
            $work = Join-Path $bookHome 'node.new'
            try {
                if (Test-Path -LiteralPath $work) {
                    Remove-Item -LiteralPath $work -Recurse -Force
                }
                [System.IO.Directory]::CreateDirectory($work) | Out-Null
            } catch {
                Stop-Book ('The folder ' + $work + ' could not be cleared.') 'Restart the computer, then paste the same line again.'
            }

            Write-Host 'Downloading a private copy of Node 24 (about 35 MB). This can take a minute.'

            $sumsFile = Join-Path $work 'SHASUMS256.txt'
            try {
                Invoke-WebRequest -UseBasicParsing -Uri ($dist + '/SHASUMS256.txt') -OutFile $sumsFile
            } catch {
                Stop-Book ('The list of Node downloads could not be read from ' + $dist + '.') 'Check your internet connection, then paste the same line again.'
            }

            $zipName = $null
            $wantHash = $null
            $pattern = '^([0-9a-fA-F]{64})\s+\*?(node-v[0-9.]+-win-' + $nodeArch + '\.zip)\s*$'
            foreach ($line in @(Get-Content -LiteralPath $sumsFile)) {
                if (([string]$line) -match $pattern) {
                    $wantHash = $Matches[1]
                    $zipName = $Matches[2]
                    break
                }
            }
            if (-not $zipName) {
                Stop-Book ('No Node 24 download for this kind of computer (' + $nodeArch + ') was listed at ' + $dist + '.') 'Install Node 24 from https://nodejs.org and paste the same line again.'
            }

            $zipFile = Join-Path $work 'node.zip'
            try {
                Invoke-WebRequest -UseBasicParsing -Uri ($dist + '/' + $zipName) -OutFile $zipFile
            } catch {
                Stop-Book ('Node could not be downloaded from ' + $dist + '.') 'Check your internet connection, then paste the same line again.'
            }

            $gotHash = (Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash
            if (([string]$gotHash).ToLower() -ne ([string]$wantHash).ToLower()) {
                Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
                Stop-Book 'The Node download did not match its published checksum, so it was thrown away.' 'Paste the same line again to download it afresh.'
            }

            Write-Host 'Unpacking Node. This can take a minute.'
            $unpacked = Join-Path $work 'unpacked'
            try {
                Expand-Archive -LiteralPath $zipFile -DestinationPath $unpacked -Force
            } catch {
                Stop-Book 'The Node download could not be unpacked.' 'Check that your disk has free space, then paste the same line again.'
            }

            $inner = Get-ChildItem -LiteralPath $unpacked -Directory | Where-Object { $_.Name -like 'node-v*' } | Select-Object -First 1
            if ((-not $inner) -or (-not (Test-Path -LiteralPath (Join-Path $inner.FullName 'node.exe') -PathType Leaf))) {
                Stop-Book 'The Node download did not hold what was expected.' 'Paste the same line again to download it afresh.'
            }

            # Only the private folder inside the home is ever replaced.
            try {
                if (Test-Path -LiteralPath $privateNodeDir) {
                    Remove-Item -LiteralPath $privateNodeDir -Recurse -Force
                }
                Move-Item -LiteralPath $inner.FullName -Destination $privateNodeDir
            } catch {
                Stop-Book ('The private copy of Node in ' + $privateNodeDir + ' could not be replaced, most likely because Open Sourcebook is running.') 'Restart the computer, then paste the same line again.'
            }
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

            $major = Get-BookNodeMajor (Join-Path $privateNodeDir 'node.exe')
            if ($major -lt $needNode) {
                Stop-Book 'The private copy of Node does not start on this computer.' 'Install Node 24 from https://nodejs.org and paste the same line again.'
            }
            $nodeDir = $privateNodeDir
            Write-Host ('A private Node ' + $major + ' is now in ' + $privateNodeDir)
        }

        # ---- Run the Open Sourcebook installer with that Node --------------
        $npx = Join-Path $nodeDir 'npx.cmd'
        if (-not (Test-Path -LiteralPath $npx -PathType Leaf)) {
            Stop-Book ('Node in ' + $nodeDir + ' is missing its npx program.') 'Install Node 24 from https://nodejs.org and paste the same line again.'
        }

        Write-Host ''
        Write-Host 'Downloading and setting up Open Sourcebook. The first time takes a few minutes.'
        Write-Host ''

        $savedPath = $env:Path
        $pathChanged = $true
        $env:Path = $nodeDir + ';' + $savedPath

        $code = 1
        $ErrorActionPreference = 'Continue'
        try {
            & $npx --yes $package install @extraArgs
            $code = $LASTEXITCODE
        } catch {
            $code = 1
        }
        $ErrorActionPreference = 'Stop'

        $env:Path = $savedPath
        $pathChanged = $false

        if ($code -ne 0) {
            Stop-Book 'Setting up Open Sourcebook did not finish.' 'Read the last lines above for the reason, then paste the same line again.'
        }

        # ---- Make "opensourcebook" a command --------------------------------
        $cmdFile = Join-Path $binDir 'opensourcebook.cmd'
        $commandReady = $false

        if ($env:OPENSOURCEBOOK_NO_PATH -ne '1') {
            try {
                $wanted = $binDir.TrimEnd('\')

                $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
                $already = $false
                if ($userPath) {
                    foreach ($entry in @($userPath -split ';')) {
                        if ($entry -and ($entry.Trim().TrimEnd('\') -ieq $wanted)) {
                            $already = $true
                        }
                    }
                }
                if (-not $already) {
                    if ($userPath) {
                        $newUserPath = $userPath.TrimEnd(';') + ';' + $binDir
                    } else {
                        $newUserPath = $binDir
                    }
                    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
                }

                $inSession = $false
                foreach ($entry in @(([string]$env:Path) -split ';')) {
                    if ($entry -and ($entry.Trim().TrimEnd('\') -ieq $wanted)) {
                        $inSession = $true
                    }
                }
                if (-not $inSession) {
                    $env:Path = ([string]$env:Path).TrimEnd(';') + ';' + $binDir
                }
                $commandReady = $true
            } catch {
                Write-Host 'The "opensourcebook" command could not be added to your Path.' -ForegroundColor Yellow
                Write-Host ('Next step: start it from the Start menu, or run ' + $cmdFile) -ForegroundColor Yellow
            }
        }

        # ---- Start-menu entry ------------------------------------------------
        $shortcutReady = $false
        if ($env:OPENSOURCEBOOK_NO_SHORTCUT -ne '1') {
            try {
                if (-not (Test-Path -LiteralPath $cmdFile -PathType Leaf)) {
                    throw 'The file the Start-menu entry points to is missing.'
                }
                $programs = [Environment]::GetFolderPath('Programs')
                if (-not $programs) {
                    throw 'Windows did not say where the Start menu is.'
                }
                [System.IO.Directory]::CreateDirectory($programs) | Out-Null
                $linkFile = Join-Path $programs 'Open Sourcebook.lnk'
                $shell = New-Object -ComObject WScript.Shell
                $link = $shell.CreateShortcut($linkFile)
                $link.TargetPath = $cmdFile
                $link.WorkingDirectory = $bookHome
                $link.WindowStyle = 7
                $link.Description = 'Open Sourcebook'
                $link.Save()
                $shortcutReady = $true
            } catch {
                Write-Host 'Open Sourcebook could not be added to the Start menu.' -ForegroundColor Yellow
                Write-Host 'Next step: nothing is needed, you can still start it by typing opensourcebook in a new PowerShell window.' -ForegroundColor Yellow
            }
        }

        # ---- Done ------------------------------------------------------------
        Write-Host ''
        if ($willStart) {
            Write-Host 'Open Sourcebook is running.' -ForegroundColor Green
        } else {
            Write-Host 'Open Sourcebook is installed.' -ForegroundColor Green
        }
        if ($commandReady -and $shortcutReady) {
            Write-Host 'To start it again later, type opensourcebook in a new PowerShell window, or pick Open Sourcebook in the Start menu.'
        } elseif ($commandReady) {
            Write-Host 'To start it again later, type opensourcebook in a new PowerShell window.'
        } elseif ($shortcutReady) {
            Write-Host 'To start it again later, pick Open Sourcebook in the Start menu.'
        } else {
            Write-Host ('To start it again later, run ' + $cmdFile)
        }
        Write-Host ('To remove it, delete the folder ' + $bookHome)
        Write-Host ''
    } catch {
        if ($pathChanged) {
            $env:Path = $savedPath
        }
        $what = 'Something unexpected stopped the installer.'
        $next = 'Paste the same line again, and if it stops again, restart the computer first.'
        $message = ''
        if ($_ -and $_.Exception -and $_.Exception.Message) {
            $message = [string]$_.Exception.Message
        }
        if ($message.StartsWith('END:')) {
            $parts = @($message.Substring(4) -split '\|\|', 2)
            $what = $parts[0]
            if ($parts.Count -gt 1) {
                $next = $parts[1]
            }
        } elseif ($message) {
            $what = 'Something unexpected stopped the installer: ' + $message
        }
        Write-Host ''
        Write-Host $what -ForegroundColor Red
        Write-Host ('Next step: ' + $next) -ForegroundColor Red
        Write-Host ''
        throw 'Open Sourcebook was not installed.'
    }
}

$bookInstallFailed = $false
try {
    Install-OpenSourcebook
} catch {
    $bookInstallFailed = $true
}

if ($bookInstallFailed) {
    $global:LASTEXITCODE = 1
    $bookScriptFile = $null
    try {
        $bookScriptFile = $MyInvocation.MyCommand.Path
    } catch {
        $bookScriptFile = $null
    }
    if ($bookScriptFile) {
        exit 1
    }
}
