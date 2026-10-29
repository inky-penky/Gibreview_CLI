# Records docs/demo.mp4 and docs/screenshots/*.png from docs/demo.tape, framed as a Windows PowerShell window.
# Needs vhs, ttyd and ffmpeg (winget install charmbracelet.vhs tsl0922.ttyd Gyan.FFmpeg). Run from the repository root.
# The tape clones the GitHub repository into %USERPROFILE%\gibreview-demo and runs npm link there.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force docs\screenshots | Out-Null

vhs docs/demo.tape
if ($LASTEXITCODE) { throw 'vhs failed' }

ffmpeg -y -loglevel error -i docs\.demo-raw.mp4 -/vf docs\titlebar.ffilter -c:v libx264 -pix_fmt yuv420p -movflags +faststart docs\demo.mp4
foreach ($raw in Get-ChildItem docs\screenshots\.raw-*.png) {
  ffmpeg -y -loglevel error -i $raw.FullName -/vf docs\titlebar.ffilter -update 1 (Join-Path $raw.DirectoryName ($raw.Name -replace '^\.raw-', ''))
  Remove-Item $raw.FullName
}
Remove-Item docs\.demo-raw.mp4
Write-Host 'Wrote docs\demo.mp4 and docs\screenshots'
