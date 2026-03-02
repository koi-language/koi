# Koi Language Extension Installer for Windows
# Run with: powershell -ExecutionPolicy Bypass -File install.ps1

Write-Host "🌊 Koi Language Extension Installer" -ForegroundColor Cyan
Write-Host ""

# Detect VS Code
$VSCodeExtDir = "$env:USERPROFILE\.vscode\extensions\koi-lang"
$VSCodeInstalled = Test-Path "$env:USERPROFILE\.vscode\extensions" -or (Get-Command code -ErrorAction SilentlyContinue)

# Detect Cursor
$CursorExtDir = "$env:USERPROFILE\.cursor\extensions\koi-lang"
$CursorInstalled = Test-Path "$env:USERPROFILE\.cursor\extensions"

Write-Host "Detected editors:"
if ($VSCodeInstalled) {
    Write-Host "  ✓ VS Code" -ForegroundColor Green
}
if ($CursorInstalled) {
    Write-Host "  ✓ Cursor" -ForegroundColor Green
}

if (-not $VSCodeInstalled -and -not $CursorInstalled) {
    Write-Host "  ⚠  No VS Code or Cursor installation detected" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please install VS Code or Cursor first:"
    Write-Host "  - VS Code: https://code.visualstudio.com/"
    Write-Host "  - Cursor: https://cursor.sh/"
    exit 1
}

Write-Host ""
Write-Host "Installing extension (copying files)..."
Write-Host ""

$SourceDir = Get-Location

# Install for VS Code
if ($VSCodeInstalled) {
    if (Test-Path $VSCodeExtDir) {
        Write-Host "Removing existing VS Code installation..."
        Remove-Item -Recurse -Force $VSCodeExtDir
    }

    Write-Host "Installing to VS Code..."
    New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.vscode\extensions" | Out-Null
    Copy-Item -Recurse -Force $SourceDir $VSCodeExtDir
    Write-Host "✓ Installed to VS Code" -ForegroundColor Green
}

# Install for Cursor
if ($CursorInstalled) {
    if (Test-Path $CursorExtDir) {
        Write-Host "Removing existing Cursor installation..."
        Remove-Item -Recurse -Force $CursorExtDir
    }

    Write-Host "Installing to Cursor..."
    New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.cursor\extensions" | Out-Null
    Copy-Item -Recurse -Force $SourceDir $CursorExtDir
    Write-Host "✓ Installed to Cursor" -ForegroundColor Green
}

Write-Host ""
Write-Host "✅ Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart VS Code / Cursor"
Write-Host "  2. Open any .koi file"
Write-Host "  3. (Optional) Enable 'Koi Dark' theme:"
Write-Host "     Ctrl+K Ctrl+T → Select 'Koi Dark'" -ForegroundColor Blue
Write-Host ""
