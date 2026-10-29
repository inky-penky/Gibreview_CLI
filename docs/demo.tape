# The demo video: gibreview installed from GitHub and run as the README says, on the offline simulator.
# Record it with docs/record-demo.ps1, which runs this tape and adds the Windows title bar.

Output docs/.demo-raw.mp4

Set Shell "powershell"
Set FontFamily "Consolas"
Set FontSize 20
Set Width 1920
Set Height 1036
Set Padding 16
Set TypingSpeed 140ms
# Low enough for the screen capture to keep up, so the video plays in real time.
Set Framerate 10
Set WaitTimeout 300s
Set Theme { "name": "Campbell", "background": "#0C0C0C", "foreground": "#CCCCCC", "cursor": "#FFFFFF", "selection": "#FFFFFF", "black": "#0C0C0C", "red": "#C50F1F", "green": "#13A10E", "yellow": "#C19C00", "blue": "#0037DA", "magenta": "#881798", "cyan": "#3A96DD", "white": "#CCCCCC", "brightBlack": "#767676", "brightRed": "#E74856", "brightGreen": "#16C60C", "brightYellow": "#F9F1A5", "brightBlue": "#3B78FF", "brightMagenta": "#B4009E", "brightCyan": "#61D6D6", "brightWhite": "#F2F2F2" }

# A plain PowerShell window in an empty folder.
Hide
Type@5ms "[Console]::OutputEncoding = [Text.Encoding]::UTF8; function prompt { 'PS ' + (Get-Location).Path + '> ' }"
Enter
Wait
Sleep 500ms
Type@5ms "$d = Join-Path $env:USERPROFILE 'gibreview-demo'; if (Test-Path $d) { Remove-Item -Recurse -Force $d }; New-Item -ItemType Directory $d | Out-Null; Set-Location $d"
Enter
Wait
Sleep 500ms
Type@5ms 'Clear-Host; Write-Host "Windows PowerShell`nCopyright (C) Microsoft Corporation. All rights reserved.`n"'
Enter
Wait
Sleep 500ms
Show
Sleep 1s

# Install, exactly as the README says.
Type "git clone "
Sleep 1.2s
# The URL is pasted, not typed.
Type@1ms "https://github.com/inky-penky/Gibreview_CLI.git"
Sleep 800ms
Type " gibreview"
Sleep 700ms
Enter
Wait
Sleep 1s
Type "cd gibreview"
Sleep 700ms
Enter
Wait
Type "npm install"
Sleep 700ms
Enter
Wait
Sleep 2s
Type "npm link"
Sleep 700ms
Enter
Wait
Sleep 2s
Type "npm test"
Sleep 700ms
Enter
Wait
Sleep 3s
Screenshot docs/screenshots/.raw-1-install-and-test.png
Sleep 1s

# Try it in a minute. Colours on from here: the recorder's terminal does not report itself as one.
Hide
Type@5ms "$env:FORCE_COLOR = '1'; Clear-Host"
Enter
Wait
Sleep 500ms
Show
Type "gibreview publish examples/review/content-brief.yaml --mock --confirm"
Sleep 700ms
Enter
Wait
Sleep 2s
Type "gibreview collect"
Sleep 700ms
Enter
Wait
Sleep 2s
Type "gibreview rank"
Sleep 700ms
Enter
Wait
Sleep 4s
Screenshot docs/screenshots/.raw-2-rank.png
Sleep 1s
Type "gibreview show @copycat"
Sleep 700ms
Enter
Wait
Sleep 4s

Hide
Type@5ms "Clear-Host"
Enter
Wait
Sleep 500ms
Show
Type "gibreview decide"
Sleep 700ms
Enter
Wait
Sleep 5s
Screenshot docs/screenshots/.raw-3-decide.png
Sleep 1s

# Carry out the plan with the code decide printed, then refund what is left.
Hide
Type@5ms "$env:NO_COLOR = '1'; $code = ((gibreview decide) -join ' ' | Select-String '--confirm (\S+)').Matches[0].Groups[1].Value; $task = ((gibreview status) -join ' ' | Select-String 'task (\S+)').Matches[0].Groups[1].Value; Remove-Item env:NO_COLOR; Clear-Host"
Enter
Wait
Sleep 500ms
Show
Type "gibreview decide --apply --confirm $code"
Sleep 700ms
Enter
Wait
Sleep 4s
Screenshot docs/screenshots/.raw-4-pay.png
Sleep 1s
Type "gibreview close --confirm"
Sleep 700ms
Enter
Wait
Sleep 4s

# Participants: check a draft before submitting.
Hide
Type@5ms "Clear-Host"
Enter
Wait
Sleep 500ms
Show
Type "Get-Content examples/review/draft-bad.txt"
Sleep 700ms
Enter
Wait
Sleep 2s
Type "gibreview check $task examples/review/draft-bad.txt --mock"
Sleep 700ms
Enter
Wait
Sleep 3s
Type "gibreview check $task examples/review/draft-good.txt --mock"
Sleep 700ms
Enter
Wait
Sleep 4s
Screenshot docs/screenshots/.raw-5-participant-check.png
Sleep 1s

# Write a brief and the bounty text for gibwork.com.
Hide
Type@5ms "Clear-Host"
Enter
Wait
Sleep 500ms
Show
Type "gibreview init brief.yaml --preset content"
Sleep 700ms
Enter
Wait
Sleep 2s
Type "gibreview text brief.yaml"
Sleep 700ms
Enter
Wait
Sleep 6s
Screenshot docs/screenshots/.raw-6-bounty-text.png
Sleep 1s

# An AI agent runs the same review through the MCP server.
Hide
Type@5ms "Remove-Item env:FORCE_COLOR; Clear-Host"
Enter
Wait
Sleep 500ms
Show
Type "npm run demo:agent"
Sleep 700ms
Enter
Wait
Sleep 6s
Screenshot docs/screenshots/.raw-7-mcp-agent.png
Sleep 2s
