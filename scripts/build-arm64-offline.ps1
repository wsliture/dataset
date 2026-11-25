param(
    [string]$OutputDirectory = "release/dataset-arm64-offline",
    [string]$DownloadCacheDirectory = "release/download-cache"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
function Resolve-BuildPath([string]$Path) {
    return [IO.Path]::GetFullPath([IO.Path]::Combine($ProjectRoot, $Path))
}

$OutputPath = Resolve-BuildPath $OutputDirectory

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)." }
}

if ((Test-Path -LiteralPath $OutputPath) -or (Test-Path -LiteralPath "$OutputPath.tar.gz")) {
    throw "Output already exists. Choose a new -OutputDirectory."
}

$CachePath = Resolve-BuildPath $DownloadCacheDirectory
$ComposeAsset = Join-Path $CachePath "docker-compose-v2.39.2-linux-aarch64"
$ComposeHash = "54488FFFB60782F3C8787A48B95ED15F49F5A3A85F4105304BD46DB5EDD9DB61"
if (-not (Test-Path -LiteralPath $ComposeAsset)) {
    New-Item -ItemType Directory -Path $CachePath -Force | Out-Null
    $TemporaryAsset = "$ComposeAsset.$PID.download"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/docker/compose/releases/download/v2.39.2/docker-compose-linux-aarch64" -OutFile $TemporaryAsset
        if ((Get-FileHash -LiteralPath $TemporaryAsset).Hash -ne $ComposeHash) { throw "Compose download checksum mismatch." }
        Move-Item -LiteralPath $TemporaryAsset -Destination $ComposeAsset
    } finally {
        if (Test-Path -LiteralPath $TemporaryAsset) { Remove-Item -LiteralPath $TemporaryAsset }
    }
}
if ((Get-FileHash -LiteralPath $ComposeAsset).Hash -ne $ComposeHash) {
    throw "Cached Compose checksum mismatch. Replace the cached file: $ComposeAsset"
}

$Dockerfile = Join-Path $ProjectRoot "docker/app.Dockerfile"
$Images = @("dataset-api:arm64", "dataset-web:arm64", "dataset-postgres:arm64")
foreach ($Target in @("api", "web")) {
    Invoke-Checked docker @("buildx", "build", "--platform", "linux/arm64", "--load",
        "--target", $Target, "-t", "dataset-${Target}:arm64", "-f", $Dockerfile, $ProjectRoot)
}
$Postgres = "pgvector/pgvector:pg17@sha256:8863731f8ef4e6d1c38f279ece767fba693ae7bb3adac60492b7f390299d07f4"
Invoke-Checked docker @("pull", "--platform", "linux/arm64", $Postgres)
Invoke-Checked docker @("tag", $Postgres, $Images[2])
foreach ($Image in $Images) {
    $Platform = Invoke-Checked docker @("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", $Image)
    if ($Platform -ne "linux/arm64") { throw "Unexpected image platform for ${Image}: $Platform" }
}

New-Item -ItemType Directory -Path $OutputPath | Out-Null
$ImagesArchive = Join-Path $OutputPath "dataset-arm64-images.tar"
Invoke-Checked docker (@("image", "save", "-o", $ImagesArchive) + $Images)
Copy-Item -LiteralPath (Join-Path $ProjectRoot "docker-compose.offline-arm64.yml") -Destination $OutputPath
Copy-Item -LiteralPath (Join-Path $ProjectRoot ".env.offline.example") -Destination (Join-Path $OutputPath ".env.example")
foreach ($File in @("compose.sh", "install.sh", "logs.sh", "start.sh", "status.sh", "stop.sh", "upgrade.sh", "README-OFFLINE.md")) {
    $Content = [IO.File]::ReadAllText((Join-Path $ProjectRoot "offline/$File"))
    [IO.File]::WriteAllText((Join-Path $OutputPath $File), ($Content -replace "`r`n", "`n"))
}
New-Item -ItemType Directory -Path (Join-Path $OutputPath "bin") | Out-Null
Copy-Item -LiteralPath $ComposeAsset -Destination (Join-Path $OutputPath "bin/docker-compose")
$OutputPrefix = $OutputPath.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
$Checksums = Get-ChildItem -LiteralPath $OutputPath -File -Force -Recurse | Sort-Object FullName | ForEach-Object {
    $Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $RelativePath = $_.FullName.Substring($OutputPrefix.Length).Replace('\', '/')
    "$Hash  $RelativePath"
}
[IO.File]::WriteAllText((Join-Path $OutputPath "SHA256SUMS"), (($Checksums -join "`n") + "`n"))
Invoke-Checked tar @("-czf", "$OutputPath.tar.gz", "-C", (Split-Path $OutputPath -Parent), (Split-Path $OutputPath -Leaf))
Write-Output "$OutputPath.tar.gz"
