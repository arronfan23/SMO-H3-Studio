[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SM89Zip,

  [Parameter(Mandatory = $true)]
  [string]$SM120Zip,

  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,

  [ValidateRange(1, 1900000000)]
  [long]$ChunkSize = 1900000000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$BufferSize = 4 * 1024 * 1024
$Utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)

function ConvertTo-Hex {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  return [System.BitConverter]::ToString($Bytes).Replace('-', '')
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.FileStream]::new(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read,
    $BufferSize,
    [System.IO.FileOptions]::SequentialScan
  )
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ConvertTo-Hex -Bytes $sha256.ComputeHash($stream)
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Read-ZipMetadata {
  param([Parameter(Mandatory = $true)][string]$Path)

  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    [long]$estimatedExtractedBytes = 0
    $pythonPaths = @()
    $launchScripts = @()
    $ffprobePaths = @()

    foreach ($entry in $archive.Entries) {
      $estimatedExtractedBytes += [long]$entry.Length
      $entryPath = $entry.FullName.Replace('\', '/')
      if ($entryPath.EndsWith('/python_embeded/python.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
        $pythonPaths += $entryPath
      }
      if ($entryPath.EndsWith('/tools/launch.py', [System.StringComparison]::OrdinalIgnoreCase)) {
        $launchScripts += $entryPath
      }
      if ($entryPath.EndsWith('/tools/ffmpeg/ffprobe.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
        $ffprobePaths += $entryPath
      }
    }

    if ($pythonPaths.Count -ne 1 -or $launchScripts.Count -ne 1 -or $ffprobePaths.Count -ne 1) {
      throw "Expected exactly one python, launch script, and ffprobe entry in $Path"
    }

    return [pscustomobject]@{
      EstimatedExtractedBytes = $estimatedExtractedBytes
      PythonPath = $pythonPaths[0]
      LaunchScript = $launchScripts[0]
      FfprobePath = $ffprobePaths[0]
    }
  } finally {
    $archive.Dispose()
  }
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $json = $Value | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($Path, "$json`n", $Utf8WithoutBom)
}

function Test-ExistingPack {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeId,
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$MetadataPath,
    [Parameter(Mandatory = $true)][long]$PartSize,
    [Parameter(Mandatory = $true)][object]$ZipMetadata
  )

  if (-not [System.IO.File]::Exists($MetadataPath)) {
    return $null
  }

  try {
    $metadata = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
    $archiveName = [System.IO.Path]::GetFileName($ZipPath)
    [long]$archiveLength = (Get-Item -LiteralPath $ZipPath).Length
    [long]$partCount = [Math]::Floor(($archiveLength + $PartSize - 1) / $PartSize)

    if (
      $metadata.id -ne $RuntimeId -or
      $metadata.sourceArchive -ne $archiveName -or
      [long]$metadata.chunkSize -ne $PartSize -or
      [long]$metadata.archiveSize -ne $archiveLength -or
      [long]$metadata.estimatedExtractedBytes -ne [long]$ZipMetadata.EstimatedExtractedBytes -or
      $metadata.pythonPath -ne $ZipMetadata.PythonPath -or
      $metadata.launchScript -ne $ZipMetadata.LaunchScript -or
      $metadata.ffprobePath -ne $ZipMetadata.FfprobePath -or
      $metadata.archiveParts.Count -ne $partCount
    ) {
      Write-Verbose "Existing $RuntimeId metadata does not match the requested archive or ZIP paths."
      return $null
    }

    $partPattern = '^' + [System.Text.RegularExpressions.Regex]::Escape($archiveName) + '\.part\d+$'
    $actualParts = @(Get-ChildItem -LiteralPath $OutputDirectory -File | Where-Object {
      $_.Name -match $partPattern
    })
    if ($actualParts.Count -ne $partCount) {
      Write-Verbose "Existing $RuntimeId pack has $($actualParts.Count) parts; expected $partCount."
      return $null
    }

    if ((Get-FileSha256 -Path $ZipPath) -ne $metadata.archiveSha256) {
      Write-Verbose "Existing $RuntimeId archive hash does not match its metadata."
      return $null
    }

    [long]$offset = 0
    for ($index = 0; $index -lt $partCount; $index++) {
      $part = $metadata.archiveParts[$index]
      $expectedName = "$archiveName.part$($index + 1)"
      [long]$expectedSize = [Math]::Min($PartSize, $archiveLength - $offset)
      $partPath = Join-Path $OutputDirectory $expectedName

      if (
        $part.path -ne $expectedName -or
        [long]$part.size -ne $expectedSize -or
        -not [System.IO.File]::Exists($partPath) -or
        (Get-Item -LiteralPath $partPath).Length -ne $expectedSize -or
        (Get-FileSha256 -Path $partPath) -ne $part.sha256
      ) {
        Write-Verbose "Existing $RuntimeId part failed validation: $expectedName"
        return $null
      }
      $offset += $expectedSize
    }

    return $metadata
  } catch {
    Write-Verbose "Existing $RuntimeId pack is invalid and will be regenerated: $($_.Exception.Message)"
    return $null
  }
}

function New-RuntimePack {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeId,
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$MetadataPath,
    [Parameter(Mandatory = $true)][long]$PartSize,
    [Parameter(Mandatory = $true)][object]$ZipMetadata
  )

  $archiveName = [System.IO.Path]::GetFileName($ZipPath)
  $partPattern = '^' + [System.Text.RegularExpressions.Regex]::Escape($archiveName) + '\.part\d+$'
  Get-ChildItem -LiteralPath $OutputDirectory -File | Where-Object {
    $_.Name -match $partPattern
  } | Remove-Item -Force
  if ([System.IO.File]::Exists($MetadataPath)) {
    Remove-Item -LiteralPath $MetadataPath -Force
  }

  $archiveStream = [System.IO.FileStream]::new(
    $ZipPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read,
    $BufferSize,
    [System.IO.FileOptions]::SequentialScan
  )
  $archiveHash = [System.Security.Cryptography.IncrementalHash]::CreateHash(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  $buffer = [byte[]]::new($BufferSize)
  $parts = @()

  try {
    [long]$archiveLength = $archiveStream.Length
    while ($archiveStream.Position -lt $archiveLength) {
      $partNumber = $parts.Count + 1
      $partName = "$archiveName.part$partNumber"
      $partPath = Join-Path $OutputDirectory $partName
      $partStream = [System.IO.FileStream]::new(
        $partPath,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None,
        $BufferSize,
        [System.IO.FileOptions]::SequentialScan
      )
      $partHash = [System.Security.Cryptography.IncrementalHash]::CreateHash(
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
      )

      try {
        [long]$currentPartSize = 0
        while ($currentPartSize -lt $PartSize -and $archiveStream.Position -lt $archiveLength) {
          $requested = [Math]::Min([long]$buffer.Length, $PartSize - $currentPartSize)
          $read = $archiveStream.Read($buffer, 0, [int]$requested)
          if ($read -le 0) {
            throw "Unexpected end of archive: $ZipPath"
          }

          $partStream.Write($buffer, 0, $read)
          $partHash.AppendData($buffer, 0, $read)
          $archiveHash.AppendData($buffer, 0, $read)
          $currentPartSize += $read
        }

        $parts += [pscustomobject][ordered]@{
          path = $partName
          size = $currentPartSize
          sha256 = ConvertTo-Hex -Bytes $partHash.GetHashAndReset()
        }
      } finally {
        $partHash.Dispose()
        $partStream.Dispose()
      }
    }

    $metadata = [pscustomobject][ordered]@{
      id = $RuntimeId
      sourceArchive = $archiveName
      chunkSize = $PartSize
      archiveParts = $parts
      archiveSize = $archiveLength
      archiveSha256 = ConvertTo-Hex -Bytes $archiveHash.GetHashAndReset()
      estimatedExtractedBytes = [long]$ZipMetadata.EstimatedExtractedBytes
      pythonPath = $ZipMetadata.PythonPath
      launchScript = $ZipMetadata.LaunchScript
      ffprobePath = $ZipMetadata.FfprobePath
    }
    Write-JsonFile -Path $MetadataPath -Value $metadata
    return $metadata
  } finally {
    $archiveHash.Dispose()
    $archiveStream.Dispose()
  }
}

$sm89ZipPath = (Resolve-Path -LiteralPath $SM89Zip).ProviderPath
$sm120ZipPath = (Resolve-Path -LiteralPath $SM120Zip).ProviderPath
$outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
$runtimePacksRoot = [System.IO.Path]::GetFullPath((Join-Path $outputRootPath 'runtime-packs'))
[void](New-Item -ItemType Directory -Path $runtimePacksRoot -Force)

$runtimeMetadata = [ordered]@{}
foreach ($runtime in @(
  [pscustomobject]@{ Id = 'sm89'; ZipPath = $sm89ZipPath },
  [pscustomobject]@{ Id = 'sm120'; ZipPath = $sm120ZipPath }
)) {
  $outputDirectory = [System.IO.Path]::GetFullPath((Join-Path $runtimePacksRoot $runtime.Id))
  $expectedParent = $runtimePacksRoot.TrimEnd('\') + '\'
  if (-not $outputDirectory.StartsWith($expectedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime output escapes the runtime-packs directory: $outputDirectory"
  }
  [void](New-Item -ItemType Directory -Path $outputDirectory -Force)

  $metadataPath = Join-Path $outputDirectory 'metadata.json'
  $zipMetadata = Read-ZipMetadata -Path $runtime.ZipPath
  $metadata = Test-ExistingPack `
    -RuntimeId $runtime.Id `
    -ZipPath $runtime.ZipPath `
    -OutputDirectory $outputDirectory `
    -MetadataPath $metadataPath `
    -PartSize $ChunkSize `
    -ZipMetadata $zipMetadata
  if ($null -eq $metadata) {
    $metadata = New-RuntimePack `
      -RuntimeId $runtime.Id `
      -ZipPath $runtime.ZipPath `
      -OutputDirectory $outputDirectory `
      -MetadataPath $metadataPath `
      -PartSize $ChunkSize `
      -ZipMetadata $zipMetadata
  } else {
    Write-Verbose "Validated and reused the existing $($runtime.Id) pack."
  }
  $runtimeMetadata[$runtime.Id] = $metadata
}

$aggregateMetadataPath = Join-Path $runtimePacksRoot 'metadata.json'
$aggregateMetadata = [pscustomobject][ordered]@{
  version = 1
  runtimes = [pscustomobject]$runtimeMetadata
}
Write-JsonFile -Path $aggregateMetadataPath -Value $aggregateMetadata
Write-Output $aggregateMetadataPath
