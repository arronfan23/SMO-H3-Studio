param(
  [string]$ReleaseDirectory = '',
  [string]$ShortcutDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedRelease = if ($ReleaseDirectory) {
  (Resolve-Path -LiteralPath $ReleaseDirectory).Path
} else {
  Join-Path $PSScriptRoot '..\release'
}

if (-not (Test-Path -LiteralPath $resolvedRelease -PathType Container)) {
  throw "Release directory not found: $resolvedRelease"
}

$exe = Get-ChildItem -LiteralPath $resolvedRelease -Filter 'SMO.H3-Studio-*.exe' -File |
  Where-Object { $_.BaseName -match '^SMO\.H3-Studio-\d+\.\d+\.\d+$' } |
  Sort-Object { [version]($_.BaseName -replace '^SMO\.H3-Studio-') } -Descending |
  Select-Object -First 1
if ($null -eq $exe) {
  throw "Portable executable not found in $resolvedRelease"
}
$resolvedRelease = $exe.DirectoryName

# Only fall back to the real Desktop when no target directory is given;
# automated tests always pass an explicit -ShortcutDirectory.
if ($ShortcutDirectory) {
  $resolvedShortcutDirectory = $ShortcutDirectory
  if (-not (Test-Path -LiteralPath $resolvedShortcutDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $resolvedShortcutDirectory | Out-Null
  }
} else {
  $resolvedShortcutDirectory = [Environment]::GetFolderPath('Desktop')
}

$lnkPath = Join-Path $resolvedShortcutDirectory 'SMO.H3 Studio.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $exe.FullName
$shortcut.WorkingDirectory = $resolvedRelease
$shortcut.IconLocation = "$($exe.FullName),0"
$shortcut.Save()

Write-Output $lnkPath
