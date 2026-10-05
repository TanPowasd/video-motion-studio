$ErrorActionPreference = 'Stop'
$vmotionCargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (!(Test-Path -LiteralPath $vmotionCargo)) { $vmotionCargo = 'cargo' }
& $vmotionCargo build --manifest-path crates/vmotion-core/Cargo.toml --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Path dist/native -Force | Out-Null
$vmotionSha=[System.Security.Cryptography.SHA256]::Create()
try{$vmotionHash=[BitConverter]::ToString($vmotionSha.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path (Get-Location) 'crates/vmotion-core/target/release/vmotion-core.exe')))).Replace('-','').ToLower().Substring(0,16)}finally{$vmotionSha.Dispose()}
$vmotionExecutable='vmotion-core-'+$vmotionHash+'.exe'
$vmotionDestination=Join-Path 'dist/native' $vmotionExecutable
if(!(Test-Path -LiteralPath $vmotionDestination)){Copy-Item -LiteralPath crates/vmotion-core/target/release/vmotion-core.exe -Destination $vmotionDestination}
$vmotionManifest=@{executable=$vmotionExecutable;version='0.5.0'} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'dist/native/manifest.json'),$vmotionManifest,(New-Object System.Text.UTF8Encoding($false)))
