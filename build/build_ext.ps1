$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$sourceDir = Split-Path -Parent $scriptDir
if (-not $sourceDir) { $sourceDir = (Get-Item -Path ".").FullName }
$stagingDir = "$sourceDir\build\out\staging"
$outputZip = "$sourceDir\build\out\FG-Aura-Effect.zip"
$localExt = "$sourceDir\build\out\FG-Aura-Effect.ext"
$fguExtensionsDir = Join-Path $env:APPDATA "SmiteWorks\Fantasy Grounds\extensions"
$fgcExtensionsDir = Join-Path $env:APPDATA "Fantasy Grounds\extensions"

# Clean up any existing staging/outputs
if (Test-Path $stagingDir) { Remove-Item -Recurse -Force $stagingDir }
if (Test-Path $outputZip) { Remove-Item -Force $outputZip }
$null = New-Item -ItemType Directory -Path $stagingDir -ErrorAction SilentlyContinue

# Copy extension root files
Copy-Item "$sourceDir\extension.xml" -Destination "$stagingDir\"
if (Test-Path "$sourceDir\readme.txt") {
    Copy-Item "$sourceDir\readme.txt" -Destination "$stagingDir\"
}

# Copy graphics files
$null = New-Item -ItemType Directory -Path "$stagingDir\graphics\icons" -ErrorAction SilentlyContinue
Copy-Item "$sourceDir\graphics\icons\*" -Destination "$stagingDir\graphics\icons\"

# Copy scripts (only .lua files)
$null = New-Item -ItemType Directory -Path "$stagingDir\scripts" -ErrorAction SilentlyContinue
Copy-Item "$sourceDir\scripts\*.lua" -Destination "$stagingDir\scripts\"

# Copy strings
$null = New-Item -ItemType Directory -Path "$stagingDir\strings" -ErrorAction SilentlyContinue
Copy-Item "$sourceDir\strings\*.xml" -Destination "$stagingDir\strings\"

# Compress staging directory contents to zip
Write-Host "Compressing extension files..."
Compress-Archive -Path "$stagingDir\*" -DestinationPath $outputZip -Force

# Copy to build/out/FG-Aura-Effect.ext
Copy-Item $outputZip $localExt -Force

# Install to FGU extensions directory
if (Test-Path $fguExtensionsDir) {
    Write-Host "Installing FG-Aura-Effect.ext to FGU ($fguExtensionsDir)..."
    Copy-Item $localExt (Join-Path $fguExtensionsDir "FG-Aura-Effect.ext") -Force
}

# Install to FGC extensions directory
if (Test-Path $fgcExtensionsDir) {
    Write-Host "Installing FG-Aura-Effect.ext to FGC ($fgcExtensionsDir)..."
    Copy-Item $localExt (Join-Path $fgcExtensionsDir "FG-Aura-Effect.ext") -Force
}

# Clean up staging and temporary zip
Remove-Item -Recurse -Force $stagingDir
if (Test-Path $outputZip) { Remove-Item -Force $outputZip }

Write-Host "Build and Install completed successfully!"
