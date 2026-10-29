# Records docs/demo.mp4 and docs/screenshots/*.png from docs/demo.tape, framed as a Windows PowerShell window.
# Needs vhs, ttyd and ffmpeg (winget install charmbracelet.vhs tsl0922.ttyd Gyan.FFmpeg). Run from the repository root.
# The tape clones the GitHub repository into %USERPROFILE%\gibreview-demo and runs npm link there.
# vhs and ffmpeg report progress on stderr, so failures are judged by exit code, not ErrorActionPreference.
New-Item -ItemType Directory -Force docs\screenshots | Out-Null
# Remove the last run's clone up front: deleting its node_modules inside the recording would show on screen.
$demo = Join-Path $env:USERPROFILE 'gibreview-demo'
if (Test-Path $demo) { Remove-Item -Recurse -Force $demo }

# A NO_COLOR inherited from the calling shell would turn the demo's colours off.
Remove-Item env:NO_COLOR -ErrorAction SilentlyContinue
vhs docs/demo.tape
if ($LASTEXITCODE) { throw 'vhs failed' }

ffmpeg -y -loglevel error -i docs\.demo-raw.mp4 -/vf docs\titlebar.ffilter -c:v libx264 -pix_fmt yuv420p -movflags +faststart docs\demo.mp4
if ($LASTEXITCODE) { throw 'ffmpeg failed' }
foreach ($raw in Get-ChildItem docs\screenshots\.raw-*.png) {
  ffmpeg -y -loglevel error -i $raw.FullName -/vf docs\titlebar.ffilter -update 1 (Join-Path $raw.DirectoryName ($raw.Name -replace '^\.raw-', ''))
  Remove-Item $raw.FullName
}
Remove-Item docs\.demo-raw.mp4
Write-Host 'Wrote docs\demo.mp4 and docs\screenshots'
