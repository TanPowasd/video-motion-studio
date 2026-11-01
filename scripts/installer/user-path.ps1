# Adds or removes one directory in the *user* PATH (HKCU\Environment), preserving the value
# type (REG_EXPAND_SZ) and unexpanded %VARS%. Used by the Vmotion NSIS installer/uninstaller
# instead of NSIS string functions, which truncate PATH values longer than NSIS_MAX_STRLEN.
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Dir
)
$ErrorActionPreference = 'Stop'
$normalize = { param([string]$value) [Environment]::ExpandEnvironmentVariables($value).Trim().TrimEnd('\').ToLowerInvariant() }
$target = & $normalize $Dir
if ($target -eq '') { throw 'Empty directory' }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $exists = $key.GetValueNames() -contains 'Path'
  $current = if ($exists) { [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { '' }
  $kind = if ($exists) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $parts = @($current -split ';' | Where-Object { $_.Trim() -ne '' -and (& $normalize $_) -ne $target })
  if ($Mode -eq 'add') { $parts += $Dir.TrimEnd('\') }
  $next = $parts -join ';'
  if ($next -ne $current) {
    if ($next -eq '') { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $next, $kind) }
  }
} finally {
  $key.Close()
}
