# The demo video: gibreview installed from GitHub and run as the README says, on the offline simulator.
# Record it with docs/record-demo.ps1, which runs this tape and adds the Windows title bar.

Output docs/.demo-raw.mp4

Set Shell "powershell"
Set FontFamily "Consolas"
Set FontSize 20
Set Width 1920
Set Height 1036
Set Padding 16
Set TypingSpeed 45ms
Set WaitTimeout 300s
Set Theme { "name": "Campbell", "background": "#0C0C0C", "foreground": "#CCCCCC", "cursor": "#FFFFFF", "selection": "#FFFFFF", "black": "#0C0C0C", "red": "#C50F1F", "green": "#13A10E", "yellow": "#C19C00", "blue": "#0037DA", "magenta": "#881798", "cyan": "#3A96DD", "white": "#CCCCCC", "brightBlack": "#767676", "brightRed": "#E74856", "brightGreen": "#16C60C", "brightYellow": "#F9F1A5", "brightBlue": "#3B78FF", "brightMagenta": "#B4009E", "brightCyan": "#61D6D6", "brightWhite": "#F2F2F2" }

# A plain PowerShell window in an empty folder.
Hide
Type "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $env:FORCE_COLOR = '1'; function prompt { 'PS ' + (Get-Location).Path + '> ' }"
Enter
Sleep 1s
Type "$d = Join-Path $env:USERPROFILE 'gibreview-demo'; if (Test-Path $d) { Remove-Item -Recurse -Force $d }; New-Item -ItemType Directory $d | Out-Null; Set-Location $d"
Enter
Sleep 2s
Type 'Clear-Host; Write-Host "Windows PowerShell`nCopyright (C) Microsoft Corporation. All rights reserved.`n"'
Enter
Sleep 1s
Show
Sleep 1s

# Install, exactly as the README says.
Type "git clone https://github.com/inky-penky/Gibreview_CLI.git gibreview"
Enter
Wait
Sleep 1s
Type "cd gibreview"
Enter
Wait
Type "npm install"
Enter
Wait
Sleep 2s
Type "npm link"
Enter
Wait
Sleep 2s
Type "npm test"
Enter
Wait
Sleep 3s
Screenshot docs/screenshots/.raw-1-install-and-test.png

# Try it in a minute.
Hide
Type "Clear-Host"
Enter
Sleep 1s
Show
Type "gibreview publish examples/review/content-brief.yaml --mock --confirm"
Enter
Wait
Sleep 2s
Type "gibreview collect"
Enter
Wait
Sleep 2s
Type "gibreview rank"
Enter
Wait
Sleep 4s
Screenshot docs/screenshots/.raw-2-rank.png
Type "gibreview show @copycat"
Enter
Wait
Sleep 4s

Hide
Type "Clear-Host"
Enter
Sleep 1s
Show
Type "gibreview decide"
Enter
Wait
Sleep 5s
Screenshot docs/screenshots/.raw-3-decide.png

# Carry out the plan with the code decide printed, then refund what is left.
Hide
Type "$env:NO_COLOR = '1'; $code = ((gibreview decide) -join ' ' | Select-String '--confirm (\S+)').Matches[0].Groups[1].Value; $task = ((gibreview status) -join ' ' | Select-String 'task (\S+)').Matches[0].Groups[1].Value; Remove-Item env:NO_COLOR; Clear-Host"
Enter
Sleep 4s
Show
Type "gibreview decide --apply --confirm $code"
Enter
Wait
Sleep 4s
Screenshot docs/screenshots/.raw-4-pay.png
Type "gibreview close --confirm"
Enter
Wait
Sleep 4s

# Participants: check a draft before submitting.
Hide
Type "Clear-Host"
Enter
Sleep 1s
Show
Type "Get-Content examples/review/draft-bad.txt"
Enter
Wait
Sleep 2s
Type "gibreview check $task examples/review/draft-bad.txt --mock"
Enter
Wait
Sleep 3s
Type "gibreview check $task examples/review/draft-good.txt --mock"
Enter
Wait
Sleep 4s
Screenshot docs/screenshots/.raw-5-participant-check.png

# Write a brief and the bounty text for gibwork.com.
Hide
Type "Clear-Host"
Enter
Sleep 1s
Show
Type "gibreview init brief.yaml --preset content"
Enter
Wait
Sleep 2s
Type "gibreview text brief.yaml"
Enter
Wait
Sleep 6s
Screenshot docs/screenshots/.raw-6-bounty-text.png

# An AI agent runs the same review through the MCP server.
Hide
Type "Remove-Item env:FORCE_COLOR; Clear-Host"
Enter
Sleep 1s
Show
Type "npm run demo:agent"
Enter
Wait
Sleep 6s
Screenshot docs/screenshots/.raw-7-mcp-agent.png
Sleep 2s
