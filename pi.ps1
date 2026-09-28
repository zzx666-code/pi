# Run pi coding agent from sources (Windows equivalent of ./pi-test.sh)
# Usage:
#   .\pi.ps1                          # interactive TUI (default model: ark/glm-5.3)
#   .\pi.ps1 -p "your question"       # non-interactive mode
#   .\pi.ps1 --list-models glm        # list models
param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$Args
)

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $repo "packages\coding-agent\src\cli.ts"
$tsx = Join-Path $repo "node_modules\.bin\tsx.cmd"

& $tsx --tsconfig (Join-Path $repo "tsconfig.json") $cli --provider zhipu --model glm-5.3 @Args
